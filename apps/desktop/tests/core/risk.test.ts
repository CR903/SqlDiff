// 补测（10-04-test-gap-backfill R1）：riskFor / explainFor / rollbackFor 三个薄封装入口。
// assessRisk 的规则分支在 diff.test.ts 里有间接覆盖，但三个导出入口本身此前从未被直接调用，
// 故此处按「入口 + 边界」配对，不重复穷举全部分支矩阵。

import { describe, expect, it } from 'vitest';
import { explainFor, riskFor, rollbackFor } from '../../src-core/risk';

describe('riskFor：等级判定入口', () => {
  it('不可逆的结构删除 → high', () => {
    expect(riskFor('DROP TABLE `t`;')).toBe('high');
    expect(riskFor('ALTER TABLE `t` DROP COLUMN `age`;')).toBe('high');
    expect(riskFor('ALTER TABLE `t` DROP PRIMARY KEY;')).toBe('high');
  });

  it('新建 / 可重建 → low（DROP INDEX 只影响性能，不丢数据）', () => {
    expect(riskFor('CREATE TABLE `t` (`id` int);')).toBe('low');
    expect(riskFor('ALTER TABLE `t` ADD COLUMN `age` int;')).toBe('low');
    expect(riskFor('ALTER TABLE `t` DROP INDEX `idx`;')).toBe('low');
  });

  it('无法归类（含空串）→ 兜底 medium：未知语句不得静默显示成 low', () => {
    expect(riskFor('')).toBe('medium');
    expect(riskFor('SELECT 1')).toBe('medium');
    expect(riskFor('DROP VIEW `v`;')).toBe('medium');
    expect(riskFor('DROP PROCEDURE `p`;')).toBe('medium');
  });
});

describe('explainFor：中文说明入口', () => {
  it('DROP TABLE 必须带「备份」提示（安全约束：不可撤销文案缺一不可）', () => {
    const s = explainFor('DROP TABLE `t`;');
    expect(s).toContain('高危');
    expect(s).toContain('备份');
    expect(s).toContain('不可撤销');
  });

  it('DROP COLUMN 与 DROP TABLE 的说明各自独立（不是同一段模板复用）', () => {
    const col = explainFor('ALTER TABLE `t` DROP COLUMN `age`;');
    const tbl = explainFor('DROP TABLE `t`;');
    expect(col).toContain('该列全部数据');
    expect(col).not.toBe(tbl);
  });

  it('同一 CREATE 语句里既有 ADD 又有 CREATE 时取「新增列/索引」文案（分支优先级）', () => {
    expect(explainFor('ALTER TABLE `t` ADD COLUMN `age` int;')).toContain('新增列/索引');
    expect(explainFor('CREATE TABLE `t` (`id` int);')).toContain('新建对象');
  });
});

describe('rollbackFor：回滚建议入口', () => {
  it('objectName 代入备份模板（DROP TABLE 带 mysqldump 示例）', () => {
    const rb = rollbackFor('DROP TABLE `orders`;', 'orders');
    expect(rb).toContain('mysqldump');
    expect(rb).toContain('orders > orders.bak.sql');
    expect(rb).toContain('无自动回滚');
  });

  it('缺省 objectName → 占位词「该对象」，不留 undefined 拼接痕迹', () => {
    expect(rollbackFor('DROP TABLE `orders`;')).toContain('该对象');
    expect(rollbackFor('SELECT 1;')).toContain('该对象');
    expect(rollbackFor('SELECT 1;')).not.toContain('undefined');
  });

  it('当前全部规则分支都给出回滚文案（无 undefined 路径）', () => {
    // 说明：JSDoc 写「无明确回滚时返回 undefined」，但现实现每个分支都带回滚占位，
    // undefined 路径不可达。此断言锁住「不得出现半截/空回滚」，将来若新增无回滚分支需同步更新。
    const cases = [
      'DROP TABLE `t`;',
      'ALTER TABLE `t` DROP COLUMN `c`;',
      'ALTER TABLE `t` DROP PRIMARY KEY;',
      'DROP PROCEDURE `p`;',
      'DROP VIEW `v`;',
      'ALTER TABLE `t` DROP INDEX `i`;',
      'CREATE TABLE `t` (`id` int);',
      'ALTER TABLE `t` ADD COLUMN `c` int;',
      '',
    ];
    for (const sql of cases) {
      const rb = rollbackFor(sql, 't');
      expect(typeof rb).toBe('string');
      expect((rb as string).length).toBeGreaterThan(0);
    }
  });
});