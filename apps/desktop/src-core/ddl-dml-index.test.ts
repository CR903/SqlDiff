// DDL/DML/INDEX 三维过滤单测（R1-R5）：语句拆分 + 切面判定 + 维度过滤组合 + 复制=所见。
import { describe, expect, it } from 'vitest';
import type { DatabaseMetadata } from '../src-main/metadata';
import { aspectOf, classify, stmtKindOf } from './classify';
import { compareRun, toExportSql } from './compare';
import { postFilterResult, recountStats } from './compare-filter';
import { splitStatements } from './diff';
import type { DiffItem } from './types';

const T_BASE = [
  'CREATE TABLE `users` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

// A 比 B 多一列（age）+ 多一个二级索引（idx_name）：期望拆出两条单语句条目。
const T_WITH_COL_AND_IDX = [
  'CREATE TABLE `users` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  '  `age` int(11) DEFAULT NULL,',
  '  PRIMARY KEY (`id`),',
  '  KEY `idx_name` (`name`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

function meta(over: Partial<DatabaseMetadata> = {}): DatabaseMetadata {
  return { tables: {}, views: {}, procedures: {}, functions: {}, ...over };
}

describe('splitStatements 表语句拆分', () => {
  it('多 ALTER 按 ;\\n 切分并补回分号，过滤空块', () => {
    const stmts = splitStatements('ALTER TABLE `t` ADD COLUMN `a` int;\nALTER TABLE `t` ADD INDEX `i` (`a`);\n');
    expect(stmts).toEqual(['ALTER TABLE `t` ADD COLUMN `a` int;\n', 'ALTER TABLE `t` ADD INDEX `i` (`a`);\n']);
  });

  it('CREATE TABLE（含体内逗号/PK，无分号）保持单条', () => {
    const sql = `${T_BASE};\n`;
    expect(splitStatements(sql)).toEqual([sql]);
  });

  it('空串 -> 空数组', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('  \n ')).toEqual([]);
  });

  it('末块无换行不产生双分号（防御：diff 输出恒以 ;\\n 结尾，理论不可达）', () => {
    expect(splitStatements('ALTER TABLE `t` ADD COLUMN `a` int;')).toEqual([
      'ALTER TABLE `t` ADD COLUMN `a` int;\n',
    ]);
    expect(splitStatements('ALTER TABLE `t` ADD COLUMN `a` int;\nALTER TABLE `t` DROP COLUMN `b`;')).toEqual([
      'ALTER TABLE `t` ADD COLUMN `a` int;\n',
      'ALTER TABLE `t` DROP COLUMN `b`;\n',
    ]);
  });
});

describe('aspectOf 切面判定', () => {
  it('index：ADD INDEX / ADD UNIQUE INDEX / FULLTEXT / DROP INDEX / DROP KEY', () => {
    expect(aspectOf('ALTER TABLE `t` ADD INDEX `i` (`a`);')).toBe('index');
    expect(aspectOf('ALTER TABLE `t` ADD UNIQUE INDEX `u` (`a`);')).toBe('index');
    expect(aspectOf('ALTER TABLE `t` ADD FULLTEXT KEY `f` (`c`);')).toBe('index');
    expect(aspectOf('ALTER TABLE `t` DROP INDEX `i`;')).toBe('index');
    expect(aspectOf('ALTER TABLE `t` DROP KEY `i`;')).toBe('index');
  });

  it('primary：ADD/DROP PRIMARY KEY（含 DROP+ADD 合写单条，不归 index）', () => {
    expect(aspectOf('ALTER TABLE `t` ADD PRIMARY KEY (`id`);')).toBe('primary');
    expect(aspectOf('ALTER TABLE `t` DROP PRIMARY KEY;')).toBe('primary');
    expect(aspectOf('ALTER TABLE `t` DROP PRIMARY KEY,ADD PRIMARY KEY (`id`,`n`);')).toBe('primary');
  });

  it('column：ADD / DROP / CHANGE / MODIFY COLUMN', () => {
    expect(aspectOf('ALTER TABLE `t` ADD COLUMN `a` int;')).toBe('column');
    expect(aspectOf('ALTER TABLE `t` DROP COLUMN `a`;')).toBe('column');
    expect(aspectOf('ALTER TABLE `t` CHANGE COLUMN `a` `a` bigint;')).toBe('column');
    expect(aspectOf('ALTER TABLE `t` MODIFY COLUMN `a` bigint;')).toBe('column');
  });

  it('table：CREATE/DROP TABLE（含 PK 体的 CREATE TABLE 仍归 table，不归 primary）', () => {
    expect(aspectOf(`${T_BASE};\n`)).toBe('table');
    expect(aspectOf('DROP TABLE `t`;')).toBe('table');
  });

  it('fallback：例程 -> routine，数据 -> data', () => {
    expect(aspectOf('DROP PROCEDURE `p`;', 'routine')).toBe('routine');
    expect(aspectOf('INSERT INTO `t` VALUES (1);', 'data')).toBe('data');
  });
});

describe('stmtKindOf 维度', () => {
  it("data -> DML，其余 -> DDL", () => {
    expect(stmtKindOf('data')).toBe('DML');
    expect(stmtKindOf('table')).toBe('DDL');
    expect(stmtKindOf('view')).toBe('DDL');
  });
});

describe('compareRun 一表多语句拆分（加列+加索引 -> 两条）', () => {
  const r = compareRun(meta({ tables: { users: T_WITH_COL_AND_IDX } }), meta({ tables: { users: T_BASE } }));

  it('拆出两条：列条目 aspect=column，索引条目 aspect=index', () => {
    expect(r.items).toHaveLength(2);
    expect(r.items.map((i) => i.aspects)).toEqual([['column'], ['index']]);
  });

  it('id 后缀 :s<n> 唯一且保序，每条独立 classify + risk + DDL', () => {
    expect(r.items.map((i) => i.id)).toEqual(['table:users:s0', 'table:users:s1']);
    expect(r.items[0]?.sql).toContain('ADD COLUMN `age`');
    expect(r.items[1]?.sql).toContain('ADD INDEX `idx_name`');
    expect(r.items.map((i) => i.changeType)).toEqual(['CHANGE', 'CHANGE']);
    expect(classify(r.items[0]?.sql ?? '')).toBe('CHANGE');
    expect(classify(r.items[1]?.sql ?? '')).toBe('CHANGE');
    for (const it of r.items) {
      expect(it.stmtKind).toBe('DDL');
      expect(it.risk).toBe('low');
      expect(it.explain).toBeTruthy();
    }
  });

  it('stats：ALL=2，INDEX=1（index 切面条数）', () => {
    expect(r.stats.ALL).toBe(2);
    expect(r.stats.CHANGE).toBe(2);
    expect(r.stats.INDEX).toBe(1);
    expect(recountStats(r.items)).toEqual(r.stats);
  });
});

describe('postFilterResult 维度+切面正交组合', () => {
  const items: DiffItem[] = [
    {
      id: 'table:users:s0', objectType: 'table', objectName: 'users', changeType: 'CHANGE',
      stmtKind: 'DDL', aspects: ['column'], risk: 'low', sql: 'ALTER TABLE `users` ADD COLUMN `age` int;\n',
    },
    {
      id: 'table:users:s1', objectType: 'table', objectName: 'users', changeType: 'CHANGE',
      stmtKind: 'DDL', aspects: ['index'], risk: 'low', sql: 'ALTER TABLE `users` ADD INDEX `idx` (`name`);\n',
    },
    {
      id: 'data:users:users:INSERT:0', objectType: 'data', objectName: 'users', changeType: 'CREATE',
      dml: 'INSERT', stmtKind: 'DML', aspects: ['data'], risk: 'low', sql: 'INSERT INTO `users` VALUES (1);\n',
    },
  ];

  it('切 DDL 只见结构，切 DML 只见数据', () => {
    expect(postFilterResult(items, ['table'], '', { stmtKind: 'DDL' }).items.map((i) => i.id))
      .toEqual(['table:users:s0', 'table:users:s1']);
    const dml = postFilterResult(items, ['table'], '', { stmtKind: 'DML' });
    expect(dml.items.map((i) => i.id)).toEqual(['data:users:users:INSERT:0']);
    expect(dml.stats.ALL).toBe(1);
  });

  it('INDEX 切面只见索引语句，stats.INDEX=所见条数', () => {
    const r = postFilterResult(items, ['table'], '', { aspect: 'index' });
    expect(r.items.map((i) => i.id)).toEqual(['table:users:s1']);
    expect(r.stats).toMatchObject({ ALL: 1, INDEX: 1 });
  });

  it('DDL × INDEX 组合：只剩索引结构语句', () => {
    const r = postFilterResult(items, ['table'], '', { stmtKind: 'DDL', aspect: 'index' });
    expect(r.items.map((i) => i.id)).toEqual(['table:users:s1']);
  });

  it('DML × INDEX 组合：空结果（数据行非索引语句）+ 空 stats', () => {
    const r = postFilterResult(items, ['table'], '', { stmtKind: 'DML', aspect: 'index' });
    expect(r.items).toEqual([]);
    expect(r.stats.ALL).toBe(0);
    expect(r.stats.INDEX).toBe(0);
  });
});

describe('复制=所见：过滤后导出文本与列表逐行一致', () => {
  it('INDEX 过滤导出只含索引语句（头注释 changeType 不变）', () => {
    const base = compareRun(
      meta({ tables: { users: T_WITH_COL_AND_IDX } }),
      meta({ tables: { users: T_BASE } }),
    );
    const filtered = postFilterResult(base.items, ['table'], '', { aspect: 'index' });
    expect(filtered.items).toHaveLength(1);
    const text = toExportSql(filtered.items, { aName: 'A', bName: 'B', at: '2026-09-22T00:00:00.000Z' });
    // 头注释行以 -- 开头；内容行必须且仅为索引语句。
    const body = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('--'));
    expect(body).toEqual(['ALTER TABLE `users` ADD INDEX `idx_name` (`name`);']);
    expect(text).toContain('-- [CHANGE] table users');
    expect(text).not.toContain('ADD COLUMN');
  });
});
