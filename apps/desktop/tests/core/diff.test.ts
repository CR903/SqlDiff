// M4 单测：移植语义覆盖（表新增/缺列/改列/主键/索引增删；过程新增/删除/变更；视图 OR REPLACE；classify/risk；compare 组装排序）。
import { describe, expect, it } from 'vitest';
import type { DatabaseMetadata } from '../../src-main/metadata';
import { classify } from '../../src-core/classify';
import { compareRun, toExportSql } from '../../src-core/compare';
import {
  changeProcedure,
  diffProcedure,
  diffTable,
  diffTableField,
  filterField,
  filterProcedure,
  filterTable,
} from '../../src-core/diff';
import { assessRisk } from '../../src-core/risk';

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
    // 表条目语句级 id（含 :s<n> 后缀），例程保持原子 id。
    expect(r.items.map((i) => i.id)).toEqual(['procedure:p_old', 'table:users:s0', 'view:v1']);
    for (const item of r.items) {
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

// ---------------------------------------------------------------------------
// diffTableField 畸形输入边界（10-05-unit-test-gap-landing R6）
//
// 核心 diff 引擎，经 diffTable 间接覆盖；但**解析边界**（畸形 DDL / 空输入）
// 间接覆盖不到 —— diffTable 先过 asText + filterTable，早退化掉了。
// 刻意不补大而全的 DDL 语料：17 种 DdlOp 已由 classifyDdl 的测试覆盖，
// 那属于"追认历史覆盖"，是本仓库明确排除的低价值工作。
// 这里只锁一条：**畸形输入不抛，且返回可解析结果**。
// ---------------------------------------------------------------------------

describe('diffTableField 畸形输入不抛', () => {
  const T_MIN = ['CREATE TABLE `t` (', '  `id` int NOT NULL', ') ENGINE=InnoDB'].join('\n');
  const T_MIN_EXTRA = ['CREATE TABLE `t` (', '  `id` int NOT NULL', '  `v` varchar(8)', ')'].join('\n');

  it('两侧全空串 → 返回空串', () => {
    expect(diffTableField('t', '', '')).toBe('');
  });

  it('一侧空串（少于 3 行）→ 返回空串，不抛', () => {
    expect(diffTableField('t', T_MIN, '')).toBe('');
    expect(diffTableField('t', '', T_MIN)).toBe('');
  });

  it('纯空白输入 → 不抛且返回字符串', () => {
    const ws = '   \n\t\n  ';
    const out = diffTableField('t', ws, ws);
    expect(typeof out).toBe('string');
    expect(out).toBe('');
  });

  it('非 DDL 纯文本（无反引号行）→ 返回空串（识别不出列即无差异）', () => {
    const junk = 'hello world\nsecond line\nthird line';
    const out = diffTableField('t', junk, junk);
    expect(typeof out).toBe('string');
    expect(out).toBe('');
  });

  it('非 DDL 纯文本 vs 合法 DDL → 仍不抛，返回字符串', () => {
    const junk = 'hello world\nsecond line\nthird line';
    const out = diffTableField('t', junk, T_MIN);
    expect(typeof out).toBe('string');
    expect(out).toContain('ALTER TABLE');
  });

  it('残缺 SHOW CREATE（缺 ENGINE / 右括号行）→ 可解析出列差异', () => {
    const out = diffTableField('t', T_MIN_EXTRA, T_MIN);
    expect(typeof out).toBe('string');
    // 方向语义：t1=A（来源）、t2=B（待升级）→ t1 多出的列在 B 侧为 ADD
    expect(out).toContain('ALTER TABLE `t` ADD COLUMN `v` varchar(8)');
  });

  it('残缺输入（仅 CREATE 头 + 右括号）vs 合法 DDL → 不抛', () => {
    const stub = ['CREATE TABLE `t` (', ')'].join('\n');
    expect(() => diffTableField('t', stub, T_MIN)).not.toThrow();
    expect(typeof diffTableField('t', stub, T_MIN)).toBe('string');
  });

  it('缺 CREATE 头 → 首行内容不参与解析，不抛且返回字符串', () => {
    // 循环范围是 1..len-1（首行 CREATE 头、末行右括号均不解析）。
    // 首行换成注释后，`id` 仍落在可解析区 → 与 T_MIN 无差异 → 空串。
    const headerless = ['-- 缺 CREATE 头', '  `id` int NOT NULL', '  `v` varchar(8)'].join('\n');
    const out = diffTableField('t', headerless, T_MIN);
    expect(typeof out).toBe('string');
    expect(out).toBe('');
  });

  it('缺 CREATE 头但第 1 行有差异列 → 仍能生成 ALTER（证明解析不依赖首行形态）', () => {
    const headerless = ['-- 缺 CREATE 头', '  `v` varchar(8)', '  `w` int'].join('\n');
    const out = diffTableField('t', headerless, T_MIN);
    expect(typeof out).toBe('string');
    expect(out).toContain('ALTER TABLE `t` ADD COLUMN `v` varchar(8)');
  });

  it('仅两行（无列定义行）→ 少于 3 行直接返回空串', () => {
    expect(diffTableField('t', '`id` int NOT NULL\n`v` varchar(8)', T_MIN)).toBe('');
  });

  it('列定义行以逗号结尾 / 缺逗号混合 → 不抛', () => {
    const mixed = ['CREATE TABLE `t` (', '  `id` int NOT NULL', '  `v` varchar(8),', ')'].join('\n');
    expect(() => diffTableField('t', mixed, T_MIN)).not.toThrow();
    expect(typeof diffTableField('t', mixed, T_MIN)).toBe('string');
  });

  it('两侧相同的畸形输入 → 返回空串（无差异）', () => {
    expect(diffTableField('t', T_MIN, T_MIN)).toBe('');
  });

  it('表名为空串 → 不抛，语句仍以空名生成', () => {
    expect(() => diffTableField('', T_MIN_EXTRA, T_MIN)).not.toThrow();
    expect(typeof diffTableField('', T_MIN_EXTRA, T_MIN)).toBe('string');
  });

  it('表名含反引号（与 escapeDataIdent 不同：此处是 legacy 插值）→ 不抛', () => {
    expect(() => diffTableField('we`ird', T_MIN_EXTRA, T_MIN)).not.toThrow();
  });
});
