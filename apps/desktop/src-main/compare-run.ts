// M5 compare.run 主进程实现：nodes 元数据 -> 并发拉快照 -> core 对比 -> 历史落盘。
//
// 数据流（per design.md）：A/B 节点 -> 建池（直连 / ssh2 单跳隧道复用）
// -> fetchMetadata（information_schema + SHOW CREATE，限流 MAX_CONCURRENCY，表过滤只作用于表）
// -> scope 后过滤 -> compareRun（diffTable / diffProcedure + classify + risk 本地规则）
// -> tableFilter 展示过滤 -> history.append（最近 20 条）-> {items, stats}。
// 首版只读对比、不执行 SQL；失败抛结构化 Error（message 直显 UI）。

import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type {
  CompareRequest,
  CompareResult,
  DataTablePair,
  HistoryEntry,
  NodeMeta,
  SecretBundle,
} from '../src-core/types';
import { compareRun, sortDiffItems } from '../src-core/compare';
import {
  filterMetadataByScopes,
  hasDataScope,
  normalizeScopes,
  postFilterResult,
} from '../src-core/compare-filter';
import { createMysqlPool } from './connection';
import { runDataCompare } from './data-run';
import { fetchMetadata, MAX_CONCURRENCY } from './metadata';
import { appendHistory, loadNodes } from './store-json';
import type { Vault } from './vault';

export interface CompareRunContext {
  userDataDir: string;
  vault: Vault;
}

export interface CompareRunHooks {
  /** 数据对比逐表状态（main 转发 renderer 进度条用）。 */
  onTable?: (table: string, status: string, detail?: string) => void;
  onFetchProgress?: (table: string, side: 'A' | 'B', fetched: number, total: number) => void;
  signal?: AbortSignal;
}

// 纯函数过滤逻辑收敛到 src-core/compare-filter（主 + 渲染共享），此处重导出以保持引用兼容。
export { filterMetadataByScopes, normalizeScopes, postFilterResult };

function findNodeOrThrow(nodes: NodeMeta[], id: string, which: 'A' | 'B'): NodeMeta {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`compare: ${which} 槽节点不存在（${id}），请重新选择`);
  return node;
}

/**
 * compare.run 主入口（main.ts IPC 直调）。
 * - aId/bId 必填且不能相同；
 * - 建池后并发拉元数据，任一失败时先关池再抛错（隧道保留复用，不关）；
 * - scope 含 data（或 includeData）时追加数据对比：表映射缺省为同名交集（受 tableFilter 约束），
 *   数据 DiffItem（objectType:'data' + dml）与逐表状态合并进结果；
 * - 成功后 appendHistory（失败不阻塞返回，落盘异常直接忽略）。
 */
export async function runCompareRequest(
  req: CompareRequest,
  ctx: CompareRunContext,
  hooks: CompareRunHooks = {},
): Promise<CompareResult> {
  const aId = typeof req?.aId === 'string' ? req.aId : '';
  const bId = typeof req?.bId === 'string' ? req.bId : '';
  if (!aId || !bId) throw new Error('compare: 请先在 A / B 槽各放入一个节点');
  if (aId === bId) throw new Error('compare: A / B 不能是同一节点（交换方向请用 ⇄ 交换）');
  const scopes = normalizeScopes(req?.scopes);
  const tableFilter = typeof req?.tableFilter === 'string' ? req.tableFilter : '';
  const wantData = hasDataScope(req?.scopes, req?.includeData);

  const nodes = loadNodes(ctx.userDataDir);
  const nodeA = findNodeOrThrow(nodes, aId, 'A');
  const nodeB = findNodeOrThrow(nodes, bId, 'B');
  const secretA: SecretBundle = ctx.vault.getNodeSecret(aId) ?? {};
  const secretB: SecretBundle = ctx.vault.getNodeSecret(bId) ?? {};

  let poolA: Pool | null = null;
  let poolB: Pool | null = null;
  try {
    [poolA, poolB] = await Promise.all([createMysqlPool(nodeA, secretA), createMysqlPool(nodeB, secretB)]);
    const dbA = poolA as unknown as Parameters<typeof fetchMetadata>[0];
    const dbB = poolB as unknown as Parameters<typeof fetchMetadata>[0];
    const [rawA, rawB] = await Promise.all([
      fetchMetadata(dbA, nodeA.database, { tableFilter, concurrency: MAX_CONCURRENCY }),
      fetchMetadata(dbB, nodeB.database, { tableFilter, concurrency: MAX_CONCURRENCY }),
    ]);
    const filteredA = filterMetadataByScopes(rawA, scopes);
    const filteredB = filterMetadataByScopes(rawB, scopes);
    // compareRun 目标库用户名用于 DEFINER 归一（B 为待升级目标）。
    const base = compareRun(filteredA, filteredB, { targetUser: nodeB.user });
    const result = postFilterResult(base.items, scopes, tableFilter);

    if (wantData) {
      const pairs = resolveDataPairs(req, rawA.tables, rawB.tables);
      const data = await runDataCompare(aId, bId, pairs, {
        ctx,
        batchRows: req.dataOptions?.batchRows,
        insertBatch: req.dataOptions?.insertBatch,
        threshold: req.dataOptions?.threshold,
        confirmOverThreshold: req.dataOptions?.confirmOverThreshold,
        ddlCacheA: rawA.tables,
        ddlCacheB: rawB.tables,
        onTable: (t) => hooks.onTable?.(t.a === t.b ? t.a : `${t.a}→${t.b}`, t.status, t.message),
        onFetchProgress: hooks.onFetchProgress,
        signal: hooks.signal,
      });
      result.items.push(...data.items);
      result.items = sortDiffItems(result.items);
      result.stats.ALL += data.items.length;
      for (const it of data.items) {
        result.stats[it.changeType] += 1;
        if ((it.aspects ?? []).includes('index')) result.stats.INDEX += 1;
        if (it.dml) result.stats.DML[it.dml] += 1;
      }
      result.dataTables = data.tables;
    }

    const entry: HistoryEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      aAlias: nodeA.alias,
      bAlias: nodeB.alias,
      aId: nodeA.id,
      bId: nodeB.id,
      diffCount: result.stats.ALL,
    };
    try {
      appendHistory(ctx.userDataDir, entry);
    } catch {
      // 历史落盘失败不阻塞对比结果返回。
    }
    return result;
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error(`compare: 对比失败：${String(err)}`);
  } finally {
    await Promise.allSettled([poolA?.end(), poolB?.end()]);
  }
}

/**
 * 数据表映射：显式 dataTables 优先（过滤空行）；
 * 缺省为 A/B 同名交集（fetchMetadata 已按 tableFilter 裁剪表名，视图/例程不受影响）。
 */
export function resolveDataPairs(
  req: CompareRequest,
  tablesA: Record<string, string | null>,
  tablesB: Record<string, string | null>,
): DataTablePair[] {
  const manual = Array.isArray(req.dataTables)
    ? req.dataTables.filter((p) => p && typeof p.a === 'string' && p.a && typeof p.b === 'string' && p.b)
    : [];
  if (manual.length > 0) return manual.map((p) => ({ a: p.a, b: p.b }));
  const inB = new Set(Object.keys(tablesB));
  return Object.keys(tablesA)
    .filter((t) => inB.has(t))
    .sort((x, y) => x.localeCompare(y))
    .map((t) => ({ a: t, b: t }));
}
