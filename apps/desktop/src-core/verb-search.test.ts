// R7 动词级搜索：verbOf 首关键字 + verbs 过滤组合 + 复制=所见。
import { describe, expect, it } from 'vitest';
import type { DatabaseMetadata } from '../src-main/metadata';
import { verbOf } from './classify';
import { compareRun, toExportSql } from './compare';
import { postFilterResult } from './compare-filter';
import type { DiffItem } from './types';

const T_BASE = [
  'CREATE TABLE `users` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

// A 比 B：多一列（age）+ 主键变更（id -> id,name）+ 多一个二级索引（idx_name）。
const T_FULL = [
  'CREATE TABLE `users` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  '  `age` int(11) DEFAULT NULL,',
  '  PRIMARY KEY (`id`,`name`),',
  '  KEY `idx_name` (`name`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

const T_FRESH = [
  'CREATE TABLE `fresh` (',
  '  `id` int(11) NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

const T_GHOST = [
  'CREATE TABLE `ghost` (',
  '  `id` int(11) NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

function meta(over: Partial<DatabaseMetadata> = {}): DatabaseMetadata {
  return { tables: {}, views: {}, procedures: {}, functions: {}, ...over };
}

/** 5 条目基座：users 列/主键/索引三 ALTER + fresh CREATE + ghost DROP。 */
function mixed() {
  return compareRun(
    meta({ tables: { users: T_FULL, fresh: T_FRESH } }),
    meta({ tables: { users: T_BASE, ghost: T_GHOST } }),
  );
}

const DATA_ITEMS: DiffItem[] = [
  {
    id: 'data:users:users:INSERT:0', objectType: 'data', objectName: 'users', changeType: 'CREATE',
    dml: 'INSERT', stmtKind: 'DML', aspects: ['data'], risk: 'low', sql: 'INSERT INTO `users` VALUES (1);\n',
  },
  {
    id: 'data:users:users:DELETE:0', objectType: 'data', objectName: 'users', changeType: 'DROP',
    dml: 'DELETE', stmtKind: 'DML', aspects: ['data'], risk: 'low', sql: 'DELETE FROM `users` WHERE `id` = 2;\n',
  },
  {
    id: 'data:users:users:UPDATE:0', objectType: 'data', objectName: 'users', changeType: 'CHANGE',
    dml: 'UPDATE', stmtKind: 'DML', aspects: ['data'], risk: 'low', sql: 'UPDATE `users` SET `name` = \'a\' WHERE `id` = 3;\n',
  },
];

describe('verbOf 首关键字', () => {
  it('CREATE：建表 / 小写 / CREATE OR REPLACE 视图 / 前导注释空行', () => {
    expect(verbOf('CREATE TABLE `t` (`id` int);\n')).toBe('CREATE');
    expect(verbOf('create table `t` (`id` int);\n')).toBe('CREATE');
    expect(verbOf('CREATE OR REPLACE VIEW `v` AS SELECT 1;\n')).toBe('CREATE');
    expect(verbOf('-- 表注释\n\n  CREATE TABLE `t` (`id` int);\n')).toBe('CREATE');
    expect(verbOf('/* 块注释 */ CREATE TABLE `t` (`id` int);\n')).toBe('CREATE');
  });

  it('DROP：删表 / 删例程', () => {
    expect(verbOf('DROP TABLE `t`;\n')).toBe('DROP');
    expect(verbOf('-- 先删\nDROP PROCEDURE `p`;\n')).toBe('DROP');
  });

  it('ALTER：列 / 主键 / 索引三类 ALTER 全归 ALTER', () => {
    expect(verbOf('ALTER TABLE `t` ADD COLUMN `a` int;\n')).toBe('ALTER');
    expect(verbOf('ALTER TABLE `t` DROP PRIMARY KEY,ADD PRIMARY KEY (`id`);\n')).toBe('ALTER');
    expect(verbOf('ALTER TABLE `t` ADD INDEX `i` (`a`);\n')).toBe('ALTER');
  });

  it('DML：INSERT / DELETE / UPDATE', () => {
    expect(verbOf('INSERT INTO `t` VALUES (1);\n')).toBe('INSERT');
    expect(verbOf('DELETE FROM `t` WHERE `id` = 1;\n')).toBe('DELETE');
    expect(verbOf('UPDATE `t` SET `a` = 1 WHERE `id` = 2;\n')).toBe('UPDATE');
  });

  it('OTHER：空串 / SELECT / 纯注释 / TRUNCATE（预留无桶）/ REPLACE（无桶）/ DELIMITER 例程块', () => {
    expect(verbOf('')).toBe('OTHER');
    expect(verbOf('   \n ')).toBe('OTHER');
    expect(verbOf('SELECT 1;')).toBe('OTHER');
    expect(verbOf('-- 只有注释')).toBe('OTHER');
    expect(verbOf('TRUNCATE TABLE `t`;')).toBe('OTHER');
    expect(verbOf('REPLACE INTO `t` VALUES (1);')).toBe('OTHER');
    expect(verbOf('DELIMITER ;;\nCREATE PROCEDURE `p`() BEGIN SELECT 1; END ;;\nDELIMITER ;\n')).toBe('OTHER');
  });
});

describe('verbs 过滤：ALTER 桶 / CREATE 桶', () => {
  it('基座 5 条：users 三 ALTER + fresh CREATE + ghost DROP（导出序 DROP→CREATE→CHANGE）', () => {
    const r = mixed();
    expect(r.items).toHaveLength(5);
    // users:s1（DROP+ADD PRIMARY KEY 合写单条）按 M4 分类器判 DROP（含 DROP、无 CREATE），故排第二；
    // verbOf 仍为 ALTER（首关键字），动词桶与 changeType 正交即在于此。
    expect(r.items.map((i) => i.id)).toEqual([
      'table:ghost:s0',
      'table:users:s1',
      'table:fresh:s0',
      'table:users:s0',
      'table:users:s2',
    ]);
    expect(r.items.find((i) => i.id === 'table:users:s1')?.changeType).toBe('DROP');
  });

  it('ALTER 桶含列/主键/索引三类 ALTER（verbOf 全 ALTER，与 changeType 正交）', () => {
    const r = postFilterResult(mixed().items, ['table'], '', { verbs: ['ALTER'] });
    expect(r.items).toHaveLength(3);
    expect(r.items.map((i) => i.aspects[0]).sort()).toEqual(['column', 'index', 'primary']);
    for (const it of r.items) expect(verbOf(it.sql)).toBe('ALTER');
  });

  it('CREATE 桶只见 CREATE 开头语句（不见 ALTER）', () => {
    const r = postFilterResult(mixed().items, ['table'], '', { verbs: ['CREATE'] });
    expect(r.items.map((i) => i.id)).toEqual(['table:fresh:s0']);
    expect(r.items.every((it) => it.sql.startsWith('CREATE'))).toBe(true);
  });

  it('DROP 桶只见 DROP（动词 DROP≠changeType DROP：users:s1 首词 ALTER，不入此桶）', () => {
    expect(postFilterResult(mixed().items, ['table'], '', { verbs: ['DROP'] }).items.map((i) => i.id))
      .toEqual(['table:ghost:s0']);
    const r = postFilterResult(mixed().items, ['table'], '', { verbs: ['CREATE', 'ALTER'] });
    expect(r.items).toHaveLength(4);
  });

  it('缺省 ALL 与空数组向后兼容（不过滤）', () => {
    expect(postFilterResult(mixed().items, ['table'], '').items).toHaveLength(5);
    expect(postFilterResult(mixed().items, ['table'], '', { verbs: 'ALL' }).items).toHaveLength(5);
    expect(postFilterResult(mixed().items, ['table'], '', { verbs: [] }).items).toHaveLength(5);
  });
});

describe('verbs × 维度 / 切面 / 关键字正交组合', () => {
  it('DDL × INSERT：空结果（结构无数据动词）+ 空 stats', () => {
    const r = postFilterResult(mixed().items, ['table'], '', { stmtKind: 'DDL', verbs: ['INSERT'] });
    expect(r.items).toEqual([]);
    expect(r.stats.ALL).toBe(0);
  });

  it('DML 三动词只见对应数据语句', () => {
    const scopes = ['table'] as const;
    expect(postFilterResult(DATA_ITEMS, [...scopes], '', { verbs: ['INSERT'] }).items.map((i) => i.id))
      .toEqual(['data:users:users:INSERT:0']);
    expect(
      postFilterResult(DATA_ITEMS, [...scopes], '', { verbs: ['UPDATE', 'DELETE'] }).items.map((i) => i.id),
    ).toEqual(['data:users:users:DELETE:0', 'data:users:users:UPDATE:0']);
    const dml = postFilterResult(DATA_ITEMS, [...scopes], '', { stmtKind: 'DML', verbs: ['INSERT'] });
    expect(dml.items.map((i) => i.id)).toEqual(['data:users:users:INSERT:0']);
    expect(dml.stats.DML.INSERT).toBe(1);
  });

  it('INDEX 切面 × ALTER：只剩索引 ALTER；× CREATE：空', () => {
    const only = postFilterResult(mixed().items, ['table'], '', { aspect: 'index', verbs: ['ALTER'] });
    expect(only.items.map((i) => i.id)).toEqual(['table:users:s2']);
    expect(only.stats).toMatchObject({ ALL: 1, INDEX: 1 });
    expect(postFilterResult(mixed().items, ['table'], '', { aspect: 'index', verbs: ['CREATE'] }).items).toEqual([]);
  });

  it('关键字 × 动词：users × ALTER = 三 ALTER（fresh/ghost 被名滤掉）', () => {
    const r = postFilterResult(mixed().items, ['table'], 'users', { verbs: ['ALTER'] });
    expect(r.items.map((i) => i.id).sort()).toEqual(['table:users:s0', 'table:users:s1', 'table:users:s2']);
  });
});

describe('复制=所见：动词过滤后导出文本逐行一致', () => {
  it('ALTER 桶导出只含三 ALTER（头注释 changeType 不变；导出序 DROP→CHANGE）', () => {
    const filtered = postFilterResult(mixed().items, ['table'], '', { verbs: ['ALTER'] });
    const text = toExportSql(filtered.items, { aName: 'A', bName: 'B', at: '2026-09-22T00:00:00.000Z' });
    const body = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
    expect(body).toEqual([
      'ALTER TABLE `users` DROP PRIMARY KEY,ADD PRIMARY KEY (`id`,`name`);',
      'ALTER TABLE `users` ADD COLUMN `age` int(11) DEFAULT NULL;',
      'ALTER TABLE `users` ADD INDEX `idx_name` (`name`);',
    ]);
    expect(text).not.toContain('CREATE TABLE');
    expect(text).not.toContain('DROP TABLE');
  });

  it('INSERT 桶导出只含 INSERT 数据语句', () => {
    const filtered = postFilterResult(DATA_ITEMS, ['table'], '', { verbs: ['INSERT'] });
    const text = toExportSql(filtered.items, { aName: 'A', bName: 'B', at: '2026-09-22T00:00:00.000Z' });
    const body = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
    expect(body).toEqual(['INSERT INTO `users` VALUES (1);']);
    expect(text).toContain('-- [INSERT] data users');
  });
});
