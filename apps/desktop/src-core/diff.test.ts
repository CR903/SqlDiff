// M4 单测：移植语义覆盖（表新增/缺列/改列/主键/索引增删；过程新增/删除/变更；视图 OR REPLACE；classify/risk；compare 组装排序）。
import { describe, expect, it } from 'vitest';
import type { DatabaseMetadata } from '../src-main/metadata';
import { classify } from './classify';
import { compareRun, toExportSql } from './compare';
import {
  changeProcedure,
  diffProcedure,
  diffTable,
  filterField,
  filterProcedure,
  filterTable,
} from './diff';
import { assessRisk } from './risk';

const T_USERS = [
  'CREATE TABLE `users` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  "  `name` varchar(64) NOT NULL COMMENT 'x',",
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

const T_USERS_NO_COMMENT = [
  'CREATE TABLE `users` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

const T_USERS_WITH_AGE = [
  'CREATE TABLE `users` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  '  `age` int(11) DEFAULT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

const T_USERS_NAME_128 = [
  'CREATE TABLE `users` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(128) NOT NULL,',
  '  PRIMARY KEY (`id`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

const T_USERS_PK2 = [
  'CREATE TABLE `users` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  '  PRIMARY KEY (`id`,`name`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

const T_USERS_IDX = [
  'CREATE TABLE `users` (',
  '  `id` int(11) NOT NULL AUTO_INCREMENT,',
  '  `name` varchar(64) NOT NULL,',
  '  PRIMARY KEY (`id`),',
  '  KEY `idx_name` (`name`)',
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8',
].join('\n');

const PROC_V1 =
  'CREATE DEFINER=`root`@`localhost` PROCEDURE `p1`() BEGIN SELECT 1; END';
const PROC_V1_OTHER_DEFINER =
  'CREATE DEFINER=`app`@`%` PROCEDURE `p1`() BEGIN SELECT 1; END';
const PROC_V2 =
  'CREATE DEFINER=`root`@`localhost` PROCEDURE `p1`() BEGIN SELECT 2; END';

const VIEW_V1 = 'CREATE DEFINER=`root`@`localhost` VIEW `v1` AS SELECT 1 AS `a`';
const VIEW_V2 = 'CREATE DEFINER=`root`@`localhost` VIEW `v1` AS SELECT 2 AS `a`';

describe('filter 系与老一致', () => {
  it('filterField 忽略 COMMENT 两种写法', () => {
    expect(filterField("`name` varchar(64) NOT NULL COMMENT 'x'")).toBe(
      '`name` varchar(64) NOT NULL',
    );
    expect(filterField('`name` varchar(64) NOT NULL COMMENT=\'x\'')).toBe(
      '`name` varchar(64) NOT NULL',
    );
    expect(filterField('')).toBe('');
    expect(filterField(null)).toBe('');
  });

  it('filterTable 忽略 AUTO_INCREMENT（仅该项不同判无差异）', () => {
    const withAI = `${T_USERS} AUTO_INCREMENT=100 `;
    const withoutAI = T_USERS;
    expect(filterTable(withAI)).toBe(filterTable(withoutAI));
    expect(diffTable('users', withAI, withoutAI)).toBeNull();
  });

  it('仅 COMMENT 不同判无差异', () => {
    expect(diffTable('users', T_USERS, T_USERS_NO_COMMENT)).toBeNull();
  });

  it('filterProcedure 归一 DEFINER 后相等', () => {
    expect(filterProcedure(PROC_V1)).toBe(filterProcedure(PROC_V1_OTHER_DEFINER));
  });
});

describe('diffTable 表结构', () => {
  it('表新增：仅 A 有 -> 返回 CREATE 原文', () => {
    const sql = diffTable('orders', T_USERS, '');
    expect(sql).toBe(`${T_USERS};\n`);
    expect(classify(sql as string)).toBe('CREATE');
  });

  it('表删除：仅 B 有 -> DROP TABLE', () => {
    const sql = diffTable('orders', '', T_USERS);
    expect(sql).toBe('DROP TABLE `orders`;\n');
    expect(classify(sql as string)).toBe('DROP');
  });

  it('缺列：A 多一列 -> ADD COLUMN', () => {
    const sql = diffTable('users', T_USERS_WITH_AGE, T_USERS_NO_COMMENT);
    expect(sql).toContain('ADD COLUMN `age`');
    expect(classify(sql as string)).toBe('CHANGE');
  });

  it('删列：B 多一列 -> DROP COLUMN', () => {
    const sql = diffTable('users', T_USERS_NO_COMMENT, T_USERS_WITH_AGE);
    expect(sql).toContain('DROP COLUMN `age`');
    expect(classify(sql as string)).toBe('DROP');
  });

  it('改列：同列定义不同 -> CHANGE COLUMN', () => {
    const sql = diffTable('users', T_USERS_NAME_128, T_USERS_NO_COMMENT);
    expect(sql).toContain('CHANGE COLUMN `name`');
  });

  it('主键变更 -> DROP PRIMARY KEY,ADD PRIMARY KEY', () => {
    const sql = diffTable('users', T_USERS_PK2, T_USERS_NO_COMMENT);
    expect(sql).toContain('DROP PRIMARY KEY,ADD PRIMARY KEY');
  });

  it('索引新增 -> ADD INDEX', () => {
    const sql = diffTable('users', T_USERS_IDX, T_USERS_NO_COMMENT);
    expect(sql).toContain('ADD INDEX `idx_name`');
  });

  it('索引删除 -> DROP INDEX', () => {
    const sql = diffTable('users', T_USERS_NO_COMMENT, T_USERS_IDX);
    expect(sql).toContain('DROP INDEX `idx_name`');
  });
});

describe('diffProcedure 过程/视图', () => {
  it('过程新增：仅 A 有 -> DELIMITER 包裹 CREATE', () => {
    const sql = diffProcedure('p1', PROC_V1, '', 'PROCEDURE', 'root');
    expect(sql).toContain('DELIMITER ;;');
    expect(sql).toContain('CREATE');
    expect(sql).not.toContain('DROP PROCEDURE');
    expect(classify(sql as string)).toBe('CREATE');
  });

  it('过程删除：仅 B 有 -> DROP PROCEDURE', () => {
    const sql = diffProcedure('p1', '', PROC_V1, 'PROCEDURE');
    expect(sql).toBe('DROP PROCEDURE `p1`;\n');
    expect(classify(sql as string)).toBe('DROP');
  });

  it('过程变更：双方有且体不同 -> DROP+CREATE 合并，归 CHANGE', () => {
    const sql = diffProcedure('p1', PROC_V2, PROC_V1, 'PROCEDURE');
    expect(sql).toContain('DROP PROCEDURE `p1`;');
    expect(sql).toContain('CREATE');
    expect(classify(sql as string)).toBe('CHANGE');
  });

  it('仅 DEFINER 不同判无差异', () => {
    expect(diffProcedure('p1', PROC_V1, PROC_V1_OTHER_DEFINER, 'PROCEDURE')).toBeNull();
  });

  it('视图变更 -> CREATE OR REPLACE', () => {
    const sql = diffProcedure('v1', VIEW_V2, VIEW_V1, 'VIEW');
    expect(sql).toContain('CREATE OR REPLACE');
    expect(sql).not.toContain('DROP VIEW');
    expect(classify(sql as string)).toBe('CHANGE');
  });

  it('changeProcedure 新建时按 targetUser 改写 DEFINER 用户', () => {
    const out = changeProcedure(PROC_V1_OTHER_DEFINER, '', 'PROCEDURE', 'deployer');
    expect(out).toContain('DEFINER=`deployer`@');
    expect(changeProcedure(PROC_V1, '', 'PROCEDURE')).toBe(PROC_V1);
  });

  it('changeProcedure 双方有 -> 保留目标 DEFINER', () => {
    const out = changeProcedure(PROC_V2, PROC_V1_OTHER_DEFINER, 'PROCEDURE');
    expect(out).toContain('DEFINER=`app`@`%` PROCEDURE');
    expect(out).toContain('SELECT 2');
  });
});

describe('classify', () => {
  it('DROP TABLE -> DROP', () => {
    expect(classify('DROP TABLE `users`;')).toBe('DROP');
  });
  it('CREATE TABLE（无 DROP）-> CREATE', () => {
    expect(classify('CREATE TABLE `users` (`id` int);')).toBe('CREATE');
  });
  it('ALTER ADD COLUMN -> CHANGE；DROP+CREATE 重建 -> CHANGE；OR REPLACE -> CHANGE', () => {
    expect(classify('ALTER TABLE `users` ADD COLUMN `age` int;')).toBe('CHANGE');
    expect(classify('DROP PROCEDURE `p1`;\nDELIMITER ;;\nCREATE PROCEDURE `p1`() BEGIN SELECT 1; END')).toBe(
      'CHANGE',
    );
    expect(classify('CREATE OR REPLACE VIEW `v1` AS SELECT 1;')).toBe('CHANGE');
  });
});

describe('risk 本地规则', () => {
  it('DROP TABLE -> high，含备份提示与回滚占位', () => {
    const r = assessRisk('DROP TABLE `users`;', 'users');
    expect(r.risk).toBe('high');
    expect(r.explain).toContain('高危');
    expect(r.rollback).toContain('回滚占位');
    expect(`${r.explain}${r.rollback}`).toContain('备份');
  });
  it('DROP PROCEDURE -> medium', () => {
    const r = assessRisk('DROP PROCEDURE `p1`;');
    expect(r.risk).toBe('medium');
  });
  it('ADD COLUMN -> low', () => {
    const r = assessRisk('ALTER TABLE `users` ADD COLUMN `age` int;');
    expect(r.risk).toBe('low');
  });
});

describe('compareRun 组装/统计/排序', () => {
  function meta(over: Partial<DatabaseMetadata> = {}): DatabaseMetadata {
    return {
      tables: {},
      views: {},
      procedures: {},
      functions: {},
      ...over,
    };
  }

  it('空快照 -> 零条目', () => {
    const r = compareRun(meta(), meta());
    expect(r.items).toEqual([]);
    expect(r.stats).toEqual({ ALL: 0, CREATE: 0, DROP: 0, CHANGE: 0, INDEX: 0, DML: { INSERT: 0, DELETE: 0, UPDATE: 0 } });
  });

  it('组装：新增表 CREATE + 删除过程 DROP + 变更视图 CHANGE，统计与排序 DROP->CREATE->CHANGE', () => {
    const a = meta({
      tables: { users: T_USERS },
      procedures: {},
      views: { v1: VIEW_V2 },
    });
    const b = meta({
      tables: {},
      procedures: { p_old: PROC_V1 },
      views: { v1: VIEW_V1 },
    });
    const r = compareRun(a, b);
    expect(r.items).toHaveLength(3);
    expect(r.stats).toEqual({ ALL: 3, CREATE: 1, DROP: 1, CHANGE: 1, INDEX: 0, DML: { INSERT: 0, DELETE: 0, UPDATE: 0 } });
    expect(r.items.map((i) => i.changeType)).toEqual(['DROP', 'CREATE', 'CHANGE']);
    expect(r.items[0]?.objectName).toBe('p_old');
    expect(r.items[1]?.objectName).toBe('users');
    expect(r.items[2]?.objectName).toBe('v1');
    // 表条目语句级 id（含 :s<n> 后缀），例程保持原子 id；全量 DDL。
    expect(r.items.map((i) => i.id)).toEqual(['procedure:p_old', 'table:users:s0', 'view:v1']);
    for (const item of r.items) {
      expect(item.stmtKind).toBe('DDL');
      expect(item.aspects).toHaveLength(1);
      expect(item.explain).toBeTruthy();
    }
    expect(r.items[1]?.aspects).toEqual(['table']);
    expect(r.items[2]?.aspects).toEqual(['routine']);
    expect(r.items[0]?.rollback).toContain('回滚占位');
  });

  it('SHOW CREATE 失败（null）跳过，不误报 DROP/CREATE', () => {
    const a = meta({ tables: { users: null } });
    const b = meta({ tables: { users: T_USERS } });
    expect(compareRun(a, b).items).toEqual([]);
  });

  it('toExportSql 含头注释与顺序', () => {
    const a = meta({ tables: { users: T_USERS } });
    const b = meta({ tables: {} });
    const r = compareRun(a, b);
    const sql = toExportSql(r.items, { aName: 'A库', bName: 'B库', at: '2026-09-21T00:00:00.000Z' });
    expect(sql).toContain('A(来源): A库');
    expect(sql).toContain('B(目标): B库');
    expect(sql).toContain('CREATE TABLE `users`');
  });
});
