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
  HistoryEntry,
  NodeMeta,
  SecretBundle,
} from '../src-core/types';
import { compareRun } from '../src-core/compare';
import {
  filterMetadataByScopes,
  normalizeScopes,
  postFilterResult,
} from '../src-core/compare-filter';
import { createMysqlPool } from './connection';
import { fetchMetadata, MAX_CONCURRENCY } from './metadata';
import { appendHistory, loadNodes } from './store-json';
import type { Vault } from './vault';

export interface CompareRunContext {
  userDataDir: string;
  vault: Vault;
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
 * - 成功后 appendHistory（失败不阻塞返回，落盘异常直接忽略）。
 */
export async function runCompareRequest(req: CompareRequest, ctx: CompareRunContext): Promise<CompareResult> {
  const aId = typeof req?.aId === 'string' ? req.aId : '';
  const bId = typeof req?.bId === 'string' ? req.bId : '';
  if (!aId || !bId) throw new Error('compare: 请先在 A / B 槽各放入一个节点');
  if (aId === bId) throw new Error('compare: A / B 不能是同一节点（交换方向请用 ⇄ 交换）');
  const scopes = normalizeScopes(req?.scopes);
  const tableFilter = typeof req?.tableFilter === 'string' ? req.tableFilter : '';

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
