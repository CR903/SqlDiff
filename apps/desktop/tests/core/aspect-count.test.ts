// 切面计数与 Tab 作用域的回归。
//
// 定义变更记录：初版（commit 1050e1a）countAspects 只数 index/primary/column，
// 且断言「table/routine/data 三桶不计入」——那是**全局切面 chip** 时代的口径
// （三桶另有 Tab / 对象 chip 表达，故不单列）。
// 现改为 Tab 内子标签（见 ASPECT_SCOPES），DROP·表 / CHANGE·例程 / CHANGE·数据
// 都必须能计数，故三桶纳入。这是口径的有意变更，不是实现走偏。
import { describe, expect, it } from 'vitest';
import {
  ASPECT_SCOPES,
  aspectScopeFor,
  countAspects,
  pruneAspectFilter,
} from '../../src-core/compare-filter';
import type { DiffItem, StmtAspect } from '../../src-core/types';

const ALL_ASPECTS: StmtAspect[] = ['table', 'column', 'primary', 'index', 'routine', 'data'];

function item(aspects: StmtAspect[], id = 'x'): DiffItem {
  return {
    id,
    objectType: 'table',
    objectName: 't',
    changeType: 'CHANGE',
    stmtKind: 'DDL',
    aspects,
    risk: 'medium',
    sql: 'ALTER TABLE `t` ...;',
  } as DiffItem;
}

describe('countAspects', () => {
  it('空输入时全部切面为 0（六个键都要在，不能只有三个）', () => {
    const c = countAspects([]);
    expect(c).toEqual({ table: 0, column: 0, primary: 0, index: 0, routine: 0, data: 0 });
  });

  it('按 aspects 分别计数', () => {
    const items = [
      item(['index'], 'a'),
      item(['index', 'column'], 'b'),
      item(['primary'], 'c'),
      item(['column'], 'd'),
      item(['column'], 'e'),
    ];
    expect(countAspects(items)).toEqual({
      table: 0, column: 3, primary: 1, index: 2, routine: 0, data: 0,
    });
  });

  it('同一条含多个切面时各计一次（不重复累加）', () => {
    expect(countAspects([item(['index', 'primary', 'column'])])).toEqual({
      table: 0, column: 1, primary: 1, index: 1, routine: 0, data: 0,
    });
  });

  // 口径变更：这三桶现在必须计数（DROP·表 / CHANGE·例程 / CHANGE·数据 的来源）
  it('table/routine/data 三桶现在参与计数（子标签需要它们）', () => {
    const c = countAspects([item(['table']), item(['routine']), item(['data'])]);
    expect(c.table).toBe(1);
    expect(c.routine).toBe(1);
    expect(c.data).toBe(1);
  });

  it('aspects 缺失/为空的老条目不报错且不计数', () => {
    const legacy = {
      id: 'old', objectType: 'table', objectName: 't',
      changeType: 'DROP', risk: 'high', sql: 'DROP TABLE `t`;',
    } as unknown as DiffItem;
    expect(countAspects([legacy])).toEqual({
      table: 0, column: 0, primary: 0, index: 0, routine: 0, data: 0,
    });
  });

  it('未知切面值被忽略而不是污染计数', () => {
    const bogus = item(['not-an-aspect' as unknown as StmtAspect], 'b');
    expect(countAspects([bogus])).toEqual({
      table: 0, column: 0, primary: 0, index: 0, routine: 0, data: 0,
    });
  });

  it('恰好覆盖本次缺陷场景：DROP 表里的主键换键能被「主键」维度捞出来', () => {
    const dropTable = item(['table'], 'd1');
    const swapPk = item(['primary'], 'd2');
    const c = countAspects([dropTable, swapPk]);
    expect(c.primary).toBe(1);
    expect(c.index).toBe(0);
  });
});

describe('ASPECT_SCOPES：Tab → 子标签', () => {
  it('DROP 含且仅含 5 种切面，顺序固定', () => {
    expect(ASPECT_SCOPES.DROP.map((a) => a.value)).toEqual([
      'table', 'column', 'primary', 'index', 'routine',
    ]);
  });

  it('CHANGE 含且仅含 5 种切面，顺序固定', () => {
    expect(ASPECT_SCOPES.CHANGE.map((a) => a.value)).toEqual([
      'column', 'primary', 'index', 'routine', 'data',
    ]);
  });

  it('每个 Tab 的子标签无重复（否则子标签会互相盖掉计数）', () => {
    for (const [tab, list] of Object.entries(ASPECT_SCOPES)) {
      const vals = list.map((a) => a.value);
      expect(new Set(vals).size, `${tab} 子标签有重复`).toBe(vals.length);
    }
  });

  it('子标签取值都是合法的 StmtAspect', () => {
    for (const list of Object.values(ASPECT_SCOPES)) {
      for (const a of list) expect(ALL_ASPECTS).toContain(a.value);
    }
  });

  it('每个子标签都有中文 label（不能露出裸英文枚举）', () => {
    for (const list of Object.values(ASPECT_SCOPES)) {
      for (const a of list) expect(a.label.length).toBeGreaterThan(0);
    }
  });

  it('ALL / CREATE 不分子标签 → aspectScopeFor 返回 null', () => {
    expect(aspectScopeFor('ALL')).toBeNull();
    expect(aspectScopeFor('CREATE')).toBeNull();
    expect(aspectScopeFor('DROP')).not.toBeNull();
    expect(aspectScopeFor('CHANGE')).not.toBeNull();
  });
});

describe('pruneAspectFilter：切换 Tab 时清理不可用选择', () => {
  it('目标 Tab 无子标签（ALL/CREATE）→ 回落 ALL', () => {
    expect(pruneAspectFilter(['index'], 'ALL')).toBe('ALL');
    expect(pruneAspectFilter(['index'], 'CREATE')).toBe('ALL');
  });

  it('全部选择都被裁掉 → 回落 ALL（关键：防静默空列表）', () => {
    // DROP 选了「表」，CHANGE 没有 table 切面
    expect(pruneAspectFilter(['table'], 'CHANGE')).toBe('ALL');
  });

  it('部分保留 → 保留仍可用的那些', () => {
    // DROP 选了「表+索引」，CHANGE 两者皆可用，但 table 不在 CHANGE
    expect(pruneAspectFilter(['table', 'index'], 'CHANGE')).toEqual(['index']);
  });

  it('全部可用 → 原样返回', () => {
    expect(pruneAspectFilter(['index'], 'CHANGE')).toEqual(['index']);
    expect(pruneAspectFilter(['table'], 'DROP')).toEqual(['table']);
  });

  it('原本就是 ALL → 仍是 ALL（不做无谓写入）', () => {
    expect(pruneAspectFilter('ALL', 'DROP')).toBe('ALL');
    expect(pruneAspectFilter('ALL', 'ALL')).toBe('ALL');
  });

  it('顺序裁剪保持与原选择一致，不重排', () => {
    expect(pruneAspectFilter(['routine', 'column'], 'CHANGE')).toEqual(['routine', 'column']);
  });

  it('未知切面值一并被裁掉（不留残余脏值）', () => {
    expect(pruneAspectFilter(['not-real' as StmtAspect], 'DROP')).toBe('ALL');
  });
});