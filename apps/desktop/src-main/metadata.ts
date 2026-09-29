// M3 元数据拉取：information_schema + SHOW CREATE，供 M4 diff 用。
//
// 与老语义保持一致（`mysqldiff/DB.js:78-101`）：
// - tables():  `... where table_schema=? and table_type='BASE TABLE'`（字段 tabName）
// - views():   `... where table_schema=? and table_type='VIEW'`（字段 viewName）
// - routines:  `parameters` 表去重（字段 parName/type），过程/函数以此拆分
// - showCreate*: SHOW CREATE TABLE/PROCEDURE/FUNCTION/VIEW 取对应 `Create X` 列
// 首版不做数据对比（R3-data deferred），故不移植 getData（limit 5000）。
//
// 并发限流：SHOW CREATE 全拉时用 mapWithLimit 限流（默认 MAX_CONCURRENCY=10，
// design.md 数据流约定），大库不打爆连接。

import type { CoverageReason, CoverageSkip, ObjectType } from '../src-core/types';

/** SHOW CREATE 并发上限（design.md：限流 10）。 */
export const MAX_CONCURRENCY = 10;

/** 元数据查询入口的最小形状：mysql2 pool/connection 或单测假对象。 */
export interface DbQueryable {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

export interface RoutineInfo {
  name: string;
  kind: 'PROCEDURE' | 'FUNCTION';
}

/** M4 diff 的输入快照：name → CREATE 语句（拉取失败/无权限时为 null，M4 跳过）。 */
export interface DatabaseMetadata {
  tables: Record<string, string | null>;
  views: Record<string, string | null>;
  procedures: Record<string, string | null>;
  functions: Record<string, string | null>;
}

/**
 * fetchMetadata 的并列返回：结构快照 + 未取到 SHOW CREATE 的对象明细。
 * `meta` 形状不变（null 跳过不变量，database-guidelines.md），
 * `skipped` 只是把原本静默的跳过显式化，不改变 diff 结果。
 */
export interface MetadataSnapshot {
  meta: DatabaseMetadata;
  skipped: CoverageSkip[];
}

export interface FetchMetadataOptions {
  /** 表名子串过滤（大小写不敏感，只作用于表；视图/例程全拉）。 */
  tableFilter?: string;
  /** SHOW CREATE 并发（默认 MAX_CONCURRENCY，<=0 或非整数时回落默认）。 */
  concurrency?: number;
}

// SQL 与老 DB.js:75/79/83 字面一致（大小写归一为空格分隔单行，便于单测断言）。
export const SQL_ROUTINES =
  'select distinct specific_name parName, routine_type type ' +
  'from information_schema.parameters where specific_schema=?';
export const SQL_TABLES =
  "select table_name tabName from information_schema.tables " +
  "where table_schema=? and table_type='BASE TABLE'";
export const SQL_VIEWS =
  "select table_name viewName from information_schema.tables " +
  "where table_schema=? and table_type='VIEW'";

/** 标识符转义：反引号加倍（SHOW CREATE 不走参数化，必经此函数）。 */
export function escapeIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/** mysql2 返回 [rows, fields] 元组，假对象可能直接返回 rows；统一解包。 */
export function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const arr = result as unknown;
  if (Array.isArray(arr) && Array.isArray(arr[0])) return arr[0] as Array<Record<string, unknown>>;
  if (Array.isArray(arr)) return arr as Array<Record<string, unknown>>;
  return [];
}

function firstRowOf(result: unknown): Record<string, unknown> | null {
  const rows = rowsOf(result);
  return rows.length > 0 ? rows[0] : null;
}

function strCell(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** 表名列表（BASE TABLE）。 */
export async function listTables(db: DbQueryable, database: string): Promise<string[]> {
  const rows = rowsOf(await db.query(SQL_TABLES, [database]));
  const names: string[] = [];
  for (const r of rows) {
    const name = strCell(r, 'tabName', 'TABNAME', 'table_name', 'TABLE_NAME');
    if (name) names.push(name);
  }
  return names;
}

/** 视图名列表。 */
export async function listViews(db: DbQueryable, database: string): Promise<string[]> {
  const rows = rowsOf(await db.query(SQL_VIEWS, [database]));
  const names: string[] = [];
  for (const r of rows) {
    const name = strCell(r, 'viewName', 'VIEWNAME', 'table_name', 'TABLE_NAME');
    if (name) names.push(name);
  }
  return names;
}

/** 例程名列表（parameters 表去重；kind 只保留 PROCEDURE/FUNCTION 并大写归一）。 */
export async function listRoutines(db: DbQueryable, database: string): Promise<RoutineInfo[]> {
  const rows = rowsOf(await db.query(SQL_ROUTINES, [database]));
  const out: RoutineInfo[] = [];
  for (const r of rows) {
    const name = strCell(r, 'parName', 'PARNAME', 'specific_name', 'SPECIFIC_NAME');
    const kindRaw = strCell(r, 'type', 'TYPE', 'routine_type', 'ROUTINE_TYPE');
    const kind = kindRaw ? kindRaw.toUpperCase() : '';
    if (!name) continue;
    if (kind !== 'PROCEDURE' && kind !== 'FUNCTION') continue;
    out.push({ name, kind });
  }
  return out;
}

async function showCreate(
  db: DbQueryable,
  keyword: 'TABLE' | 'PROCEDURE' | 'FUNCTION' | 'VIEW',
  column: 'Create Table' | 'Create Procedure' | 'Create Function' | 'Create View',
  name: string,
): Promise<string | null> {
  const row = firstRowOf(await db.query(`show create ${keyword} ${escapeIdent(name)}`));
  if (!row) return null;
  const v = row[column];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function showCreateTable(db: DbQueryable, table: string): Promise<string | null> {
  return showCreate(db, 'TABLE', 'Create Table', table);
}
export function showCreateProcedure(db: DbQueryable, proc: string): Promise<string | null> {
  return showCreate(db, 'PROCEDURE', 'Create Procedure', proc);
}
export function showCreateFunction(db: DbQueryable, func: string): Promise<string | null> {
  return showCreate(db, 'FUNCTION', 'Create Function', func);
}
export function showCreateView(db: DbQueryable, view: string): Promise<string | null> {
  return showCreate(db, 'VIEW', 'Create View', view);
}

// ---------------------------------------------------------------------------
// 并发限流（保序；limit<=0/非整数回落为串行，上限由调用方按需放大）
// ---------------------------------------------------------------------------

/**
 * 保序并发映射。limit 为 worker 数（>=1），fn 抛错时整体 reject（调用方如需容错
 * 请在 fn 内部 catch，fetchMetadata 即如此处理单对象 SHOW CREATE 失败）。
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const workerCount =
    Number.isInteger(limit) && limit > 0 ? limit : 1;
  const out = new Array<R>(items.length);
  if (items.length === 0) return out;
  let next = 0;
  const workers = new Array(Math.min(workerCount, items.length)).fill(null).map(async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// MySQL 权限类错误码（SHOW CREATE 阶段可观测的部分）。errno 与 mysql2 错误 code 双路匹配。
const PERMISSION_ERRNOS = new Set([1044, 1142, 1143, 1227, 1370]);
const PERMISSION_CODES = new Set([
  'ER_DBACCESS_DENIED_ERROR',
  'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR',
  'ER_SPECIFIC_ACCESS_DENIED_ERROR',
  'ER_PROCACCESS_DENIED_ERROR',
]);
// 对象在扫描与 SHOW CREATE 之间被删除。
const OBJECT_MISSING_ERRNOS = new Set([1146]);
const OBJECT_MISSING_CODES = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_TABLE_ERROR']);

function errCodes(err: unknown): { errno: number | null; code: string | null } {
  if (typeof err !== 'object' || err === null) return { errno: null, code: null };
  const e = err as { errno?: unknown; code?: unknown };
  const errno = typeof e.errno === 'number' ? e.errno : null;
  const code = typeof e.code === 'string' ? e.code : null;
  return { errno, code };
}

function isAbortLike(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; name?: unknown };
  return e.code === 'ABORTED' || e.name === 'AbortError';
}

/**
 * SHOW CREATE 抛错时的原因码（纯函数，便于单测）。
 * 只接受 catch 分支传回的 error：「查询成功但结果为 null」由 collect 直接记 object-missing，
 * 不经过此函数，因此不必用 `undefined` 表达"无错误"，也不会把 `Promise.reject(undefined)`
 * 误判成 object-missing。未识别形态一律降级 'unknown'，宁可少判不误判；
 * errno 与原始 message 不出此函数。
 */
export function classifyCoverageReason(err: unknown): CoverageReason {
  if (isAbortLike(err)) return 'aborted';
  const { errno, code } = errCodes(err);
  if (code !== null && PERMISSION_CODES.has(code)) return 'permission-denied';
  if (errno !== null && PERMISSION_ERRNOS.has(errno)) return 'permission-denied';
  if (code !== null && OBJECT_MISSING_CODES.has(code)) return 'object-missing';
  if (errno !== null && OBJECT_MISSING_ERRNOS.has(errno)) return 'object-missing';
  return 'unknown';
}

/** 单类对象的拉取结果：name → CREATE 文本（失败/无文本为 null）+ 未取到的明细。 */
interface CategorySnapshot {
  pairs: Array<readonly [string, string | null]>;
  skipped: CoverageSkip[];
}

/**
 * 拉全库元数据快照（M4 diff 输入）。
 * 单对象 SHOW CREATE 失败记 null，不中断整体（null 跳过不变量不变），
 * 同时把该对象及其原因码写入 `skipped`，让"权限盲区"不再等同于"无差异"。
 */
export async function fetchMetadata(
  db: DbQueryable,
  database: string,
  opts: FetchMetadataOptions = {},
): Promise<MetadataSnapshot> {
  const concurrency =
    typeof opts.concurrency === 'number' && Number.isInteger(opts.concurrency) && opts.concurrency > 0
      ? opts.concurrency
      : MAX_CONCURRENCY;
  const [tablesAll, views, routines] = await Promise.all([
    listTables(db, database),
    listViews(db, database),
    listRoutines(db, database),
  ]);
  const filter = (opts.tableFilter ?? '').trim().toLowerCase();
  const tables = filter ? tablesAll.filter((t) => t.toLowerCase().includes(filter)) : tablesAll;
  const procedures = routines.filter((r) => r.kind === 'PROCEDURE').map((r) => r.name);
  const functions = routines.filter((r) => r.kind === 'FUNCTION').map((r) => r.name);

  const collect = async (
    names: readonly string[],
    objectType: ObjectType,
    fetchOne: (name: string) => Promise<string | null>,
  ): Promise<CategorySnapshot> => {
    const skipped: CoverageSkip[] = [];
    // 保序收集（mapWithLimit 已保序），跳过明细与 pairs 同序，便于断言。
    const pairs = await mapWithLimit(names, concurrency, async (name): Promise<readonly [string, string | null]> => {
      let value: string | null = null;
      let reason: CoverageReason = 'object-missing';
      try {
        value = await fetchOne(name);
        // 返回 null = 查询成功但无可用文本（缺行/缺列/空串）→ object-missing。
        if (value === null) reason = 'object-missing';
      } catch (err) {
        reason = classifyCoverageReason(err);
      }
      if (value === null) skipped.push({ name, objectType, reason });
      return [name, value] as const;
    });
    return { pairs, skipped };
  };

  const [tablesR, viewsR, procR, funcR] = await Promise.all([
    collect(tables, 'table', (n) => showCreateTable(db, n)),
    collect(views, 'view', (n) => showCreateView(db, n)),
    collect(procedures, 'procedure', (n) => showCreateProcedure(db, n)),
    collect(functions, 'function', (n) => showCreateFunction(db, n)),
  ]);
  return {
    meta: {
      tables: Object.fromEntries(tablesR.pairs),
      views: Object.fromEntries(viewsR.pairs),
      procedures: Object.fromEntries(procR.pairs),
      functions: Object.fromEntries(funcR.pairs),
    },
    skipped: [...tablesR.skipped, ...viewsR.skipped, ...procR.skipped, ...funcR.skipped],
  };
}
