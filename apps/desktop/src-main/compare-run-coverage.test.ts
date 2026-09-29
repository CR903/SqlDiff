// 覆盖合并 + 来源标注单测（不需要真实连接）：
// - mergeCoverage 的 A/B 合并、scopes 裁剪口径
// - demo 标注 source='demo'
// - AC6：部分对象 SHOW CREATE 失败时 compareRun 不产生 CREATE/DROP 假象

import { describe, expect, it } from 'vitest';
import { compareRun } from '../src-core/compare';
import type { CoverageSkip, CompareResult } from '../src-core/types';
import { runDemoCompare } from '../src-renderer/demo';
import type { DatabaseMetadata, MetadataSnapshot } from './metadata';
import { mergeCoverage } from './compare-run';

function snap(partial: Partial<DatabaseMetadata>, skipped: CoverageSkip[] = []): MetadataSnapshot {
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

const ALL = ['table', 'view', 'procedure', 'function'] as const;

describe('mergeCoverage', () => {
  it('ok 按类型累加 A/B 两侧成功数', () => {
    const a = snap({ tables: { users: 'C', orders: 'C' }, views: { v1: 'C' } });
    const b = snap({ tables: { users: 'C', logs: 'C' }, functions: { f1: 'C' } });
    const cov = mergeCoverage(a, b, [...ALL]);
    // A 侧 2 表 1 视图 + B 侧 2 表 1 函数 = table 4 / view 1 / function 1。
    expect(cov.ok).toEqual({ table: 4, view: 1, procedure: 0, function: 1 });
    expect(cov.skipped).toEqual([]);
  });

  it('skipped 合并两侧；同名对象各记一条（保守，不标库侧）', () => {
    const a = snap({}, [{ name: 'secret', objectType: 'table', reason: 'permission-denied' }]);
    const b = snap({}, [{ name: 'secret', objectType: 'table', reason: 'permission-denied' }]);
    expect(mergeCoverage(a, b, [...ALL]).skipped).toHaveLength(2);
  });

  it('scopes 外的类别不计入 ok 也不出现在 skipped（与 filterMetadataByScopes 同口径）', () => {
    const a = snap(
      { tables: { users: 'C' }, views: { v1: 'C' } },
      [{ name: 'v1', objectType: 'view', reason: 'unknown' }],
    );
    const cov = mergeCoverage(a, a, ['table']);
    expect(cov.ok).toEqual({ table: 2, view: 0, procedure: 0, function: 0 });
    expect(cov.skipped).toEqual([]);
  });

  it('null 值计为未取到（不计入 ok）', () => {
    const cov = mergeCoverage(snap({ tables: { users: null } }), snap({ tables: {} }), ['table']);
    expect(cov.ok.table).toBe(0);
  });
});

describe('来源标注', () => {
  it('demo 结果标 source=demo 且不产出 coverage / visibility', () => {
    const demo: CompareResult = runDemoCompare(['table', 'view', 'procedure', 'function']);
    expect(demo.source).toBe('demo');
    expect(demo.coverage).toBeUndefined();
    expect(demo.visibility).toBeUndefined();
  });

  it('core 内 compareRun 缺省 source / coverage / visibility（由边界层标注，缺省即 real）', () => {
    const base = compareRun({ tables: {}, views: {}, procedures: {}, functions: {} }, { tables: {}, views: {}, procedures: {}, functions: {} });
    expect(base.source).toBeUndefined();
    expect(base.coverage).toBeUndefined();
    expect(base.visibility).toBeUndefined();
  });
});

describe('AC6：null 跳过不变量', () => {
  const denied = (name: string): CoverageSkip => ({ name, objectType: 'table', reason: 'permission-denied' });

  it('两侧都 null 的对象不产生 CREATE/DROP 假象，但被覆盖报告记为未检查', () => {
    const a = snap({ tables: { users: null, orders: null } }, [denied('users'), denied('orders')]);
    const b = snap({ tables: { users: null, orders: null } }, [denied('users'), denied('orders')]);
    const res = compareRun(a.meta, b.meta);
    expect(res.items).toEqual([]);
    expect(res.stats.ALL).toBe(0);
    // 权限盲区不再等同于"无差异"：明细列出四次（A/B 各两条）。
    expect(mergeCoverage(a, b, ['table']).skipped).toEqual([
      denied('users'),
      denied('orders'),
      denied('users'),
      denied('orders'),
    ]);
  });

  it('单侧 null 时该对象整体跳过，不产出半边 CREATE/DROP', () => {
    const a = snap({ tables: { users: null } }, [denied('users')]);
    const b = snap({ tables: { users: 'CREATE TABLE `users` (`id` int NOT NULL)' } });
    const res = compareRun(a.meta, b.meta);
    expect(res.items).toEqual([]);
    const cov = mergeCoverage(a, b, ['table']);
    expect(cov.ok.table).toBe(1);
    expect(cov.skipped).toEqual([denied('users')]);
  });

  it('B 侧 null 时同样不产生假 DROP', () => {
    const a = snap({ tables: { users: 'CREATE TABLE `users` (`id` int NOT NULL)' } });
    const b = snap({ tables: { users: null } }, [denied('users')]);
    expect(compareRun(a.meta, b.meta).items).toEqual([]);
    expect(mergeCoverage(a, b, ['table']).skipped).toEqual([denied('users')]);
  });

  it('两侧都有值时正常产出差异（对照组）', () => {
    const a = snap({ tables: { users: 'CREATE TABLE `users` (\n  `id` int NOT NULL\n)' } });
    const b = snap({ tables: { users: 'CREATE TABLE `users` (\n  `id` int NOT NULL,\n  `email` varchar(64) NULL\n)' } });
    const res = compareRun(a.meta, b.meta);
    expect(res.stats.ALL).toBeGreaterThan(0);
    // 两边都有值时是正常 CHANGE 差异（A=来源，B 多一列 → 生成 DROP 把 B 拉回 A），不是 null 跳过造成的空结果。
    expect(res.items.some((i) => i.sql.includes('`email`') && i.changeType === 'DROP')).toBe(true);
    expect(mergeCoverage(a, b, ['table']).skipped).toEqual([]);
  });
});
