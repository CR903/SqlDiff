// R3 数据比对：纯 TS 移植老 `mysqldiff:140-212` 语义（只读移植，不改 `mysqldiff/`）。
// 方向与结构对比一致：A=来源/期望，B=目标/待升级，生成“把 B 升级到 A”的 DML。
// 全程只读：只生成 INSERT/DELETE/UPDATE 文本，不执行。
//
// 老函数对照：
// - addslashes  <- mysqldiff:140-142
// - getDataPKV  <- mysqldiff:206-210（联合主键拼 key，\0 分隔）
// - diffData    <- mysqldiff:143-204（INSERT 多 VALUES / DELETE 按主键 / UPDATE 只列变更列）
//
// 与老逻辑的刻意差异（注释标出）：
// 1. INSERT 按 insertBatch 分批（默认 500 行一批），老逻辑整表拼一条，多表大库必爆内存/包超限。
// 2. NULL/undefined 生成 NULL 关键字；老代码 `'' + null` 会吐小写 `null`（MySQL 恰好兼容，
//    但 `undefined` 会吐非法字面量）。数字/布尔保持老语义原文拼接。
// 3. Date/Buffer 显式转义为字符串字面量（老代码靠隐式 toString，Buffer 会吐 "[object]" 乱码）。

import { DEFAULT_INSERT_BATCH } from './data-options';

/** 数据行（mysql2 RowDataPacket 形状：列名 -> 值）。 */
export type DataRow = Record<string, unknown>;

export interface DataDiffResult {
  /** INSERT INTO 多 VALUES 语句（每条至多 insertBatch 行）。 */
  inserts: string[];
  /** DELETE FROM 按主键（每行一条）。 */
  deletes: string[];
  /** UPDATE 只列变更列（每行一条，无变更列的行跳过）。 */
  updates: string[];
}

/** 老 addslashes:140-142 — 转义 \ " ' 与 \0。 */
export function addslashes(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- 老语义移植：\0 转义为 \\0（mysqldiff:140-142 原样）
  return String(value).replace(/[\\"']/g, '\\$&').replace(/\u0000/g, '\\0');
}

/** 标识符转义：反引号加倍（表名/列名进 SQL 前必经此函数）。 */
export function escapeDataIdent(name: string): string {
  return `\`${String(name).replace(/`/g, '``')}\``;
}

/** 老 getDataPKV:206-210 — 联合主键拼 key，列间 \0 分隔（列值经 String 化，null -> 'null' 与老一致）。 */
export function getDataPKV(row: DataRow, pk: readonly string[]): string {
  let v = '';
  for (const col of pk) v += `${String(row[col])}\0`;
  return v.length > 0 ? v.substring(0, v.length - 1) : v;
}

/** 值 -> SQL 字面量（见文件头差异说明 2/3）。 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') return `'${addslashes(value)}'`;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return Number.isFinite(Number(value)) ? String(value) : 'NULL';
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return 'NULL';
    const pad = (n: number): string => String(n).padStart(2, '0');
    return (
      `'${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
      `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}'`
    );
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return `'${addslashes(value.toString('utf8'))}'`;
  }
  return `'${addslashes(String(value))}'`;
}

/** `WHERE `a`=.. AND `b`=..`（主键等值，值取目标行；老 diffData:172-180 / :190-196 同语义）。 */
function pkWhere(tablePk: readonly string[], targetRow: DataRow): string {
  return tablePk.map((col) => `${escapeDataIdent(col)}=${sqlLiteral(targetRow[col])}`).join(' AND ');
}

function insertStatement(table: string, rows: DataRow[]): string {
  const cols = Object.keys(rows[0] ?? {});
  const values = rows
    .map((r) => `(${cols.map((c) => sqlLiteral(r[c])).join(',')})`)
    .join(',');
  return `INSERT INTO ${escapeDataIdent(table)} VALUES ${values};\n`;
}

/**
 * 行级 diff（老 diffData:143-204）。
 * - 仅 A 有 -> INSERT（多 VALUES，按 insertBatch 分批，默认 500）
 * - 仅 B 有 -> DELETE（按主键，每行一条）
 * - 双方有 -> UPDATE（只列变更列；`==` 宽松比对与老一致，数字/字符串同值不误报；无变更列跳过）
 */
export function diffDataRows(
  rowsA: readonly DataRow[],
  rowsB: readonly DataRow[],
  pk: readonly string[],
  table: string,
  insertBatch = DEFAULT_INSERT_BATCH,
): DataDiffResult {
  const batch = Number.isInteger(insertBatch) && insertBatch > 0 ? insertBatch : DEFAULT_INSERT_BATCH;
  const keys: string[] = [];
  const mapA = new Map<string, DataRow>();
  const mapB = new Map<string, DataRow>();
  for (const row of rowsA) {
    const k = getDataPKV(row, pk);
    if (!mapA.has(k)) keys.push(k);
    mapA.set(k, row);
  }
  for (const row of rowsB) {
    const k = getDataPKV(row, pk);
    if (!mapA.has(k) && !mapB.has(k)) keys.push(k);
    mapB.set(k, row);
  }

  const insertRows: DataRow[] = [];
  const deletes: string[] = [];
  const updates: string[] = [];
  for (const k of keys) {
    const d1 = mapA.get(k);
    const d2 = mapB.get(k);
    if (d1 && !d2) {
      insertRows.push(d1);
      continue;
    }
    if (!d1 && d2) {
      deletes.push(`DELETE FROM ${escapeDataIdent(table)} WHERE ${pkWhere(pk, d2)};\n`);
      continue;
    }
    if (!d1 || !d2) continue;
    // 双方有：只列变更列（老 diffData:184-196）。
    let setClause = '';
    for (const col of Object.keys(d1)) {
      if (d1[col] == d2[col]) continue; // 老语义宽松比对（1 == '1'），避免驱动类型差异误报 UPDATE
      setClause += `${escapeDataIdent(col)}=${sqlLiteral(d1[col])},`;
    }
    if (setClause.length === 0) continue;
    updates.push(
      `UPDATE ${escapeDataIdent(table)} SET ${setClause.substring(0, setClause.length - 1)} WHERE ${pkWhere(pk, d2)};\n`,
    );
  }

  const inserts: string[] = [];
  for (let i = 0; i < insertRows.length; i += batch) {
    inserts.push(insertStatement(table, insertRows.slice(i, i + batch)));
  }
  return { inserts, deletes, updates };
}
