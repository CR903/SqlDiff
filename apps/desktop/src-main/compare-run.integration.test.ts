// runCompareRequest 应用服务集成测试（cleanup / cancel / 结构+数据混合输出 / manifest 衔接）。
//
// mock 边界（design.md）：store-json.loadNodes+appendHistory / connection.createMysqlPool /
// metadata.fetchMetadata+showCreateTable / data-fetch.fetchAllByPK+getRowCount / grants.assessVisibility。
// 被测编排逻辑（runCompareRequest + 内部 runDataCompare）全真；无真实 SQL、无磁盘写入。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { buildManifest, deriveCoverageStatus, serializeManifest } from '../src-core/manifest';
import type { CompareRequest, CoverageSkip, NodeMeta, VisibilityAssessment } from '../src-core/types';
import { REVIEW_MANIFEST_VERSION } from '../src-core/types';
import { runCompareRequest } from './compare-run';
import { createMysqlPool } from './connection';
import { DataThresholdError, fetchAllByPK } from './data-fetch';
import { assessVisibility } from './grants';
import {
  fetchMetadata,
  type DatabaseMetadata,
  type DbQueryable,
  type MetadataSnapshot,
} from './metadata';
import { appendHistory, loadNodes } from './store-json';
import type { Vault } from './vault';

vi.mock('./store-json', () => ({ loadNodes: vi.fn(), appendHistory: vi.fn() }));
vi.mock('./connection', () => ({ createMysqlPool: vi.fn() }));
vi.mock('./metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./metadata')>();
  return { ...actual, fetchMetadata: vi.fn(), showCreateTable: vi.fn() };
});
vi.mock('./data-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./data-fetch')>();
  return { ...actual, fetchAllByPK: vi.fn(), getRowCount: vi.fn() };
});
vi.mock('./grants', () => ({ assessVisibility: vi.fn() }));

const DDL_PK = [
  'CREATE TABLE `t` (',
  '  `id` int NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB',
].join('\n');

const DDL_VIEW_A = 'CREATE VIEW `v_report` AS SELECT `id`, `a` FROM `t`';
const DDL_VIEW_B = 'CREATE VIEW `v_report` AS SELECT `id` FROM `t`';

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

function snapshot(partial: Partial<DatabaseMetadata>, skipped: CoverageSkip[] = []): MetadataSnapshot {
  return {
    meta: {
      tables: partial.tables ?? {},
      views: partial.views ?? {},
      procedures: partial.procedures ?? {},
      functions: partial.functions ?? {},
    },
    skipped,
  };
}

function asDb(pool: ReturnType<typeof fakePool>): DbQueryable {
  return pool as unknown as DbQueryable;
}

const vault = { getNodeSecret: () => ({ password: 'pw' }) } as unknown as Vault;
const ctx = { userDataDir: '/tmp/sqldiff-compare-run-integration', vault };
const FULL_VIS: VisibilityAssessment = { byDatabase: { dbA: 'full', dbB: 'full' }, reliable: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadNodes).mockReturnValue([node('a', 'A库', 'dbA'), node('b', 'B库', 'dbB')]);
  vi.mocked(appendHistory).mockReturnValue([]);
  vi.mocked(assessVisibility).mockResolvedValue(FULL_VIS);
});

describe('runCompareRequest 集成', () => {
  it('元数据拉取失败：整体 reject，两个池 end() 均被调用', async () => {
    const poolA = fakePool();
    const poolB = fakePool();
    vi.mocked(createMysqlPool)
      .mockResolvedValueOnce(poolA as unknown as Pool)
      .mockResolvedValueOnce(poolB as unknown as Pool);
    vi.mocked(fetchMetadata).mockRejectedValue(new Error('connect ECONNREFUSED'));

    const req: CompareRequest = { aId: 'a', bId: 'b', scopes: ['table', 'view', 'procedure', 'function'] };
    await expect(runCompareRequest(req, ctx)).rejects.toThrow('connect ECONNREFUSED');
    expect(poolA.end).toHaveBeenCalled();
    expect(poolB.end).toHaveBeenCalled();
  });

  it('data 阶段取消：整体 reject（ABORTED），池关闭', async () => {
    const poolA1 = fakePool();
    const poolB1 = fakePool();
    const poolA2 = fakePool();
    const poolB2 = fakePool();
    vi.mocked(createMysqlPool)
      .mockResolvedValueOnce(poolA1 as unknown as Pool)
      .mockResolvedValueOnce(poolB1 as unknown as Pool)
      .mockResolvedValueOnce(poolA2 as unknown as Pool)
      .mockResolvedValueOnce(poolB2 as unknown as Pool);

    const snapA = snapshot({ tables: { users: DDL_PK } });
    const snapB = snapshot({ tables: { users: DDL_PK } });
    vi.mocked(fetchMetadata).mockResolvedValueOnce(snapA).mockResolvedValueOnce(snapB);

    const controller = new AbortController();
    controller.abort();
    vi.mocked(fetchAllByPK).mockImplementation(async () => {
      const err = new Error('表 users 数据拉取已取消');
      (err as Error & { code?: string }).code = 'ABORTED';
      throw err;
    });

    const req: CompareRequest = {
      aId: 'a',
      bId: 'b',
      scopes: ['table', 'view', 'procedure', 'function', 'data'],
    };
    await expect(runCompareRequest(req, ctx, { signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(poolA1.end).toHaveBeenCalled();
    expect(poolB1.end).toHaveBeenCalled();
    expect(poolA2.end).toHaveBeenCalled();
    expect(poolB2.end).toHaveBeenCalled();
  });

  it('结构+数据混合：source real、coverage/visibility/dataTables 齐全、items 合并、stats 正确', async () => {
    const poolA1 = fakePool();
    const poolB1 = fakePool();
    const poolA2 = fakePool();
    const poolB2 = fakePool();
    vi.mocked(createMysqlPool)
      .mockResolvedValueOnce(poolA1 as unknown as Pool)
      .mockResolvedValueOnce(poolB1 as unknown as Pool)
      .mockResolvedValueOnce(poolA2 as unknown as Pool)
      .mockResolvedValueOnce(poolB2 as unknown as Pool);

    const snapA = snapshot({
      tables: { users: DDL_PK, big_orders: DDL_PK, broken: DDL_PK },
      views: { v_report: DDL_VIEW_A },
    });
    const snapB = snapshot({
      tables: { users: DDL_PK, big_orders: DDL_PK, broken: DDL_PK },
      views: { v_report: DDL_VIEW_B },
    });
    vi.mocked(fetchMetadata).mockResolvedValueOnce(snapA).mockResolvedValueOnce(snapB);

    vi.mocked(fetchAllByPK).mockImplementation(async (db, table) => {
      if (table === 'users') return db === asDb(poolA2) ? [{ id: 1, name: 'alice' }] : [];
      if (table === 'big_orders') throw new DataThresholdError(table, 200_000, 100_000);
      if (table === 'broken') throw new Error('SELECT failed: connection lost');
      return [];
    });

    const req: CompareRequest = {
      aId: 'a',
      bId: 'b',
      scopes: ['table', 'view', 'procedure', 'function', 'data'],
    };
    const res = await runCompareRequest(req, ctx);

    expect(res.source).toBe('real');
    expect(res.coverage).toBeDefined();
    expect(res.coverage?.ok.table).toBe(6); // A 3 表 + B 3 表
    expect(res.coverage?.ok.view).toBe(2);
    expect(res.coverage?.skipped).toEqual([]);
    expect(res.visibility?.excluded).toEqual([]);
    expect(res.visibility?.compared).toBe(4); // 3 表 + 1 视图
    expect(res.visibility?.reliable).toBe(true);

    // resolveDataPairs 同名交集排序：big_orders / broken / users。
    expect(res.dataTables?.map((t) => t.status)).toEqual(['confirm-needed', 'error', 'done']);
    expect(res.dataTables?.[0]).toMatchObject({
      a: 'big_orders',
      b: 'big_orders',
      status: 'confirm-needed',
      reason: 'over-threshold',
    });
    expect(res.dataTables?.[1]).toMatchObject({
      a: 'broken',
      b: 'broken',
      status: 'error',
      reason: 'fetch-failed',
    });
    expect(res.dataTables?.[2]).toMatchObject({
      a: 'users',
      b: 'users',
      status: 'done',
      insertCount: 1,
    });

    expect(
      res.items.some((i) => i.objectType === 'view' && i.objectName === 'v_report' && i.changeType === 'CHANGE'),
    ).toBe(true);
    expect(
      res.items.some((i) => i.objectType === 'data' && i.objectName === 'users' && i.dml === 'INSERT'),
    ).toBe(true);
    expect(res.stats.ALL).toBe(2);
    expect(res.stats.CREATE).toBe(1);
    expect(res.stats.CHANGE).toBe(1);
    expect(res.stats.DROP).toBe(0);
    expect(res.stats.INDEX).toBe(0);
    expect(res.stats.DML).toEqual({ INSERT: 1, DELETE: 0, UPDATE: 0 });

    expect(poolA1.end).toHaveBeenCalled();
    expect(poolB1.end).toHaveBeenCalled();
    expect(poolA2.end).toHaveBeenCalled();
    expect(poolB2.end).toHaveBeenCalled();
  });

  it('仅结构 scope：dataTables 为 undefined，source real，coverage/visibility 存在', async () => {
    const poolA = fakePool();
    const poolB = fakePool();
    vi.mocked(createMysqlPool)
      .mockResolvedValueOnce(poolA as unknown as Pool)
      .mockResolvedValueOnce(poolB as unknown as Pool);

    const snapA = snapshot({ tables: { users: DDL_PK } });
    const snapB = snapshot({ tables: { users: DDL_PK } });
    vi.mocked(fetchMetadata).mockResolvedValueOnce(snapA).mockResolvedValueOnce(snapB);

    const req: CompareRequest = { aId: 'a', bId: 'b', scopes: ['table', 'view', 'procedure', 'function'] };
    const res = await runCompareRequest(req, ctx);

    expect(res.source).toBe('real');
    expect(res.dataTables).toBeUndefined();
    expect(res.coverage).toBeDefined();
    expect(res.visibility).toBeDefined();
    expect(res.items).toEqual([]);
    expect(res.stats.ALL).toBe(0);
    expect(poolA.end).toHaveBeenCalled();
    expect(poolB.end).toHaveBeenCalled();
  });

  it('全链路输出可喂 buildManifest（AC5）', async () => {
    const poolA1 = fakePool();
    const poolB1 = fakePool();
    const poolA2 = fakePool();
    const poolB2 = fakePool();
    vi.mocked(createMysqlPool)
      .mockResolvedValueOnce(poolA1 as unknown as Pool)
      .mockResolvedValueOnce(poolB1 as unknown as Pool)
      .mockResolvedValueOnce(poolA2 as unknown as Pool)
      .mockResolvedValueOnce(poolB2 as unknown as Pool);

    const snapA = snapshot({
      tables: { users: DDL_PK, big_orders: DDL_PK, broken: DDL_PK },
      views: { v_report: DDL_VIEW_A },
    });
    const snapB = snapshot({
      tables: { users: DDL_PK, big_orders: DDL_PK, broken: DDL_PK },
      views: { v_report: DDL_VIEW_B },
    });
    vi.mocked(fetchMetadata).mockResolvedValueOnce(snapA).mockResolvedValueOnce(snapB);

    vi.mocked(fetchAllByPK).mockImplementation(async (db, table) => {
      if (table === 'users') return db === asDb(poolA2) ? [{ id: 1, name: 'alice' }] : [];
      if (table === 'big_orders') throw new DataThresholdError(table, 200_000, 100_000);
      if (table === 'broken') throw new Error('SELECT failed: connection lost');
      return [];
    });

    const req: CompareRequest = {
      aId: 'a',
      bId: 'b',
      scopes: ['table', 'view', 'procedure', 'function', 'data'],
    };
    const res = await runCompareRequest(req, ctx);

    const m = buildManifest({ result: res, request: req, aAlias: 'A库', bAlias: 'B库', appVersion: '0.1.0' });
    expect(m.schemaVersion).toBe(REVIEW_MANIFEST_VERSION);
    expect(m.source).toBe('real');
    expect(m.coverageStatus).toEqual(deriveCoverageStatus(res));
    expect(m.coverageStatus.kind).toBe('over-threshold');

    const json = serializeManifest(m);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toContain('password');
    expect(json).not.toContain('sshPassword');
    expect(json).not.toContain('privateKey');
    // 数据行值已脱敏。
    expect(json).not.toContain('alice');
  });
});