// R3/R5 数据对比组装：按表跑 fetch + diff，组装 DiffItem（objectType:'data' + dml 三态）。
// - 无主键表 -> skipped:'no-pk'（只给行数差异 + 加主键/整行 hash 建议），不中断。
// - 联合主键两侧不一致 -> error:'pk-mismatch'，不中断。
// - 超阈未确认 -> confirm-needed（UI 二次确认后重跑），不中断。
// - 拉取/比对异常 -> error，不中断；用户取消（ABORTED）则整体抛出。
// 全程只读：仅 SELECT + SHOW CREATE，生成的 DML 不执行。

import type { Pool } from 'mysql2/promise';
import { diffDataRows } from '../src-core/data-diff';
import { parseTablePK } from '../src-core/data-pk';
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
  const pkA = parseTablePK(ddlA);
  const pkB = parseTablePK(ddlB);
  if (!pkA || !pkB) {
    // R1：无主键/无唯一键表 -> 跳过行级 diff，只给行数差异 + 替代策略建议。
    const [countA, countB] = await Promise.all([
      getRowCount(dbA, pair.a).catch(() => undefined),
      getRowCount(dbB, pair.b).catch(() => undefined),
    ]);
    const missing = [!pkA ? `A.${pair.a}` : null, !pkB ? `B.${pair.b}` : null]
      .filter(Boolean)
      .join('、');
    const status: DataTableStatus = {
      ...base,
      status: 'skipped',
      reason: 'no-pk',
      message:
        `${missing} 无主键（SHOW CREATE 无 PRIMARY KEY）：已跳过行级 diff。` +
        `替代策略：加主键后重跑，或按整行 hash 抽样核对。`,
      ...(countA !== undefined ? { countA } : {}),
      ...(countB !== undefined ? { countB } : {}),
    };
    emit(status);
    return { items, status };
  }
  if (pkA.join('\0') !== pkB.join('\0')) {
    const status: DataTableStatus = {
      ...base,
      status: 'error',
      reason: 'pk-mismatch',
      message: `两侧主键不一致（A: ${pkA.join(',')} vs B: ${pkB.join(',')}），无法按键比对`,
    };
    emit(status);
    return { items, status };
  }

  const pk = pkA;
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
