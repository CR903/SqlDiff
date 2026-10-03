// 生产 Preflight v1 —— 只读采集器（Stage 2 of production-preflight）。
//
// 边界与原则：
// - 只读硬边界：只执行 SELECT / SHOW / @@ / information_schema，绝不出现
//   INSERT / UPDATE / DELETE / SET（不含 `CHARACTER SET` 短语） / `SELECT ... FOR UPDATE`。
// - 只读 SQL 复用 `DbQueryable`（`metadata.ts:19-21`）；错误分类复用
//   `classifyCoverageReason`（`metadata.ts:216`），避免重复实现 PERMISSION_ERRNOS / CODES。
// - 每个采集函数**永不抛错**：任何异常一律降级为 `PreflightUnknown`，让下游
//   `evaluateRules` 与 `buildPreflightReport` 仍能出报告（PRD §R4：不能用默认值
//   伪装为确定）。
// - Fact.key 约定与 Stage 1 rules 层对齐（见文件内 key 注释），Stage 1
//   的 `BIG_TABLE_COPY` / `READ_ONLY_TARGET` 等规则直接按这些 key 引用。
// - 授权原文不外流（同 grants.ts）：解析成结构化 `permissions.visibility` /
//   `permissions.reliable` 两条 fact，不携带 privilege 语句或用户主机名。
//   复用 `src-core/visibility.ts` 的 `parseGrantLines` + `visibilityFor`（PRD R2 要求，
//   避免与 compare-run 的授权盲区判定语义漂移），并复用 `grants.ts` 的
//   `SQL_SHOW_GRANTS` 常量。visibility 语义针对**目标库 B**（不是"任意库"）。

import { parseGrantLines, visibilityFor } from '../src-core/visibility';
import type {
  PreflightCategory,
  PreflightFact,
  PreflightFactSource,
  PreflightUnknown,
  PreflightUnknownReason,
} from '../src-core/preflight-types';
import { SQL_SHOW_GRANTS } from './grants';
import { classifyCoverageReason, rowsOf } from './metadata';
import type { DbQueryable } from './metadata';

/** 单批次采集输出：事实 + 无法判定项。 */
export interface CollectedFact {
  facts: PreflightFact[];
  unknowns: PreflightUnknown[];
}

export interface PreflightCollectHooks {
  signal?: AbortSignal;
  /** 每完成一类采集回调一次，供 UI 进度展示。 */
  onProgress?: (category: PreflightCategory, collected: number) => void;
}

/** information_schema 查询批大小：`table_name IN (?, ?, ...)` 每批 100。 */
const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// 内部工具（不导出）
// ---------------------------------------------------------------------------

/** ISO 时间戳。所有 Fact / Unknown 统一使用当前时间，不引入时钟漂移假设。 */
function nowIso(): string {
  return new Date().toISOString();
}

function makeFact(
  category: PreflightCategory,
  key: string,
  value: unknown,
  source: PreflightFactSource,
): PreflightFact {
  return { category, key, value, source, observedAt: nowIso() };
}

function makeUnknown(
  category: PreflightCategory,
  subject: string,
  reason: PreflightUnknownReason,
  attempt: string,
): PreflightUnknown {
  return { category, subject, reason, attempt, observedAt: nowIso() };
}

/** 把 classifyCoverageReason 的输出映射到 PreflightUnknownReason（aborted / object-missing 归入 query-failed）。 */
function reasonOf(err: unknown): PreflightUnknownReason {
  const r = classifyCoverageReason(err);
  return r === 'permission-denied' ? 'permission-denied' : 'query-failed';
}

/** 单元格数字归一：mysql2 可能返 number / string / Uint8Array；null/'' 归 null。 */
function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  // Buffer / Uint8Array（如 information_schema 中的 checksum 二进制）：按大端整数解析，
  // 保留可比较性但避免直接暴露二进制字节给 rules 层。
  if (typeof v === 'object' && v !== null && 'byteLength' in (v as object)) {
    const arr = v as Uint8Array;
    let n = 0;
    for (let i = 0; i < arr.length; i++) n = n * 256 + arr[i];
    return n;
  }
  return null;
}

/** 单元格字符串归一：空 / null / undefined → null。 */
function toStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * MySQL information_schema 返回大写列名（TABLE_NAME / TABLE_ROWS），
 * 但部分查询（如 SELECT @@version）返回小写。先用小写 key 访问，
 * 未命中则尝试大写，兼容两种情况。
 */
function cell(row: Record<string, unknown>, key: string): unknown {
  return row[key] ?? row[key.toUpperCase()];
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
  if (size < 1) return [arr.slice()];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function chunkPlaceholder(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

// ---------------------------------------------------------------------------
// Server：版本号 + SQL_MODE + 字符集 + 表名大小写等
// ---------------------------------------------------------------------------

const SERVER_FIELDS: ReadonlyArray<readonly [string, string]> = [
  // fact key 必须与 src-core/preflight-rules.ts 的 mysqlVersion(facts) 查询一致
  // （后者读 'server.mysql_version'，否则 BIG_TABLE_COPY / LARGE_TABLE_*
  // 等依赖 MySQL 版本的规则会因找不到版本而静默失效）。
  ['version', 'server.mysql_version'],
  ['version_comment', 'server.version_comment'],
  ['sql_mode', 'server.sql_mode'],
  ['innodb_file_per_table', 'server.innodb_file_per_table'],
  ['transaction_isolation', 'server.transaction_isolation'],
  ['lower_case_table_names', 'server.lower_case_table_names'],
  ['character_set_server', 'server.character_set_server'],
  ['collation_server', 'server.collation_server'],
];

export const SQL_SERVER =
  'SELECT VERSION() AS version, @@version_comment AS version_comment, ' +
  '@@sql_mode AS sql_mode, @@innodb_file_per_table AS innodb_file_per_table, ' +
  '@@transaction_isolation AS transaction_isolation, ' +
  '@@lower_case_table_names AS lower_case_table_names, ' +
  '@@character_set_server AS character_set_server, ' +
  '@@collation_server AS collation_server';

export async function collectServerFacts(
  db: DbQueryable,
  hooks?: PreflightCollectHooks,
): Promise<CollectedFact> {
  const facts: PreflightFact[] = [];
  const unknowns: PreflightUnknown[] = [];
  try {
    const rows = rowsOf(await db.query(SQL_SERVER));
    const row = rows[0];
    if (!row) {
      unknowns.push(makeUnknown('server', 'server.mysql_version', 'query-failed', SQL_SERVER));
    } else {
      for (const [field, key] of SERVER_FIELDS) {
        const v = row[field];
        facts.push(makeFact('server', key, v === undefined ? null : v, 'select-version'));
      }
    }
  } catch (err) {
    unknowns.push(makeUnknown('server', 'server.mysql_version', reasonOf(err), SQL_SERVER));
  }
  hooks?.onProgress?.('server', facts.length);
  return { facts, unknowns };
}

// ---------------------------------------------------------------------------
// Variables：InnoDB buffer pool / 连接 / 缓冲 / 报文大小等
// ---------------------------------------------------------------------------

const VARIABLES_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['innodb_buffer_pool_size', 'variables.innodb_buffer_pool_size'],
  ['max_connections', 'variables.max_connections'],
  ['tmp_table_size', 'variables.tmp_table_size'],
  ['sort_buffer_size', 'variables.sort_buffer_size'],
  ['thread_cache_size', 'variables.thread_cache_size'],
  ['innodb_page_size', 'variables.innodb_page_size'],
  ['max_allowed_packet', 'variables.max_allowed_packet'],
];

export const SQL_VARIABLES =
  'SELECT @@innodb_buffer_pool_size AS innodb_buffer_pool_size, ' +
  '@@max_connections AS max_connections, @@tmp_table_size AS tmp_table_size, ' +
  '@@sort_buffer_size AS sort_buffer_size, @@thread_cache_size AS thread_cache_size, ' +
  '@@innodb_page_size AS innodb_page_size, @@max_allowed_packet AS max_allowed_packet';

export async function collectVariablesFacts(
  db: DbQueryable,
  hooks?: PreflightCollectHooks,
): Promise<CollectedFact> {
  const facts: PreflightFact[] = [];
  const unknowns: PreflightUnknown[] = [];
  try {
    const rows = rowsOf(await db.query(SQL_VARIABLES));
    const row = rows[0];
    if (!row) {
      unknowns.push(makeUnknown('variables', 'variables', 'query-failed', SQL_VARIABLES));
    } else {
      for (const [field, key] of VARIABLES_FIELDS) {
        const v = row[field];
        facts.push(makeFact('variables', key, v === undefined ? null : v, 'select-sysvars'));
      }
    }
  } catch (err) {
    unknowns.push(makeUnknown('variables', 'variables', reasonOf(err), SQL_VARIABLES));
  }
  hooks?.onProgress?.('variables', facts.length);
  return { facts, unknowns };
}

// ---------------------------------------------------------------------------
// Tables：information_schema.tables 分批（每批 100）
// ---------------------------------------------------------------------------

const SQL_TABLE_PREFIX =
  'SELECT table_name, table_rows, data_length, index_length, data_free, ' +
  'engine, row_format, auto_increment, update_time, checksum ' +
  'FROM information_schema.tables WHERE table_schema = ? AND table_name IN (';

/** 拼接参数化 IN 列表：`IN (?, ?, ...)`。参数化防止表名注入。 */
function buildInSql(prefix: string, batchSize: number): string {
  return `${prefix}${chunkPlaceholder(batchSize)})`;
}

export async function collectTableFacts(
  db: DbQueryable,
  database: string,
  tables: readonly string[],
  hooks?: PreflightCollectHooks,
): Promise<CollectedFact> {
  const facts: PreflightFact[] = [];
  const unknowns: PreflightUnknown[] = [];
  if (tables.length === 0) {
    hooks?.onProgress?.('table', 0);
    return { facts, unknowns };
  }
  const batches = chunk(tables, BATCH_SIZE);
  for (const batch of batches) {
    const sql = buildInSql(SQL_TABLE_PREFIX, batch.length);
    const params: unknown[] = [database, ...batch];
    try {
      const rows = rowsOf(await db.query(sql, params));
      for (const row of rows) {
        const t = toStr(cell(row, 'table_name'));
        if (!t) continue;
        facts.push(
          makeFact('table', `table.${t}.rows`, toNumber(cell(row, 'table_rows')), 'information-schema.tables'),
        );
        facts.push(
          makeFact('table', `table.${t}.data_length`, toNumber(cell(row, 'data_length')), 'information-schema.tables'),
        );
        facts.push(
          makeFact(
            'table',
            `table.${t}.index_length`,
            toNumber(cell(row, 'index_length')),
            'information-schema.tables',
          ),
        );
        facts.push(
          makeFact('table', `table.${t}.data_free`, toNumber(cell(row, 'data_free')), 'information-schema.tables'),
        );
        facts.push(makeFact('table', `table.${t}.engine`, toStr(cell(row, 'engine')), 'information-schema.tables'));
        facts.push(
          makeFact('table', `table.${t}.row_format`, toStr(cell(row, 'row_format')), 'information-schema.tables'),
        );
        facts.push(
          makeFact(
            'table',
            `table.${t}.auto_increment`,
            toNumber(cell(row, 'auto_increment')),
            'information-schema.tables',
          ),
        );
        facts.push(
          makeFact(
            'table',
            `table.${t}.update_time`,
            toStr(cell(row, 'update_time')),
            'information-schema.tables',
          ),
        );
        facts.push(
          makeFact('table', `table.${t}.checksum`, toNumber(cell(row, 'checksum')), 'information-schema.tables'),
        );
      }
    } catch (err) {
      // 单批失败不中断整体：把该批的表标记为 Unknown，其余批次照常产出。
      unknowns.push(
        makeUnknown(
          'table',
          `tables.${database}#${batch.length}`,
          reasonOf(err),
          `${sql} (batch of ${batch.length})`,
        ),
      );
    }
  }
  hooks?.onProgress?.('table', facts.length);
  return { facts, unknowns };
}

// ---------------------------------------------------------------------------
// Indexes：information_schema.statistics（主键 + 索引） + key_column_usage（外键）
// ---------------------------------------------------------------------------

const SQL_INDEX_STATISTICS =
  'SELECT table_name, index_name, column_name, seq_in_index, non_unique ' +
  'FROM information_schema.statistics WHERE table_schema = ? AND table_name IN (';

const SQL_FOREIGN_KEYS =
  'SELECT table_name, constraint_name, column_name ' +
  'FROM information_schema.key_column_usage WHERE table_schema = ? AND referenced_table_name IS NOT NULL';

export async function collectIndexFacts(
  db: DbQueryable,
  database: string,
  tables: readonly string[],
  hooks?: PreflightCollectHooks,
): Promise<CollectedFact> {
  const facts: PreflightFact[] = [];
  const unknowns: PreflightUnknown[] = [];
  if (tables.length === 0) {
    hooks?.onProgress?.('index', 0);
    return { facts, unknowns };
  }

  // 按表聚合索引信息：MySQL 未指定 ORDER BY，按 (index_name, seq_in_index) 排序后再拼。
  const indexColumns = new Map<string, { cols: string[]; nonUnique: number | null; primary: boolean }>();

  for (const batch of chunk(tables, BATCH_SIZE)) {
    const sql = buildInSql(SQL_INDEX_STATISTICS, batch.length);
    const params: unknown[] = [database, ...batch];
    let rows: Array<Record<string, unknown>>;
    try {
      rows = rowsOf(await db.query(sql, params));
    } catch (err) {
      unknowns.push(
        makeUnknown(
          'index',
          `indexes.${database}#${batch.length}`,
          reasonOf(err),
          `${sql} (batch of ${batch.length})`,
        ),
      );
      continue;
    }
    for (const row of rows) {
      const t = toStr(cell(row, 'table_name'));
      const idx = toStr(cell(row, 'index_name'));
      if (!t || !idx) continue;
      const key = `table.${t}.indexes.${idx}.columns`;
      const meta = indexColumns.get(key) ?? { cols: [], nonUnique: null, primary: false };
      if (idx === 'PRIMARY') meta.primary = true;
      const nu = cell(row, 'non_unique');
      if (typeof nu === 'number') meta.nonUnique = nu;
      else if (typeof nu === 'string') {
        const n = Number(nu);
        if (Number.isFinite(n)) meta.nonUnique = n;
      }
      const col = toStr(cell(row, 'column_name'));
      if (col && !meta.cols.includes(col)) meta.cols.push(col);
      indexColumns.set(key, meta);
    }
  }

  // 每个 (table, index) 产出 3 条 fact：columns / non_unique / is_primary。
  // Key 形如 `table.<t>.indexes.<idx>.columns`；解析出 table 与 index。
  const perTable: Record<string, { primary: string[]; unique: string[] }> = {};
  for (const [key, meta] of indexColumns) {
    const m = /^table\.([^.]+)\.indexes\.(.+?)\.columns$/.exec(key);
    if (!m) continue;
    const t = m[1];
    const idx = m[2];
    perTable[t] ??= { primary: [], unique: [] };
    if (meta.primary) perTable[t].primary.push(idx);
    if (meta.nonUnique === 0) perTable[t].unique.push(idx);
    facts.push(makeFact('index', key, [...meta.cols], 'information-schema.statistics'));
    facts.push(
      makeFact(
        'index',
        `table.${t}.indexes.${idx}.non_unique`,
        meta.nonUnique ?? null,
        'information-schema.statistics',
      ),
    );
    facts.push(
      makeFact('index', `table.${t}.indexes.${idx}.is_primary`, meta.primary, 'information-schema.statistics'),
    );
  }
  for (const [t, agg] of Object.entries(perTable)) {
    facts.push(
      makeFact('index', `table.${t}.primary_indexes`, agg.primary, 'information-schema.statistics'),
    );
    facts.push(
      makeFact('index', `table.${t}.unique_indexes`, agg.unique, 'information-schema.statistics'),
    );
  }

  // 外键：库范围一次查询，再筛出用户传入的 tables。
  try {
    const rows = rowsOf(await db.query(SQL_FOREIGN_KEYS, [database]));
    for (const row of rows) {
      const t = toStr(cell(row, 'table_name'));
      const fk = toStr(cell(row, 'constraint_name'));
      if (!t || !fk || !tables.includes(t)) continue;
      facts.push(
        makeFact(
          'index',
          `table.${t}.foreign_keys.${fk}`,
          fk,
          'information-schema.key-column-usage',
        ),
      );
    }
  } catch (err) {
    unknowns.push(makeUnknown('index', `foreign_keys.${database}`, reasonOf(err), SQL_FOREIGN_KEYS));
  }

  hooks?.onProgress?.('index', facts.length);
  return { facts, unknowns };
}

// ---------------------------------------------------------------------------
// Replication：SHOW REPLICA STATUS → SHOW SLAVE STATUS 降级 + 只读系统变量
// ---------------------------------------------------------------------------

export const SQL_REPLICA_STATUS = 'SHOW REPLICA STATUS';
export const SQL_SLAVE_STATUS = 'SHOW SLAVE STATUS';
export const SQL_REPLICA_SYSVARS =
  'SELECT @@server_id AS server_id, @@read_only AS read_only, ' +
  '@@super_read_only AS super_read_only, @@log_bin AS log_bin, @@gtid_mode AS gtid_mode';

export async function collectReplicationFacts(
  db: DbQueryable,
  hooks?: PreflightCollectHooks,
): Promise<CollectedFact> {
  const facts: PreflightFact[] = [];
  const unknowns: PreflightUnknown[] = [];

  // 步骤 1：优先 SHOW REPLICA STATUS（MySQL 8.0.22+），失败降级 SHOW SLAVE STATUS（5.7 / 8.0.21-）。
  let statusSource: 'show-replica-status' | 'show-slave-status' | null = null;
  let statusRow: Record<string, unknown> | null = null;
  try {
    const rows = rowsOf(await db.query(SQL_REPLICA_STATUS));
    if (rows.length > 0) {
      statusSource = 'show-replica-status';
      statusRow = rows[0];
    }
  } catch {
    // 忽略，转降级路径。
  }
  if (statusSource === null) {
    try {
      const rows = rowsOf(await db.query(SQL_SLAVE_STATUS));
      if (rows.length > 0) {
        statusSource = 'show-slave-status';
        statusRow = rows[0];
      }
    } catch {
      // 两条都失败：不产 fact，只留一条 not-applicable。
    }
  }

  if (statusSource !== null) {
    // MySQL 8.0.22+ 字段名 Seconds_Behind_Source；5.7 是 Seconds_Behind_Master。
    // 兼容两版字段名：任一命中即取；两者都无 → null（下游按未知处理）。
    let sbm: unknown = null;
    if (statusRow !== null) {
      for (const k of ['Seconds_Behind_Source', 'Seconds_Behind_Master']) {
        if (statusRow[k] !== undefined && statusRow[k] !== null) {
          sbm = statusRow[k];
          break;
        }
      }
    }
    facts.push(
      makeFact('replication', 'replication.seconds_behind_master', toNumber(sbm), statusSource),
    );
    facts.push(makeFact('replication', 'replication.is_replica', true, statusSource));
  } else {
    unknowns.push(
      makeUnknown(
        'replication',
        'replication.status',
        'not-applicable',
        'SHOW REPLICA STATUS / SHOW SLAVE STATUS',
      ),
    );
  }

  // 步骤 2：只读系统变量（server.* key 与 Stage 1 rules 对齐）。
  // gtid_mode 归入 replication 类别（GTID 是复制语义），
  // fact key 与 preflight-rules.ts 的 ruleGtidMismatch 查询一致。
  try {
    const rows = rowsOf(await db.query(SQL_REPLICA_SYSVARS));
    const row = rows[0];
    if (!row) {
      unknowns.push(makeUnknown('server', 'server.server_id', 'query-failed', SQL_REPLICA_SYSVARS));
    } else {
      facts.push(makeFact('server', 'server.server_id', toNumber(row.server_id), 'select-sysvars'));
      facts.push(makeFact('server', 'server.read_only', toNumber(row.read_only), 'select-sysvars'));
      facts.push(
        makeFact('server', 'server.super_read_only', toNumber(row.super_read_only), 'select-sysvars'),
      );
      facts.push(makeFact('server', 'server.log_bin', toNumber(row.log_bin), 'select-sysvars'));
      facts.push(
        makeFact('replication', 'replication.gtid_mode', toStr(row.gtid_mode), 'select-sysvars'),
      );
    }
  } catch (err) {
    unknowns.push(makeUnknown('server', 'server.server_id', reasonOf(err), SQL_REPLICA_SYSVARS));
  }

  hooks?.onProgress?.('replication', facts.length);
  return { facts, unknowns };
}

// ---------------------------------------------------------------------------
// Grants：SHOW GRANTS FOR CURRENT_USER() → 结构化 visibility / reliable
// 复用 grants.ts 的 SQL_SHOW_GRANTS 常量；解析走 src-core/visibility.ts，
// 与 compare-run 的授权盲区判定共享同一套规则（PRD R2）。
// ---------------------------------------------------------------------------

/**
 * mysql2 对 `SHOW GRANTS` 返回的行只有一列，列名是动态的
 * （实测 5.7.18：`Grants for cov_limited@127.0.0.1`），因此不能按列名取值，
 * 逐行取第一个非空字符串单元即可。取不到字符串的行走空串 → parseGrantLines
 * 判为未识别 → reliable:false。
 *
 * 与 src-main/grants.ts 的 grantLine 语义相同；此处保留一份避免
 * preflight-collect 依赖 grants.ts 里的 assessVisibility（后者吞掉错误细节，
 * 无法产出 permission-denied Unknown）。
 */
function grantLine(row: Record<string, unknown>): string {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

export async function collectGrantFacts(
  db: DbQueryable,
  targetDatabase: string,
  hooks?: PreflightCollectHooks,
): Promise<CollectedFact> {
  const facts: PreflightFact[] = [];
  const unknowns: PreflightUnknown[] = [];

  let visibility: 'full' | 'partial';
  let reliable: boolean;
  try {
    const rows = rowsOf(await db.query(SQL_SHOW_GRANTS));
    const assessment = parseGrantLines(rows.map(grantLine));
    // visibilityFor 严格按**目标库**判定：库级 SELECT/ALL 才判 full，
    // 表级或非目标库授权一律 partial；reliable=false 一律 partial（收窄）。
    // 不做大小写不敏感匹配（Linux lower_case_table_names=0 下 Foo/foo 是两个库，
    // 匹配错误会产生假 full，进而漏出授权盲区）。
    reliable = assessment.reliable;
    visibility = visibilityFor(assessment, targetDatabase);
  } catch (err) {
    // 查询失败：reliable=false，visibility 收窄为 partial（不猜为 full）。
    reliable = false;
    visibility = 'partial';
    unknowns.push(makeUnknown('permissions', 'permissions.reliable', reasonOf(err), SQL_SHOW_GRANTS));
  }
  facts.push(makeFact('permissions', 'permissions.visibility', visibility, 'show-grants-for-current-user'));
  facts.push(makeFact('permissions', 'permissions.reliable', reliable, 'show-grants-for-current-user'));
  hooks?.onProgress?.('permissions', facts.length);
  return { facts, unknowns };
}
