// normalizeScopes / hasDataScope / filterMetadataByScopes 的外部输入语义。
//
// 两个函数此前只在 compare-run.ts 内部被调用，外部请求（IPC compare.run 的 scopes 字段）
// 的降级语义完全没有断言——这是不可信输入入口，必须锁死「降级而不是抛错」。
//
// 10-05 修复：区分两种「空」——显式空（[] / 只带 'data'）不补全，
// 无法解释的输入（null / 非数组 / 全是词表外垃圾值）仍 fail-safe 全开。

import { describe, expect, it } from 'vitest';
import type { DiffItem } from '../../src-core/types';
import {
  ALL_SCOPES,
  filterMetadataByScopes,
  hasDataScope,
  normalizeScopes,
  postFilterResult,
} from '../../src-core/compare-filter';

function item(over: Partial<DiffItem> & Pick<DiffItem, 'id' | 'objectType'>): DiffItem {
  return {
    objectName: 'users',
    changeType: 'CHANGE',
    aspects: ['column'],
    risk: 'low',
    sql: 'ALTER TABLE `users` ADD COLUMN `x` int;',
    ...over,
  };
}

describe('normalizeScopes：外部 scopes 输入归一', () => {
  it('合法值按原序去重保留', () => {
    expect(normalizeScopes(['table', 'table', 'view'])).toEqual(['table', 'view']);
    expect(normalizeScopes(['view', 'function'])).toEqual(['view', 'function']);
  });

  it('非数组（undefined / null / 字符串 / 数字 / 对象 / 布尔）→ 降级为四类全开，不抛错', () => {
    for (const bad of [undefined, null, 'table', 123, 42, {}, true]) {
      expect(normalizeScopes(bad)).toEqual([...ALL_SCOPES]);
    }
  });

  it('显式空数组 → 空结构范围，不补全（用户没勾结构就是没勾）', () => {
    expect(normalizeScopes([])).toEqual([]);
  });

  it('只带 data → 空结构范围，不回落全开（10-05 静默越权回归）', () => {
    // 这正是「取消全部结构类型 + 只勾数据」时 store 发出的请求形态。
    // 修复前回落成四类全开：用户没勾的结构被执行，且界面/历史都显示成只比数据。
    expect(normalizeScopes(['data'])).toEqual([]);
    expect(normalizeScopes(['data', 'data'])).toEqual([]);
  });

  it('混合非法值 → 只剔除非法项，保留合法项（含 data）', () => {
    expect(normalizeScopes(['table', 'bogus', 'data'])).toEqual(['table']);
    expect(normalizeScopes(['view', null, 7, 'procedure'])).toEqual(['view', 'procedure']);
    expect(normalizeScopes(['table', 'data', 'view'])).toEqual(['table', 'view']);
  });

  it('全是词表外垃圾值 → fail-safe 四类全开（请求看不懂就比全量，不静默什么都不比）', () => {
    expect(normalizeScopes(['bogus', 'nope'])).toEqual([...ALL_SCOPES]);
    expect(normalizeScopes([true, 123])).toEqual([...ALL_SCOPES]);
    expect(normalizeScopes([null, undefined, {}])).toEqual([...ALL_SCOPES]);
    // 非字符串 / 嵌套容器 / 大小写不符的 token 一律算「看不懂」，走 fail-safe。
    expect(normalizeScopes([[]])).toEqual([...ALL_SCOPES]);
    expect(normalizeScopes([['table']])).toEqual([...ALL_SCOPES]);
    expect(normalizeScopes([NaN, 0, ''])).toEqual([...ALL_SCOPES]);
    expect(normalizeScopes(['DATA'])).toEqual([...ALL_SCOPES]);
  });

  it('判据是「原数组非空且命中词表」，不是「过滤后还剩几个」', () => {
    // 这组用例锁住两种「空」的分界线本身：以下各例过滤后同样是空数组，
    // 但只要命中过词表（'data'）就是合法意图 → 不补全；一个都没命中 → fail-safe。
    // 若实现改成看过滤后的长度或 raw.length 之类的近似判据，本例必红。
    expect(normalizeScopes(['data', 'bogus'])).toEqual([]);
    expect(normalizeScopes(['data', null, 42, {}])).toEqual([]);
    expect(normalizeScopes([null])).toEqual([...ALL_SCOPES]);
    expect(normalizeScopes([[]])).toEqual([...ALL_SCOPES]);
    expect(normalizeScopes([{}])).toEqual([...ALL_SCOPES]);
    expect(normalizeScopes(['data'])).not.toEqual([...ALL_SCOPES]);
    expect(normalizeScopes(['bogus'])).toEqual([...ALL_SCOPES]);
  });

  it('返回值是全新数组：调用方改它不会污染 ALL_SCOPES 常量', () => {
    const a = normalizeScopes(undefined);
    const b = normalizeScopes(['table']);
    expect(a).not.toBe(ALL_SCOPES);
    expect(b).not.toBe(ALL_SCOPES);
    a.push('procedure');
    b.length = 0;
    expect(ALL_SCOPES).toEqual(['table', 'view', 'procedure', 'function']);
  });
});

describe('filterMetadataByScopes：空结构范围清空四类', () => {
  const meta = {
    tables: { users: 'CREATE TABLE `users` (`id` int)' },
    views: { v_report: 'CREATE VIEW `v_report` AS SELECT 1' },
    procedures: { p1: 'CREATE PROCEDURE p1() BEGIN END' },
    functions: { f1: 'CREATE FUNCTION f1() RETURNS int RETURN 1' },
  };

  it('scopes=[] → 四类全空：下游 compareRun 不再产出任何结构差异', () => {
    const out = filterMetadataByScopes(meta, normalizeScopes(['data']));
    expect(out).toEqual({ tables: {}, views: {}, procedures: {}, functions: {} });
  });

  it('归一后的空结构范围与「显式传空数组」口径完全一致（下游只认 scopes，不认原始 token）', () => {
    // 契约：下游（filterMetadataByScopes / postFilterResult / mergeCoverage）只吃
    // ObjectType[]，原始 'data' token 不参与下游判定，故两条路径必须给出同一结果。
    expect(filterMetadataByScopes(meta, normalizeScopes(['data']))).toEqual(
      filterMetadataByScopes(meta, []),
    );
    expect(filterMetadataByScopes(meta, normalizeScopes(['data']))).toEqual({
      tables: {},
      views: {},
      procedures: {},
      functions: {},
    });
  });

  it('fail-safe 全开时四类原样保留（既有裁剪口径不变）', () => {
    expect(filterMetadataByScopes(meta, normalizeScopes(['table']))).toEqual({
      tables: meta.tables,
      views: {},
      procedures: {},
      functions: {},
    });
    expect(filterMetadataByScopes(meta, normalizeScopes(undefined))).toEqual(meta);
  });
});

describe('postFilterResult：空结构范围只保留数据行', () => {
  it('结构项被裁掉，数据行不受结构 scopes 裁剪（数据开关由 hasDataScope 控制）', () => {
    const items = [
      item({ id: 't1', objectType: 'table' }),
      item({ id: 'v1', objectType: 'view' }),
      item({
        id: 'd1',
        objectType: 'data',
        changeType: 'CREATE',
        dml: 'INSERT',
        aspects: ['data'],
        sql: "INSERT INTO `users` (`id`) VALUES (1);",
      }),
    ];
    const out = postFilterResult(items, normalizeScopes(['data']));
    expect(out.items.map((i) => i.id)).toEqual(['d1']);
    expect(out.stats.ALL).toBe(1);
    expect(out.stats.DML).toEqual({ INSERT: 1, DELETE: 0, UPDATE: 0 });
  });
});

describe('hasDataScope：数据对比开关', () => {
  it('scopes 携带 data → 开启', () => {
    expect(hasDataScope(['data'])).toBe(true);
    expect(hasDataScope(['table', 'data'])).toBe(true);
  });

  it('显式 includeData=true → 开启，且优先于 scopes（短路）', () => {
    expect(hasDataScope(undefined, true)).toBe(true);
    expect(hasDataScope([], true)).toBe(true);
    expect(hasDataScope(['table'], true)).toBe(true);
    // 非数组 scopes 也拦不住显式开关。
    expect(hasDataScope('data', true)).toBe(true);
  });

  it('未开启：结构 scopes / 空 / 非数组 / includeData=false 一律 false', () => {
    expect(hasDataScope(['table', 'view'])).toBe(false);
    expect(hasDataScope([])).toBe(false);
    expect(hasDataScope(undefined)).toBe(false);
    expect(hasDataScope(null)).toBe(false);
    expect(hasDataScope('data')).toBe(false);
    expect(hasDataScope(['table'], false)).toBe(false);
    expect(hasDataScope(undefined, false)).toBe(false);
  });
});