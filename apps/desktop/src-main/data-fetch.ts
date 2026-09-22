// R2 数据读取：主键范围分页（替代老 `DB.js:102-105 getData` 的 `limit 5000` 全量拉内存）。
// M7 已验证 515+ 表，万级表必须分页否则 OOM。全程只读 SELECT，不执行 DML。
//
// - getRowCount: 单表行数（阈值判断用）。
// - fetchPageByPK: 主键范围分页（ORDER BY pk LIMIT N，复合主键用行构造器 `(a,b) > (?,?)`）。
// - fetchAllByPK: 整表分页拉取 + 进度回调 + AbortSignal 取消 + 超阈 THRESHOLD（需调用方二次确认）。
// - 无主键表由调用方（data-run）判 skip，本层 fetchPageByPK 要求 pk 非空（空则抛错，早失败）。

import type { DataRow } from '../src-core/data-diff';
import { DEFAULT_BATCH_ROWS, DEFAULT_ROW_THRESHOLD } from '../src-core/data-options';
import { escapeIdent, rowsOf, type DbQueryable } from './metadata';

/** 默认分页批量（R2：默认 1000，可配置；正典见 src-core/data-options）。 */
export { DEFAULT_BATCH_ROWS };
/** 默认单表行数阈值（R5：默认 10 万，超限需二次确认；正典见 src-core/data-options）。 */
export { DEFAULT_ROW_THRESHOLD };

/** 超阈错误（本层抛，调用方捕获后记 confirm-needed，由 UI 二次确认后重跑）。 */
export class DataThresholdError extends Error {
  readonly code = 'THRESHOLD';
  readonly table: string;
  readonly count: number;
  readonly threshold: number;
  constructor(table: string, count: number, threshold: number) {
    super(`表 ${table} 行数 ${count} 超过阈值 ${threshold}，需二次确认后对比`);
    this.name = 'DataThresholdError';
    this.table = table;
    this.count = count;
    this.threshold = threshold;
  }
}

function orderBy(pk: readonly string[]): string {
  return pk.map((c) => `${escapeIdent(c)} ASC`).join(', ');
}

/** 复合主键范围条件：`(a,b) > (?,?)`；单主键退化为 `` `id` > ? ``。 */
export function buildPkRangeWhere(pk: readonly string[]): string {
  if (pk.length === 1) return `${escapeIdent(pk[0])} > ?`;
  const cols = pk.map((c) => escapeIdent(c)).join(',');
  const holders = pk.map(() => '?').join(',');
  return `(${cols}) > (${holders})`;
}

function normBatch(batch: number | undefined): number {
  return Number.isInteger(batch) && (batch as number) > 0 ? (batch as number) : DEFAULT_BATCH_ROWS;
}

/** 单表行数（只读 COUNT(*)）。 */
export async function getRowCount(db: DbQueryable, table: string): Promise<number> {
  const rows = rowsOf(await db.query(`SELECT COUNT(*) AS cnt FROM ${escapeIdent(table)}`));
  const v = rows[0]?.['cnt'];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

export interface DataPage {
  rows: DataRow[];
  /** 末行主键值（本页为空时为 null，调用方结束分页）。 */
  nextKey: unknown[] | null;
}

/**
 * 主键范围分页取一页（ORDER BY pk LIMIT batch，keyset 方式，无 OFFSET 深翻页问题）。
 * @param lastKey 上一页末行主键值（第一页传 null，不带 WHERE 全表起读）
 */
export async function fetchPageByPK(
  db: DbQueryable,
  table: string,
  pk: readonly string[],
  lastKey: readonly unknown[] | null,
  batch = DEFAULT_BATCH_ROWS,
): Promise<DataPage> {
  if (pk.length === 0) throw new Error(`fetchPageByPK: 表 ${table} 缺少主键，无法范围分页`);
  const n = normBatch(batch);
  const where =
    lastKey && lastKey.length === pk.length ? ` WHERE ${buildPkRangeWhere(pk)}` : '';
  const sql = `SELECT * FROM ${escapeIdent(table)}${where} ORDER BY ${orderBy(pk)} LIMIT ${n}`;
  const params = lastKey && lastKey.length === pk.length ? [...lastKey] : [];
  const rows = rowsOf(await db.query(sql, params)) as DataRow[];
  if (rows.length === 0) return { rows: [], nextKey: null };
  return { rows, nextKey: pk.map((c) => rows[rows.length - 1][c]) };
}

export interface FetchAllOptions {
  batch?: number;
  /** 行数阈值（默认 DEFAULT_ROW_THRESHOLD）。 */
  threshold?: number;
  /** 已二次确认（true 则超阈也继续拉）。 */
  confirm?: boolean;
  signal?: AbortSignal;
  onProgress?: (fetched: number, total: number) => void;
}

function throwIfAborted(signal: AbortSignal | undefined, table: string): void {
  if (signal?.aborted) {
    const err = new Error(`表 ${table} 数据拉取已取消`);
    (err as Error & { code: string }).code = 'ABORTED';
    throw err;
  }
}

/** 整表分页拉取（keyset 循环 + 进度回调 + 取消 + 超阈保护）。 */
export async function fetchAllByPK(
  db: DbQueryable,
  table: string,
  pk: readonly string[],
  opts: FetchAllOptions = {},
): Promise<DataRow[]> {
  if (pk.length === 0) throw new Error(`fetchAllByPK: 表 ${table} 缺少主键，无法范围分页`);
  const n = normBatch(opts.batch);
  const threshold =
    Number.isInteger(opts.threshold) && (opts.threshold as number) > 0
      ? (opts.threshold as number)
      : DEFAULT_ROW_THRESHOLD;
  const total = await getRowCount(db, table);
  if (total > threshold && opts.confirm !== true) {
    throw new DataThresholdError(table, total, threshold);
  }
  const out: DataRow[] = [];
  let lastKey: readonly unknown[] | null = null;
  opts.onProgress?.(0, total);
  for (;;) {
    throwIfAborted(opts.signal, table);
    const page = await fetchPageByPK(db, table, pk, lastKey, n);
    if (page.rows.length === 0) break;
    out.push(...page.rows);
    lastKey = page.nextKey;
    opts.onProgress?.(out.length, total);
    if (page.rows.length < n) break;
  }
  return out;
}
