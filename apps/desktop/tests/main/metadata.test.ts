// M3 单测：元数据 SQL 与老 DB.js:78-101 语义一致 + 并发限流。
// 用假 DbQueryable，不连真实 DB。

import { describe, expect, it, vi } from 'vitest';
import {
  classifyCoverageReason,
  escapeIdent,
  fetchMetadata,
  listRoutines,
  listTables,
  listViews,
  mapWithLimit,
  MAX_CONCURRENCY,
  rowsOf,
  showCreateFunction,
  showCreateProcedure,
  showCreateTable,
  showCreateView,
  SQL_ROUTINES,
  SQL_TABLES,
  SQL_VIEWS,
  type DbQueryable,
} from '../../src-main/metadata';

/** 录制 SQL 的假 DB：按 SQL 前缀路由返回行（包一层 [rows, fields] 模拟 mysql2）。 */
function fakeDb(routes: Array<{ match: (sql: string) => boolean; rows: unknown[] | Error }>): DbQueryable & {
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    query: (sql: string) => {
      seen.push(sql);
      const route = routes.find((r) => r.match(sql));
      if (!route) return Promise.reject(new Error(`unexpected sql: ${sql}`));
      if (route.rows instanceof Error) return Promise.reject(route.rows);
      return Promise.resolve([route.rows, []]);
    },
  };
}

describe('SQL 与老 DB.js 一致', () => {
  it('tables/views/routines 语句含关键谓词', () => {
    expect(SQL_TABLES).toContain("table_type='BASE TABLE'");
    expect(SQL_TABLES).toContain('table_schema=?');
    expect(SQL_VIEWS).toContain("table_type='VIEW'");
    expect(SQL_ROUTINES).toContain('information_schema.parameters');
    expect(SQL_ROUTINES).toContain('specific_schema=?');
  });

  it('listTables 取 tabName；listViews 取 viewName', async () => {
    const db = fakeDb([
      { match: (s) => s.includes("'BASE TABLE'"), rows: [{ tabName: 'users' }, { tabName: 'orders' }] },
      { match: (s) => s.includes("'VIEW'"), rows: [{ viewName: 'v_users' }] },
    ]);
    await expect(listTables(db, 'shop')).resolves.toEqual(['users', 'orders']);
    await expect(listViews(db, 'shop')).resolves.toEqual(['v_users']);
  });

  it('database 参数透传为 ?', async () => {
    const query = vi.fn(async () => [[], []]);
    await listTables({ query }, 'mydb');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('BASE TABLE'), ['mydb']);
  });

  it('listRoutines 按 type 拆分过程/函数并大写归一', async () => {
    const db = fakeDb([
      {
        match: () => true,
        rows: [
          { parName: 'p_sync', type: 'PROCEDURE' },
          { parName: 'f_total', type: 'function' },
          { parName: '', type: 'PROCEDURE' },
        ],
      },
    ]);
    await expect(listRoutines(db, 'shop')).resolves.toEqual([
      { name: 'p_sync', kind: 'PROCEDURE' },
      { name: 'f_total', kind: 'FUNCTION' },
    ]);
  });

  it('showCreate* 取对应 Create 列；缺行/缺列返回 null', async () => {
    const db = fakeDb([
      { match: (s) => s.includes('TABLE'), rows: [{ 'Create Table': 'CREATE TABLE `t` (..)' }] },
      { match: (s) => s.includes('PROCEDURE'), rows: [{ 'Create Procedure': 'CREATE PROCEDURE p ..' }] },
      { match: (s) => s.includes('FUNCTION'), rows: [{ 'Create Function': 'CREATE FUNCTION f ..' }] },
      { match: (s) => s.includes('VIEW'), rows: [] },
    ]);
    await expect(showCreateTable(db, 't')).resolves.toBe('CREATE TABLE `t` (..)');
    await expect(showCreateProcedure(db, 'p')).resolves.toBe('CREATE PROCEDURE p ..');
    await expect(showCreateFunction(db, 'f')).resolves.toBe('CREATE FUNCTION f ..');
    await expect(showCreateView(db, 'v')).resolves.toBeNull();
  });

  it('escapeIdent 转义反引号防注入', () => {
    expect(escapeIdent('we`ird')).toBe('`we``ird`');
    expect(escapeIdent('users')).toBe('`users`');
  });

  it('rowsOf 兼容元组与直返两种形状', () => {
    expect(rowsOf([[{ a: 1 }], []])).toEqual([{ a: 1 }]);
    expect(rowsOf([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(rowsOf(null)).toEqual([]);
  });
});

describe('mapWithLimit 并发限流', () => {
  it('默认上限为 10（design.md 约定）', () => {
    expect(MAX_CONCURRENCY).toBe(10);
  });

  it('保序且最大并发不超过 limit', async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    let active = 0;
    let peak = 0;
    const out = await mapWithLimit(items, 10, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2));
    expect(peak).toBeLessThanOrEqual(10);
    expect(peak).toBeGreaterThan(1); // 确实并发了，不是串行
  });

  it('limit 非法时回落串行且保序', async () => {
    const order: number[] = [];
    const out = await mapWithLimit([1, 2, 3], 0, async (n) => {
      order.push(n);
      return n;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('fn 抛错时整体 reject', async () => {
    await expect(
      mapWithLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('fetchMetadata', () => {
  function shopDb(): DbQueryable {
    return fakeDb([
      { match: (s) => s.includes("'BASE TABLE'"), rows: [{ tabName: 'users' }, { tabName: 'orders' }] },
      { match: (s) => s.includes("'VIEW'"), rows: [{ viewName: 'v_users' }] },
      {
        match: (s) => s.includes('parameters'),
        rows: [
          { parName: 'p_sync', type: 'PROCEDURE' },
          { parName: 'f_total', type: 'FUNCTION' },
        ],
      },
      { match: (s) => s.toLowerCase().startsWith('show create table'), rows: [{ 'Create Table': 'CREATE TABLE X' }] },
      { match: (s) => s.toLowerCase().startsWith('show create view'), rows: [{ 'Create View': 'CREATE VIEW V' }] },
      { match: (s) => s.toLowerCase().startsWith('show create procedure'), rows: [{ 'Create Procedure': 'CREATE PROC P' }] },
      { match: (s) => s.toLowerCase().startsWith('show create function'), rows: new Error('access denied') },
    ]);
  }

  it('四类对象全拉；单对象失败记 null 不中断并写入 skipped', async () => {
    const { meta, skipped } = await fetchMetadata(shopDb(), 'shop');
    expect(meta.tables).toEqual({ users: 'CREATE TABLE X', orders: 'CREATE TABLE X' });
    expect(meta.views).toEqual({ v_users: 'CREATE VIEW V' });
    expect(meta.procedures).toEqual({ p_sync: 'CREATE PROC P' });
    expect(meta.functions).toEqual({ f_total: null });
    expect(skipped).toEqual([{ name: 'f_total', objectType: 'function', reason: 'unknown' }]);
  });

  it('tableFilter 只过滤表（子串、大小写不敏感）', async () => {
    const { meta } = await fetchMetadata(shopDb(), 'shop', { tableFilter: 'USER' });
    expect(Object.keys(meta.tables)).toEqual(['users']);
    expect(Object.keys(meta.views)).toEqual(['v_users']);
  });

  it('showCreate 零行/缺列（无错误）记 object-missing', async () => {
    const db = fakeDb([
      { match: (s) => s.includes("'BASE TABLE'"), rows: [{ tabName: 'users' }, { tabName: 'orders' }] },
      { match: (s) => s.includes("'VIEW'"), rows: [] },
      { match: (s) => s.includes('parameters'), rows: [] },
      // orders：零行；users：有行但缺列 —— 都归 object-missing。
      { match: (s) => s.includes('`users`'), rows: [{}] },
      { match: (s) => s.includes('`orders`'), rows: [] },
    ]);
    const { meta, skipped } = await fetchMetadata(db, 'shop');
    expect(meta.tables).toEqual({ users: null, orders: null });
    expect(skipped).toEqual([
      { name: 'users', objectType: 'table', reason: 'object-missing' },
      { name: 'orders', objectType: 'table', reason: 'object-missing' },
    ]);
  });

  it('权限类错误记 permission-denied（errno 与 mysql2 code 双路）', async () => {
    const db = fakeDb([
      { match: (s) => s.includes("'BASE TABLE'"), rows: [{ tabName: 'users' }, { tabName: 'orders' }] },
      { match: (s) => s.includes("'VIEW'"), rows: [] },
      { match: (s) => s.includes('parameters'), rows: [] },
      {
        match: (s) => s.includes('`users`'),
        rows: Object.assign(new Error('SELECT command denied'), { errno: 1142 }),
      },
      {
        match: (s) => s.includes('`orders`'),
        rows: Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' }),
      },
    ]);
    const { skipped } = await fetchMetadata(db, 'shop');
    expect(skipped).toEqual([
      { name: 'users', objectType: 'table', reason: 'permission-denied' },
      { name: 'orders', objectType: 'table', reason: 'permission-denied' },
    ]);
  });

  it('全部成功时 skipped 为空（界面静默的前提）', async () => {
    const allOk = fakeDb([
      { match: (s) => s.includes("'BASE TABLE'"), rows: [{ tabName: 'users' }] },
      { match: (s) => s.includes("'VIEW'"), rows: [{ viewName: 'v_users' }] },
      {
        match: (s) => s.includes('parameters'),
        rows: [{ parName: 'p_sync', type: 'PROCEDURE' }, { parName: 'f_total', type: 'FUNCTION' }],
      },
      { match: (s) => s.toLowerCase().startsWith('show create table'), rows: [{ 'Create Table': 'CREATE TABLE X' }] },
      { match: (s) => s.toLowerCase().startsWith('show create view'), rows: [{ 'Create View': 'CREATE VIEW V' }] },
      { match: (s) => s.toLowerCase().startsWith('show create procedure'), rows: [{ 'Create Procedure': 'CREATE PROC P' }] },
      { match: (s) => s.toLowerCase().startsWith('show create function'), rows: [{ 'Create Function': 'CREATE FUNC F' }] },
    ]);
    const { skipped, meta } = await fetchMetadata(allOk, 'shop');
    expect(skipped).toEqual([]);
    expect(Object.keys(meta.functions)).toEqual(['f_total']);
  });
});

describe('classifyCoverageReason', () => {
  it('无值的 reject 不冒充 object-missing（collect 另行直记）', () => {
    // object-missing 由 collect 在"查询成功但结果为 null"时直记，不经此函数。
    // 若这里用 undefined 同时表示"无错误"，Promise.reject(undefined) 会被误判。
    expect(classifyCoverageReason(undefined)).toBe('unknown');
  });

  it('用户取消 → aborted（对齐 data-run.isAbortErr）', () => {
    expect(classifyCoverageReason(Object.assign(new Error('cancel'), { code: 'ABORTED' }))).toBe('aborted');
    const abortErr = new Error('cancel');
    abortErr.name = 'AbortError';
    expect(classifyCoverageReason(abortErr)).toBe('aborted');
  });

  it('MySQL 权限类 errno / mysql2 code → permission-denied', () => {
    for (const errno of [1044, 1142, 1143, 1227, 1370]) {
      expect(classifyCoverageReason(Object.assign(new Error('x'), { errno }))).toBe('permission-denied');
    }
    expect(
      classifyCoverageReason(Object.assign(new Error('x'), { code: 'ER_PROCACCESS_DENIED_ERROR' })),
    ).toBe('permission-denied');
  });

  it('对象已被删除 → object-missing', () => {
    expect(classifyCoverageReason(Object.assign(new Error('gone'), { errno: 1146 }))).toBe('object-missing');
    expect(classifyCoverageReason(Object.assign(new Error('gone'), { code: 'ER_NO_SUCH_TABLE' }))).toBe(
      'object-missing',
    );
  });

  it('未识别形态降级 unknown（不误判、不透传 errno）', () => {
    expect(classifyCoverageReason(new Error('socket hang up'))).toBe('unknown');
    expect(classifyCoverageReason(Object.assign(new Error('x'), { errno: 2013 }))).toBe('unknown');
    expect(classifyCoverageReason('ECONNRESET')).toBe('unknown');
    expect(classifyCoverageReason(null)).toBe('unknown');
  });
});
