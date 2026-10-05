// 补测（10-04-test-gap-backfill R1/R4）：normalizeScopes / hasDataScope。
// 两个函数此前只在 compare-run.ts 内部被调用，外部请求（IPC compare.run 的 scopes 字段）
// 的降级语义完全没有断言——这是不可信输入入口，必须锁死「降级而不是抛错」。

import { describe, expect, it } from 'vitest';
import { ALL_SCOPES, hasDataScope, normalizeScopes } from '../../src-core/compare-filter';

describe('normalizeScopes：外部 scopes 输入归一', () => {
  it('合法值按原序去重保留', () => {
    expect(normalizeScopes(['table', 'table', 'view'])).toEqual(['table', 'view']);
    expect(normalizeScopes(['view', 'function'])).toEqual(['view', 'function']);
  });

  it('非数组（undefined / null / 字符串 / 数字）→ 降级为四类全开，不抛错', () => {
    for (const bad of [undefined, null, 'table', 123, {}, true]) {
      expect(normalizeScopes(bad)).toEqual([...ALL_SCOPES]);
    }
  });

  it('空数组 → 降级为四类全开（空选择意为「不筛」而非「什么都不比」）', () => {
    expect(normalizeScopes([])).toEqual([...ALL_SCOPES]);
  });

  it('混合非法值 → 只剔除非法项，保留合法项', () => {
    // 'data' 不是结构 ObjectType：结构归一时必须剥离，但不能让整组失效。
    expect(normalizeScopes(['table', 'bogus', 'data'])).toEqual(['table']);
    expect(normalizeScopes(['view', null, 7, 'procedure'])).toEqual(['view', 'procedure']);
  });

  it('全部非法（含只带 data）→ 降级为四类全开', () => {
    expect(normalizeScopes(['bogus', 'nope'])).toEqual([...ALL_SCOPES]);
    expect(normalizeScopes(['data'])).toEqual([...ALL_SCOPES]);
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