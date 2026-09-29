// M5 compare.run 主进程实现：nodes 元数据 -> 并发拉快照 -> core 对比 -> 历史落盘。
//
// 数据流（per design.md）：A/B 节点 -> 建池（直连 / ssh2 单跳隧道复用）
// -> fetchMetadata（information_schema + SHOW CREATE，限流 MAX_CONCURRENCY，表过滤只作用于表）
// + assessVisibility（SHOW GRANTS FOR CURRENT_USER()，并发执行）
// -> scope 后过滤 -> narrowToSharedVisibility（授权盲区收窄，见下）
// -> compareRun（diffTable / diffProcedure + classify + risk 本地规则）
// -> tableFilter 展示过滤 -> history.append（最近 20 条）-> {items, stats}。
// 首版只读对比、不执行 SQL；失败抛结构化 Error（message 直显 UI）。

import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type {
  CompareRequest,
  CompareResult,
  DataTablePair,
  ExcludedObject,
  HistoryEntry,
  NodeMeta,
  ObjectType,
  SecretBundle,
  StructureCoverage,
  VisibilityAssessment,
} from '../src-core/types';
import { compareRun, sortDiffItems } from '../src-core/compare';
import {
  filterMetadataByScopes,
  hasDataScope,
  normalizeScopes,
  postFilterResult,
} from '../src-core/compare-filter';
import { visibilityFor } from '../src-core/visibility';
import { createMysqlPool } from './connection';
import { runDataCompare } from './data-run';
import { assessVisibility } from './grants';
import {
  fetchMetadata,
  MAX_CONCURRENCY,
  type DatabaseMetadata,
  type MetadataSnapshot,
} from './metadata';
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

/**
 * 合并 A/B 结构覆盖报告。
 * - `ok`：两侧成功取到 SHOW CREATE 的对象数按类型累加（scopes 外的类别记 0，
 *   与 filterMetadataByScopes 的裁剪口径一致）。
 * - `skipped`：两侧明细合并，不标库侧 —— 跨库同名对象各记一条是保守表现，
 *   宁可提示"至少有一侧未检查"也不假装检查过。
 */
export function mergeCoverage(
  a: MetadataSnapshot,
  b: MetadataSnapshot,
  scopes: ObjectType[],
): StructureCoverage {
  const on = new Set<ObjectType>(scopes);
  const ok: Record<ObjectType, number> = { table: 0, view: 0, procedure: 0, function: 0 };
  for (const snap of [a, b]) {
    const m = snap.meta;
    if (on.has('table')) ok.table += countCreated(m.tables);
    if (on.has('view')) ok.view += countCreated(m.views);
    if (on.has('procedure')) ok.procedure += countCreated(m.procedures);
    if (on.has('function')) ok.function += countCreated(m.functions);
  }
  const skipped = [...a.skipped, ...b.skipped].filter((s) => on.has(s.objectType));
  return { ok, skipped };
}

function countCreated(map: Record<string, string | null>): number {
  let n = 0;
  for (const k of Object.keys(map)) if (map[k] !== null) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// 授权盲区收窄（假 DROP 归零）
// ---------------------------------------------------------------------------

/** 收窄结果：进入 compareRun 的 A/B 快照 + 被排除的单侧不可见对象 + 实际比较对象数。 */
export interface NarrowedVisibility {
  a: DatabaseMetadata;
  b: DatabaseMetadata;
  excluded: ExcludedObject[];
  /** 收窄后实际进入比较的对象总数（按类型 + 名称计数）。 */
  compared: number;
  /** 判据是否可靠（A/B 两侧都可靠才算可靠）。 */
  reliable: boolean;
}

/** ObjectType 单数 → DatabaseMetadata 复数字段（compareRun 内部同口径）。 */
const CATEGORY_KEYS: Array<{ type: ObjectType; key: keyof DatabaseMetadata }> = [
  { type: 'table', key: 'tables' },
  { type: 'view', key: 'views' },
  { type: 'procedure', key: 'procedures' },
  { type: 'function', key: 'functions' },
];

/**
 * 授权盲区收窄：可见性无法证明完整时，把比较范围收窄为 **A、B 双方都可见的对象集**。
 *
 * 为什么必须在 compareRun **之前**收窄：假 DROP 在 src-core/compare.ts:110-117 内生成
 * （missing 侧传空串 → diffTable 产出 DROP TABLE）。事后过滤 items 无法区分
 * 「真 DROP」与「A 侧只是看不见」的假 DROP，所以收窄只能做在输入侧。
 * compareRun 因此保持纯函数不变（它不该知道授权/可见性概念）。
 *
 * 触发条件：任一侧对其库的可见性 ≠ 'full'（表级授权 / 判据不可靠 / 库未出现在授权里）。
 * 两侧都 full 时逐字段返回原快照引用，行为与改动前完全一致（AC5）。
 *
 * 方向语义不变：仍是「A=来源 → B=待升级」，只是单侧不可见对象不再被当作
 * 「应删除 / 应新建」，改列为无法比较。
 */
export function narrowToSharedVisibility(
  filteredA: DatabaseMetadata,
  filteredB: DatabaseMetadata,
  visA: VisibilityAssessment,
  visB: VisibilityAssessment,
  databases: { a: string; b: string },
): NarrowedVisibility {
  const visOfA = visibilityFor(visA, databases.a);
  const visOfB = visibilityFor(visB, databases.b);
  const reliable = Boolean(visA?.reliable) && Boolean(visB?.reliable);
  // 两侧都可证明全量可见 → 不收窄，原样透传（保持既有用户输出不变）。
  if (visOfA === 'full' && visOfB === 'full') {
    return {
      a: filteredA,
      b: filteredB,
      excluded: [],
      compared: countCompared(filteredA, filteredB),
      reliable,
    };
  }
  const excluded: ExcludedObject[] = [];
  const a: DatabaseMetadata = { tables: {}, views: {}, procedures: {}, functions: {} };
  const b: DatabaseMetadata = { tables: {}, views: {}, procedures: {}, functions: {} };
  for (const { type, key } of CATEGORY_KEYS) {
    const inA = filteredA[key];
    const inB = filteredB[key];
    // 交集：两侧都可见才进入比较。
    for (const [name, v] of Object.entries(inA)) {
      if (Object.prototype.hasOwnProperty.call(inB, name)) {
        a[key][name] = v;
        b[key][name] = inB[name];
      } else {
        excluded.push({ name, objectType: type, side: 'a-only', reason: 'grant-invisible' });
      }
    }
    for (const name of Object.keys(inB)) {
      if (!Object.prototype.hasOwnProperty.call(inA, name)) {
        excluded.push({ name, objectType: type, side: 'b-only', reason: 'grant-invisible' });
      }
    }
  }
  return { a, b, excluded, compared: countCompared(a, b), reliable };
}

/** 实际进入比较的对象数：四类各自取 A∪B 的去重名数（与 mergeCoverage.ok 同口径）。 */
function countCompared(a: DatabaseMetadata, b: DatabaseMetadata): number {
  let n = 0;
  for (const { key } of CATEGORY_KEYS) {
    n += new Set([...Object.keys(a[key]), ...Object.keys(b[key])]).size;
  }
  return n;
}

function findNodeOrThrow(nodes: NodeMeta[], id: string, which: 'A' | 'B'): NodeMeta {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`compare: ${which} 槽节点不存在（${id}），请重新选择`);
  return node;
}

/**
 * compare.run 主入口（main.ts IPC 直调）。
 * - aId/bId 必填且不能相同；
 * - 建池后并发拉元数据，任一失败时先关池再抛错（隧道保留复用，不关）；
 * - 并发执行 SHOW GRANTS FOR CURRENT_USER() 判定可见性；无法证明完整时把结构比较
 *   收窄为 A/B 双方都可见的对象集，单侧不可见对象不产生 CREATE/DROP，改列 visibility.excluded；
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
    const [snapA, snapB, visA, visB] = await Promise.all([
      fetchMetadata(dbA, nodeA.database, { tableFilter, concurrency: MAX_CONCURRENCY }),
      fetchMetadata(dbB, nodeB.database, { tableFilter, concurrency: MAX_CONCURRENCY }),
      // 授权探针与元数据拉取并发（多一次往返，不串行拖慢比较）。只读当前用户自身授权。
      assessVisibility(dbA),
      assessVisibility(dbB),
    ]);
    const rawA = snapA.meta;
    const rawB = snapB.meta;
    const filteredA = filterMetadataByScopes(rawA, scopes);
    const filteredB = filterMetadataByScopes(rawB, scopes);
    // 授权盲区收窄：假 DROP 由 compare.ts:110-117 在 core 内生成（missing 侧传空串），
    // 事后过滤 items 无法区分真假，只能在输入侧收窄为双方可见交集。
    // 两侧都可证明全量可见时 narrowToSharedVisibility 原样透传，输出与改动前一致。
    const narrowed = narrowToSharedVisibility(filteredA, filteredB, visA, visB, {
      a: nodeA.database,
      b: nodeB.database,
    });
    // compareRun 目标库用户名用于 DEFINER 归一（B 为待升级目标）。
    const base = compareRun(narrowed.a, narrowed.b, { targetUser: nodeB.user });
    const result = postFilterResult(base.items, scopes, tableFilter);
    // 边界层显式标注来源（core 内无法判定）；覆盖报告在结构 diff 之后再附加，
    // 因为 postFilterResult 按 scopes/tableFilter 裁过 items。
    result.source = 'real';
    result.coverage = mergeCoverage(snapA, snapB, scopes);
    result.visibility = {
      excluded: narrowed.excluded,
      compared: narrowed.compared,
      reliable: narrowed.reliable,
    };

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
