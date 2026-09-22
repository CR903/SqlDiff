// M4 分类器：SQL -> CREATE | DROP | CHANGE（per design.md 分类规则 + prd.md R4）。
//
// 规则：
// - 含 DROP TABLE | DROP PROCEDURE | DROP FUNCTION | DROP VIEW
//   | DROP INDEX | DROP COLUMN | DROP PRIMARY 一律 DROP；
// - 但 DROP 与 CREATE 同现（过程/函数 DROP+CREATE 重建）归 CHANGE；
// - CREATE OR REPLACE（视图变更）归 CHANGE；
// - 含 CREATE 且无 DROP 归 CREATE；
// - 其余（ALTER / CHANGE / ADD 等）归 CHANGE。

import type { ChangeType, ObjectType, StmtAspect, StmtKind } from './types';

const RE_DROP = /\bDROP\s+(TABLE|PROCEDURE|FUNCTION|VIEW|INDEX|COLUMN|PRIMARY)\b/i;
const RE_CREATE = /\bCREATE\b/i;
const RE_CREATE_OR_REPLACE = /\bCREATE\s+OR\s+REPLACE\b/i;

/** 单条（或单对象多语句拼接）SQL 的变更类型。空串按 CHANGE 处理（调用方一般不传空）。 */
export function classify(sql: string): ChangeType {
  const text = sql ?? '';
  const hasDrop = RE_DROP.test(text);
  const hasCreate = RE_CREATE.test(text);
  if (hasDrop && hasCreate) return 'CHANGE';
  if (hasDrop) return 'DROP';
  if (RE_CREATE_OR_REPLACE.test(text)) return 'CHANGE';
  if (hasCreate) return 'CREATE';
  return 'CHANGE';
}

const RE_ASPECT_PRIMARY = /\bPRIMARY\s+KEY\b/i;
const RE_ASPECT_INDEX_ADD = /\bADD\s+(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(INDEX|KEY)\b/i;
const RE_ASPECT_INDEX_DROP = /\bDROP\s+(INDEX|KEY)\b/i;
const RE_ASPECT_COLUMN = /\b(ADD|DROP|CHANGE|MODIFY)\s+COLUMN\b/i;
const RE_ASPECT_TABLE = /\b(CREATE|DROP)\s+TABLE\b/i;

/** 对象类型 -> 语句维度：数据行 DML，其余 DDL。 */
export function stmtKindOf(objectType: ObjectType | 'data'): StmtKind {
  return objectType === 'data' ? 'DML' : 'DDL';
}

/**
 * R3 单语句切面判定（Q1：PRIMARY KEY 增删归 primary 不归 index；UNIQUE 归 index）。
 * 顺序：先整表（CREATE TABLE 体内含 PRIMARY KEY，不能先判 primary），
 * 再 primary（DROP+ADD PRIMARY KEY 合写单条仍归 primary），再 index / column。
 * `fallback` 给正则覆盖不到的语句（表内杂项 -> 'table'，例程 -> 'routine'，数据 -> 'data'）。
 */
export function aspectOf(stmt: string, fallback: StmtAspect = 'table'): StmtAspect {
  const text = stmt ?? '';
  if (RE_ASPECT_TABLE.test(text)) return 'table';
  if (RE_ASPECT_PRIMARY.test(text)) return 'primary';
  if (RE_ASPECT_INDEX_ADD.test(text) || RE_ASPECT_INDEX_DROP.test(text)) return 'index';
  if (RE_ASPECT_COLUMN.test(text)) return 'column';
  return fallback;
}
