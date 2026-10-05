// 补测（10-04-test-gap-backfill R1）：buildDemoMetadata（demo 模式入口快照）。
// runDemoCompare 此前有 5 处直测，但它通过 buildDemoMetadata 取数据——
// 入口数据结构本身从未被断言，导致「改了快照导致 demo 差异整体消失」这类回归无处报警。

import { describe, expect, it } from 'vitest';
import { buildDemoMetadata } from '../../src-renderer/demo';

describe('buildDemoMetadata', () => {
  it('返回 A/B 两份结构完整的快照，四类对象 map 都在', () => {
    const { a, b } = buildDemoMetadata();
    for (const side of [a, b]) {
      expect(side.tables).toBeTypeOf('object');
      expect(side.views).toBeTypeOf('object');
      expect(side.procedures).toBeTypeOf('object');
      expect(side.functions).toBeTypeOf('object');
    }
    // 四类都非空：demo 必须同时展示表 / 视图 / 过程 / 函数。
    expect(Object.keys(a.tables).length).toBeGreaterThan(0);
    expect(Object.keys(a.views).length).toBeGreaterThan(0);
    expect(Object.keys(a.procedures).length).toBeGreaterThan(0);
    expect(Object.keys(a.functions).length).toBeGreaterThan(0);
    expect(Object.keys(b.tables).length).toBeGreaterThan(0);
    expect(Object.keys(b.views).length).toBeGreaterThan(0);
    expect(Object.keys(b.procedures).length).toBeGreaterThan(0);
    expect(Object.keys(b.functions).length).toBeGreaterThan(0);
  });

  it('A 侧独有 users_new（B 侧无）→ 覆盖 CREATE TABLE 场景', () => {
    const { a, b } = buildDemoMetadata();
    expect(Object.keys(a.tables)).toContain('users_new');
    expect(Object.keys(b.tables)).not.toContain('users_new');
  });

  it('B 侧独有 old_log（A 侧无）→ 覆盖高危 DROP TABLE 场景', () => {
    const { a, b } = buildDemoMetadata();
    expect(Object.keys(b.tables)).toContain('old_log');
    expect(Object.keys(a.tables)).not.toContain('old_log');
  });

  it('每次调用返回全新对象：调用方改写不会污染后续 demo', () => {
    const first = buildDemoMetadata();
    first.a.tables.injected = 'CREATE TABLE `injected` (`id` int)';
    first.b.views.injected = 'CREATE VIEW `injected` AS SELECT 1';

    const second = buildDemoMetadata();
    expect(second.a.tables).not.toHaveProperty('injected');
    expect(second.b.views).not.toHaveProperty('injected');
    expect(second.a.tables).not.toBe(first.a.tables);
  });

  it('同名共享对象：orders 定义完全相同，users / shared_proc / fn_total 定义不同', () => {
    const { a, b } = buildDemoMetadata();
    // orders 两侧引用同一份定义 → 正确实现下不产生差异项（演示「无差异」分支）。
    expect(a.tables.orders).toBe(b.tables.orders);
    // 其余同名对象定义不同 → 供 CHANGE 场景演示。
    expect(a.tables.users).not.toBe(b.tables.users);
    expect(a.procedures.shared_proc).not.toBe(b.procedures.shared_proc);
    expect(a.functions.fn_total).not.toBe(b.functions.fn_total);
    // 双方都存在的对象名（交集演示）。
    for (const name of ['users', 'orders']) {
      expect(Object.keys(a.tables)).toContain(name);
      expect(Object.keys(b.tables)).toContain(name);
    }
    // A/B 各自独有的例程名 → 覆盖 DROP/CREATE 例程。
    expect(Object.keys(a.procedures)).toContain('calc_new');
    expect(Object.keys(b.procedures)).toContain('calc');
  });
});