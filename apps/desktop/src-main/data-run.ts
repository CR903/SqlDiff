// R3/R5 数据对比组装：按表跑 fetch + diff，组装 DiffItem（objectType:'data' + dml 三态）。
// - 无可用行身份（无 PK 且无全非空 UNIQUE）-> skipped:'no-pk'（只给行数差异 + 替代建议），不中断。
// - 有 PK 用 PK；无 PK 但两侧有同一全非空 UNIQUE -> 按该列集分页拼 key 跑 diff（explain 追加来源），不中断。
// - 两侧行身份不一致 -> error:'pk-mismatch'，不中断。
// - 超阈未确认 -> confirm-needed（UI 二次确认后重跑），不中断。
// - 拉取/比对异常 -> error，不中断；用户取消（ABORTED）则整体抛出。
// 全程只读：仅 SELECT + SHOW CREATE，生成的 DML 不执行。

import type { Pool } from 'mysql2/promise';
import { diffDataRows } from '../src-core/data-diff';
import { qualifyIdentity } from '../src-core/data-pk';
import type {
  ChangeType,
  DataTablePair,
  DataTableStatus,
  DiffItem,
  DmlStats,
  DmlType,
  NodeMeta,
  RiskLevel,
  SecretBundle,
} from '../src-core/types';
import { createMysqlPool } from './connection';
import { DataThresholdError, fetchAllByPK, getRowCount } from './data-fetch';
import { showCreateTable, type DbQueryable } from './metadata';
import { loadNodes } from './store-json';
import type { Vault } from './vault';

export interface DataRunContext {
  userDataDir: string;
  vault: Vault;
}

export interface DataRunOptions {
  batchRows?: number;
  insertBatch?: number;
  threshold?: number;
  confirmOverThreshold?: boolean;
  /** compare-run 传已拉的 SHOW CREATE 缓存（表名 -> DDL），缺失时本层实时 SHOW CREATE。 */
  ddlCacheA?: Record<string, string | null>;
  ddlCacheB?: Record<string, string | null>;
  /** 逐表状态回调（running/done/skipped/error，供 IPC 进度转发）。 */
  onTable?: (status: DataTableStatus) => void;
  /** 拉取进度回调（大表进度条用）。 */
  onFetchProgress?: (table: string, side: 'A' | 'B', fetched: number, total: number) => void;
  signal?: AbortSignal;
}

export interface DataRunResult {
  items: DiffItem[];
  tables: DataTableStatus[];
  stats: DmlStats;
}

const DML_CHANGE: Record<DmlType, ChangeType> = { INSERT: 'CREATE', DELETE: 'DROP', UPDATE: 'CHANGE' };
const DML_RISK: Record<DmlType, RiskLevel> = { INSERT: 'low', DELETE: 'medium', UPDATE: 'low' };
const DML_EXPLAIN: Record<DmlType, string> = {
  INSERT: '数据行仅 A 有：在 B 执行 INSERT 补齐（只读生成，未执行）',
  DELETE: '数据行仅 B 有：在 B 执行 DELETE 清理（只读生成，未执行，执行前请备份）',
  UPDATE: '同主键行列值不一致：在 B 执行 UPDATE 对齐（只列变更列，只读生成，未执行）',
};

function findNodeOrThrow(nodes: NodeMeta[], id: string, which: 'A' | 'B'): NodeMeta {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`data-compare: ${which} 槽节点不存在（${id}），请重新选择`);
  return node;
}

function displayName(a: string, b: string): string {
  return a === b ? a : `${a}→${b}`;
}

function makeItem(pair: DataTablePair, dml: DmlType, index: number, sql: string): DiffItem {
  return {
    id: `data:${pair.a}:${pair.b}:${dml}:${index}`,
    objectType: 'data',
    objectName: displayName(pair.a, pair.b),
    changeType: DML_CHANGE[dml],
    dml,
    stmtKind: 'DML',
    aspects: ['data'],
    risk: DML_RISK[dml],
    sql,
    explain: DML_EXPLAIN[dml],
  };
}

async function ddlOf(
  db: DbQueryable,
  cache: Record<string, string | null> | undefined,
  table: string,
): Promise<string | null> {
  if (cache && Object.prototype.hasOwnProperty.call(cache, table)) return cache[table];
  try {
    return await showCreateTable(db, table);
  } catch {
    return null;
  }
}

function isAbortErr(err: unknown): boolean {
  return (
    (err instanceof Error && (err as Error & { code?: string }).code === 'ABORTED') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/** 行身份标签（mismatch 报错用）：PK(id) / UNIQUE uk(email)。 */
function identityLabel(kind: 'pk' | 'unique', cols: string[], name: string | null): string {
  return kind === 'pk' ? `PK(${cols.join(',')})` : `UNIQUE${name ? ` ${name}` : ''}(${cols.join(',')})`;
}

export type IdentityDecision =
  /** 可比：cols 为分页拼 key 列集；viaUnique=true 时 DiffItem explain 追加 UNIQUE 来源。 */
  | { ok: true; cols: string[]; viaUnique: boolean; uniqueNote: string }
  /** 跳过：message 已组装精确理由（含可空列点名），调用方记 skipped:'no-pk'。 */
  | { ok: false; skipped: true; message: string }
  /** 两侧行身份不一致：调用方记 error:'pk-mismatch'。 */
  | { ok: false; skipped: false; message: string };

/**
 * 纯函数：两侧 DDL 行身份决策（R1 UNIQUE 等价，Q1=仅 NOT NULL）。
 * - 优先 PK；无 PK 时两侧同一全非空 UNIQUE 等价为行身份；
 * - 任一侧无资格 -> skipped（reason 点名可空列/无唯一键）；
 * - 两侧列集不一致 -> mismatch。
 */
export function decideIdentity(
  ddlA: string | null,
  ddlB: string | null,
  a: string,
  b: string,
): IdentityDecision {
  const idA = qualifyIdentity(ddlA);
  const idB = qualifyIdentity(ddlB);
  if (idA.kind === 'none' || idB.kind === 'none') {
    const missing = [
      idA.kind === 'none' ? `A.${a}（${idA.reason}）` : null,
      idB.kind === 'none' ? `B.${b}（${idB.reason}）` : null,
    ]
      .filter((x): x is string => x !== null)
      .join('、');
    return {
      ok: false,
      skipped: true,
      message:
        `${missing}：无可用行身份，已跳过行级 diff。` +
        `替代策略：加主键（或全列 NOT NULL 的 UNIQUE 键）后重跑，或按整行 hash 抽样核对。`,
    };
  }
  if (idA.cols.join('\0') !== idB.cols.join('\0')) {
    const labelA = identityLabel(idA.kind, idA.cols, idA.kind === 'unique' ? idA.name : null);
    const labelB = identityLabel(idB.kind, idB.cols, idB.kind === 'unique' ? idB.name : null);
    return {
      ok: false,
      skipped: false,
      message: `两侧行身份不一致（A: ${labelA} vs B: ${labelB}），无法按键比对`,
    };
  }
  const viaUnique = idA.kind === 'unique' || idB.kind === 'unique';
  return {
    ok: true,
    cols: idA.cols,
    viaUnique,
    uniqueNote: viaUnique ? `按UNIQUE(${idA.cols.join(',')})比对` : '',
  };
}

/** 单表跑 fetch + diff（抛 ABORTED 外的异常由调用方记 error）。 */
async function runSingleTable(
  dbA: DbQueryable,
  dbB: DbQueryable,
  pair: DataTablePair,
  opts: DataRunOptions,
  emit: (status: DataTableStatus) => void,
): Promise<{ items: DiffItem[]; status: DataTableStatus }> {
  const base: DataTableStatus = { a: pair.a, b: pair.b, status: 'running' };
  emit({ ...base });
  const items: DiffItem[] = [];

  const [ddlA, ddlB] = await Promise.all([
    ddlOf(dbA, opts.ddlCacheA, pair.a),
    ddlOf(dbB, opts.ddlCacheB, pair.b),
  ]);
  const decision = decideIdentity(ddlA, ddlB, pair.a, pair.b);
  if (!decision.ok && decision.skipped) {
    // R1：无可用行身份（无 PK、无全非空 UNIQUE、可空 UNIQUE）-> 跳过行级 diff，只给行数差异。
    const [countA, countB] = await Promise.all([
      getRowCount(dbA, pair.a).catch(() => undefined),
      getRowCount(dbB, pair.b).catch(() => undefined),
    ]);
    const status: DataTableStatus = {
      ...base,
      status: 'skipped',
      reason: 'no-pk',
      message: decision.message,
      ...(countA !== undefined ? { countA } : {}),
      ...(countB !== undefined ? { countB } : {}),
    };
    emit(status);
    return { items, status };
  }
  if (!decision.ok) {
    const status: DataTableStatus = {
      ...base,
      status: 'error',
      reason: 'pk-mismatch',
      message: decision.message,
    };
    emit(status);
    return { items, status };
  }

  const pk = decision.cols;
  const [rowsA, rowsB] = await Promise.all([
    fetchAllByPK(dbA, pair.a, pk, {
      batch: opts.batchRows,
      threshold: opts.threshold,
      confirm: opts.confirmOverThreshold,
      signal: opts.signal,
      onProgress: (fetched, total) => opts.onFetchProgress?.(displayName(pair.a, pair.b), 'A', fetched, total),
    }),
    fetchAllByPK(dbB, pair.b, pk, {
      batch: opts.batchRows,
      threshold: opts.threshold,
      confirm: opts.confirmOverThreshold,
      signal: opts.signal,
      onProgress: (fetched, total) => opts.onFetchProgress?.(displayName(pair.a, pair.b), 'B', fetched, total),
    }),
  ]);
  const diff = diffDataRows(rowsA, rowsB, pk, pair.b, opts.insertBatch);
  diff.inserts.forEach((sql, i) => items.push(makeItem(pair, 'INSERT', i, sql)));
  diff.deletes.forEach((sql, i) => items.push(makeItem(pair, 'DELETE', i, sql)));
  diff.updates.forEach((sql, i) => items.push(makeItem(pair, 'UPDATE', i, sql)));
  if (decision.viaUnique) {
    // UNIQUE 等价行身份：DiffItem 备注来源（只读备注，不改变 DML 语义）。
    for (const it of items) it.explain = `${it.explain}；${decision.uniqueNote}`;
  }
  const status: DataTableStatus = {
    ...base,
    status: 'done',
    countA: rowsA.length,
    countB: rowsB.length,
    insertCount: diff.inserts.length,
    deleteCount: diff.deletes.length,
    updateCount: diff.updates.length,
  };
  emit(status);
  return { items, status };
}

/**
 * 数据对比主入口（compare-run 在结构对比后调用）。
 * @param pairs 表映射（A 表 -> B 表，同名自动 + 手动改下拉由调用方组装）
 */
export async function runDataCompare(
  aId: string,
  bId: string,
  pairs: DataTablePair[],
  opts: DataRunOptions & { ctx: DataRunContext },
): Promise<DataRunResult> {
  const { ctx, ...rest } = opts;
  if (!aId || !bId) throw new Error('data-compare: 请先在 A / B 槽各放入一个节点');
  const cleanPairs = pairs.filter((p) => p?.a && p?.b);
  const tables: DataTableStatus[] = cleanPairs.map((p) => ({ a: p.a, b: p.b, status: 'pending' as const }));
  const items: DiffItem[] = [];
  const stats: DmlStats = { INSERT: 0, DELETE: 0, UPDATE: 0 };
  if (cleanPairs.length === 0) return { items, tables, stats };

  const nodes = loadNodes(ctx.userDataDir);
  const nodeA = findNodeOrThrow(nodes, aId, 'A');
  const nodeB = findNodeOrThrow(nodes, bId, 'B');
  const secretA: SecretBundle = ctx.vault.getNodeSecret(aId) ?? {};
  const secretB: SecretBundle = ctx.vault.getNodeSecret(bId) ?? {};

  let poolA: Pool | null = null;
  let poolB: Pool | null = null;
  try {
    [poolA, poolB] = await Promise.all([createMysqlPool(nodeA, secretA), createMysqlPool(nodeB, secretB)]);
    const dbA = poolA as unknown as DbQueryable;
    const dbB = poolB as unknown as DbQueryable;
    const emit = (s: DataTableStatus): void => {
      const idx = tables.findIndex((t) => t.a === s.a && t.b === s.b);
      if (idx >= 0) tables[idx] = s;
      rest.onTable?.(s);
    };
    // 逐表串行（大表内存峰值可控；失败表记 error 不中断，取消则整体抛出）。
    for (const pair of cleanPairs) {
      try {
        const r = await runSingleTable(dbA, dbB, pair, rest, emit);
        items.push(...r.items);
      } catch (err) {
        if (isAbortErr(err) || rest.signal?.aborted) throw err;
        if (err instanceof DataThresholdError) {
          const s: DataTableStatus = {
            a: pair.a,
            b: pair.b,
            status: 'confirm-needed',
            reason: 'over-threshold',
            message: `${err.message}（已跳过本表，其余表继续；UI 二次确认后重跑）`,
          };
          emit(s);
          continue;
        }
        const s: DataTableStatus = {
          a: pair.a,
          b: pair.b,
          status: 'error',
          reason: 'fetch-failed',
          message: err instanceof Error ? err.message : String(err),
        };
        emit(s);
      }
    }
  } finally {
    await Promise.allSettled([poolA?.end(), poolB?.end()]);
  }
  for (const it of items) {
    if (it.dml) stats[it.dml] += 1;
  }
  return { items, tables, stats };
}
