// 补测（10-04-test-gap-backfill R1）：resolveDataPairs（A/B 数据表配对解析）。
// 该函数此前只有 1 处引用（compare-run.ts 内部），A/B 配对是数据对比的输入，
// 三条分支（显式映射 / 过滤非法项 / 同名交集回落）都缺少断言。
// 注意：本测试只验纯函数，不需要真实连接；import compare-run 会连带加载 mysql2/ssh2 依赖。

import { describe, expect, it } from 'vitest';
import { resolveDataPairs } from '../../src-main/compare-run';
import type { CompareRequest, DataTablePair, ObjectType } from '../../src-core/types';

function req(dataTables?: unknown): CompareRequest {
  return {
    aId: 'node-a',
    bId: 'node-b',
    scopes: ['table', 'data'] as Array<ObjectType | 'data'>,
    ...(dataTables === undefined ? {} : { dataTables: dataTables as DataTablePair[] }),
  };
}

const TABLES_A: Record<string, string | null> = { users: 'C', orders: 'C', audit: 'C' };
const TABLES_B: Record<string, string | null> = { users: 'C', orders: 'C', old_log: 'C' };

describe('resolveDataPairs', () => {
  it('缺省 → A/B 同名交集，按名称排序', () => {
    expect(resolveDataPairs(req(), TABLES_A, TABLES_B)).toEqual([
      { a: 'orders', b: 'orders' },
      { a: 'users', b: 'users' },
    ]);
  });

  it('显式 dataTables 优先：支持异名映射且不与交集混用', () => {
    const pairs = resolveDataPairs(
      req([{ a: 'orders', b: 'orders_v2' }]),
      TABLES_A,
      TABLES_B,
    );
    expect(pairs).toEqual([{ a: 'orders', b: 'orders_v2' }]);
  });

  it('显式列表中的非法项被剔除（空串 / 非字符串 / null），剩余合法项仍生效', () => {
    const dirty = [
      { a: 'users', b: 'users' },
      { a: '', b: 'x' },
      { a: 'x', b: '' },
      { a: 1, b: 'x' },
      { a: 'x', b: null },
      null,
    ];
    const pairs = resolveDataPairs(req(dirty), TABLES_A, TABLES_B);
    expect(pairs).toEqual([{ a: 'users', b: 'users' }]);
  });

  it('显式列表全非法或非数组 → 回落同名交集，不返回空对比', () => {
    expect(resolveDataPairs(req([{ a: '', b: '' }]), TABLES_A, TABLES_B)).toEqual([
      { a: 'orders', b: 'orders' },
      { a: 'users', b: 'users' },
    ]);
    expect(resolveDataPairs(req('not-an-array'), TABLES_A, TABLES_B)).toEqual([
      { a: 'orders', b: 'orders' },
      { a: 'users', b: 'users' },
    ]);
    expect(resolveDataPairs(req([]), TABLES_A, TABLES_B)).toEqual([
      { a: 'orders', b: 'orders' },
      { a: 'users', b: 'users' },
    ]);
  });

  it('无交集或任一侧为空 → 空数组（下游 runDataCompare 无表可跑）', () => {
    expect(resolveDataPairs(req(), {}, TABLES_B)).toEqual([]);
    expect(resolveDataPairs(req(), TABLES_A, {})).toEqual([]);
    expect(resolveDataPairs(req(), {}, {})).toEqual([]);
  });

  it('值为 null 的表也算交集（只按表名存在性配对，交由后续阶段报缺列）', () => {
    // fetchMetadata 以 null 表示「表存在但 SHOW CREATE 未取到」；配对阶段不应据此丢表，
    // 否则该表会静默从数据对比里消失。
    expect(resolveDataPairs(req(), { users: null }, { users: 'C' })).toEqual([
      { a: 'users', b: 'users' },
    ]);
    expect(resolveDataPairs(req(), { users: 'C' }, { users: null })).toEqual([
      { a: 'users', b: 'users' },
    ]);
  });
});