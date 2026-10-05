// runDataCompare 应用服务集成测试（cleanup / cancel / partial failure 不变式）。
//
// mock 边界（design.md）：store-json.loadNodes / connection.createMysqlPool /
// metadata.showCreateTable / data-fetch.fetchAllByPK+getRowCount —— 被测编排逻辑全真。
// 无真实 SQL、无网络、无磁盘写入（store-json 已 mock，不落盘）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import type { DataTablePair, NodeMeta } from '../../src-core/types';
import { createMysqlPool } from '../../src-main/connection';
import { DataThresholdError, fetchAllByPK, getRowCount } from '../../src-main/data-fetch';
import { showCreateTable, type DbQueryable } from '../../src-main/metadata';
import { loadNodes } from '../../src-main/store-json';
import { runDataCompare } from '../../src-main/data-run';
import type { Vault } from '../../src-main/vault';

vi.mock('../../src-main/store-json', () => ({ loadNodes: vi.fn() }));
vi.mock('../../src-main/connection', () => ({ createMysqlPool: vi.fn() }));
vi.mock('../../src-main/metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src-main/metadata')>();
  return { ...actual, showCreateTable: vi.fn() };
});
vi.mock('../../src-main/data-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src-main/data-fetch')>();
  return { ...actual, fetchAllByPK: vi.fn(), getRowCount: vi.fn() };
});

const DDL_PK = [
  'CREATE TABLE `t` (',
  '  `id` int NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_NO_KEYS = [
  'CREATE TABLE `logs` (',
  '  `id` int DEFAULT NULL,',
  '  `msg` varchar(64) DEFAULT NULL',
  ') ENGINE=InnoDB',
].join('\n');

function node(id: string, alias: string, database: string): NodeMeta {
  return {
    id,
    alias,
    host: '127.0.0.1',
    port: 3306,
    user: 'u',
    database,
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
    createdAt: new Date(0).toISOString(),
  };
}

function fakePool() {
  return {
    end: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([[]]),
  };
}

function asDb(pool: ReturnType<typeof fakePool>): DbQueryable {
  return pool as unknown as DbQueryable;
}

const vault = { getNodeSecret: () => ({ password: 'pw' }) } as unknown as Vault;
const ctx = { userDataDir: '/tmp/sqldiff-data-run-integration', vault };

function mockPools(): { poolA: ReturnType<typeof fakePool>; poolB: ReturnType<typeof fakePool> } {
  const poolA = fakePool();
  const poolB = fakePool();
  vi.mocked(createMysqlPool)
    .mockResolvedValueOnce(poolA as unknown as Pool)
    .mockResolvedValueOnce(poolB as unknown as Pool);
  return { poolA, poolB };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadNodes).mockReturnValue([node('a', 'A库', 'dbA'), node('b', 'B库', 'dbB')]);
});

describe('runDataCompare 集成', () => {
  it('多表部分失败：done/confirm-needed/error 状态齐全，items 只含成功表，池关闭', async () => {
    const { poolA, poolB } = mockPools();
    const pairs: DataTablePair[] = [
      { a: 'users', b: 'users' },
      { a: 'big_orders', b: 'big_orders' },
      { a: 'broken', b: 'broken' },
    ];
    const ddlCacheA = { users: DDL_PK, big_orders: DDL_PK, broken: DDL_PK };
    const ddlCacheB = { ...ddlCacheA };

    vi.mocked(fetchAllByPK).mockImplementation(async (db, table) => {
      if (table === 'users') return db === asDb(poolA) ? [{ id: 1, name: 'alice' }] : [];
      if (table === 'big_orders') throw new DataThresholdError(table, 200_000, 100_000);
      if (table === 'broken') throw new Error('SELECT failed: connection lost');
      return [];
    });

    const res = await runDataCompare('a', 'b', pairs, { ctx, ddlCacheA, ddlCacheB });

    expect(res.tables.map((t) => t.status)).toEqual(['done', 'confirm-needed', 'error']);
    expect(res.tables[0]).toMatchObject({
      a: 'users',
      b: 'users',
      status: 'done',
      insertCount: 1,
    });
    expect(res.tables[1]).toMatchObject({
      a: 'big_orders',
      b: 'big_orders',
      status: 'confirm-needed',
      reason: 'over-threshold',
    });
    expect(res.tables[2]).toMatchObject({
      a: 'broken',
      b: 'broken',
      status: 'error',
      reason: 'fetch-failed',
    });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ objectType: 'data', objectName: 'users', dml: 'INSERT' });
    expect(res.stats).toEqual({ INSERT: 1, DELETE: 0, UPDATE: 0 });
    expect(poolA.end).toHaveBeenCalled();
    expect(poolB.end).toHaveBeenCalled();
  });

  it('无行身份表：skipped+no-pk+行数，不中断且 items 为空', async () => {
    const { poolA, poolB } = mockPools();
    const pairs: DataTablePair[] = [{ a: 'logs', b: 'logs' }];
    vi.mocked(showCreateTable).mockResolvedValue(DDL_NO_KEYS);
    vi.mocked(getRowCount).mockResolvedValue(100);

    const res = await runDataCompare('a', 'b', pairs, { ctx });

    expect(res.tables).toHaveLength(1);
    expect(res.tables[0]).toMatchObject({
      a: 'logs',
      b: 'logs',
      status: 'skipped',
      reason: 'no-pk',
      countA: 100,
      countB: 100,
    });
    expect(res.items).toEqual([]);
    expect(res.stats).toEqual({ INSERT: 0, DELETE: 0, UPDATE: 0 });
    expect(fetchAllByPK).not.toHaveBeenCalled();
    expect(poolA.end).toHaveBeenCalled();
    expect(poolB.end).toHaveBeenCalled();
  });

  it('AbortSignal 取消：整体抛出 ABORTED（非逐表 error），池关闭', async () => {
    const { poolA, poolB } = mockPools();
    const pairs: DataTablePair[] = [{ a: 'users', b: 'users' }];
    const controller = new AbortController();
    controller.abort();

    vi.mocked(fetchAllByPK).mockImplementation(async () => {
      const err = new Error('表 users 数据拉取已取消');
      (err as Error & { code?: string }).code = 'ABORTED';
      throw err;
    });

    await expect(
      runDataCompare('a', 'b', pairs, {
        ctx,
        ddlCacheA: { users: DDL_PK },
        ddlCacheB: { users: DDL_PK },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(poolA.end).toHaveBeenCalled();
    expect(poolB.end).toHaveBeenCalled();
  });

  it('cleanup：表1 拉取失败后表2 正常，结果正常返回且池关闭', async () => {
    const { poolA, poolB } = mockPools();
    const pairs: DataTablePair[] = [
      { a: 'broken', b: 'broken' },
      { a: 'users', b: 'users' },
    ];
    const ddlCacheA = { broken: DDL_PK, users: DDL_PK };
    const ddlCacheB = { ...ddlCacheA };

    vi.mocked(fetchAllByPK).mockImplementation(async (db, table) => {
      if (table === 'broken') throw new Error('SELECT failed');
      if (table === 'users') return db === asDb(poolA) ? [{ id: 1, name: 'alice' }] : [];
      return [];
    });

    const res = await runDataCompare('a', 'b', pairs, { ctx, ddlCacheA, ddlCacheB });
    expect(res.tables.map((t) => t.status)).toEqual(['error', 'done']);
    expect(res.items.map((i) => i.objectName)).toEqual(['users']);
    expect(res.stats).toEqual({ INSERT: 1, DELETE: 0, UPDATE: 0 });
    expect(poolA.end).toHaveBeenCalled();
    expect(poolB.end).toHaveBeenCalled();
  });

  it('空 pairs：返回空结果且不建池', async () => {
    const res = await runDataCompare('a', 'b', [], { ctx });
    expect(res).toEqual({ items: [], tables: [], stats: { INSERT: 0, DELETE: 0, UPDATE: 0 } });
    expect(createMysqlPool).not.toHaveBeenCalled();
    expect(loadNodes).not.toHaveBeenCalled();
  });
});