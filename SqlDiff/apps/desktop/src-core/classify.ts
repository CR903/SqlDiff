// M4 分类器：SQL -> CREATE | DROP | CHANGE（per design.md 分类规则 + prd.md R4）。
//
// 规则：
// - 含 DROP TABLE | DROP PROCEDURE | DROP FUNCTION | DROP VIEW
//   | DROP INDEX | DROP COLUMN | DROP PRIMARY 一律 DROP；
// - 但 DROP 与 CREATE 同现（过程/函数 DROP+CREATE 重建）归 CHANGE；
// - CREATE OR REPLACE（视图变更）归 CHANGE；
// - 含 CREATE 且无 DROP 归 CREATE；
// - 其余（ALTER / CHANGE / ADD 等）归 CHANGE。

import type { ChangeType } from './types';

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
