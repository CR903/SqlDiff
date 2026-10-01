// 切面 chip 计数单测。
//
// 背景（真实缺陷）：UI 此前只暴露 INDEX 一个切面 chip，而 PRIMARY KEY 被刻意
// 排除在 index 之外 —— 于是「DROP + 表」里 DROP TABLE 与
// `ALTER TABLE … DROP PRIMARY KEY, ADD PRIMARY KEY(…)` 混在一起且无从筛除。
// 本测试锁住三个切面的计数口径，避免 UI 再退回「只数 index」。
import { describe, expect, it } from 'vitest';
import { countAspects } from './compare-filter';
import type { DiffItem, StmtAspect } from './types';

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
  it('空输入全为 0', () => {
    expect(countAspects([])).toEqual({ index: 0, primary: 0, column: 0 });
  });

  it('按 aspects 分别计数', () => {
    const items = [
      item(['index'], 'a'),
      item(['index', 'column'], 'b'),
      item(['primary'], 'c'),
      item(['column'], 'd'),
      item(['column'], 'e'),
    ];
    expect(countAspects(items)).toEqual({ index: 2, primary: 1, column: 3 });
  });

  it('同一条含多个切面时各计一次（不重复累加）', () => {
    expect(countAspects([item(['index', 'primary', 'column'])])).toEqual({
      index: 1,
      primary: 1,
      column: 1,
    });
  });

  it('table/routine/data 三桶不计入 chip（它们由 Tab 与对象 chip 表达）', () => {
    // 这三项若被计入，用户会看到与「表/视图/过程/函数/数据」重复且互相盖计数的 chip。
    expect(countAspects([item(['table']), item(['routine']), item(['data'])])).toEqual({
      index: 0,
      primary: 0,
      column: 0,
    });
  });

  it('aspects 缺失/为空的老条目不报错且不计数', () => {
    const legacy = [{ id: 'old', objectType: 'table', objectName: 't', changeType: 'DROP', risk: 'high', sql: 'DROP TABLE `t`;' } as unknown as DiffItem];
    expect(countAspects([legacy[0]])).toEqual({ index: 0, primary: 0, column: 0 });
  });

  it('恰好覆盖本次缺陷场景：DROP 表里的主键换键能被「主键」维度捞出来', () => {
    // DROP TABLE → table 桶（不算进任一切面 chip）
    // ALTER TABLE … DROP PRIMARY KEY, ADD PRIMARY KEY → primary 桶
    const dropTable = item(['table'], 'd1');
    const swapPk = item(['primary'], 'd2');
    const c = countAspects([dropTable, swapPk]);
    expect(c.primary).toBe(1);
    expect(c.index).toBe(0);
    // 关键：用户可用「主键」chip 把换主键语句从 DROP TABLE 里区分出来
    expect(c.primary).toBeGreaterThan(0);
  });
});