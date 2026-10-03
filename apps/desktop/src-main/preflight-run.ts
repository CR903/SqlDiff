// 生产 Preflight v1 · 编排层（Stage 3 of production-preflight）。
//
// 只负责：拿节点定义 + 凭据 → 建池 → 调 6 个只读采集器 → 合并 facts/unknowns
// → 对每条 DiffItem 生成 DDL Inference（或 Unknown） → 调 evaluateRules / buildPreflightReport
// → 序列化为 JSON + Markdown → 关闭池 → 返回 { fileName, content, verdictLevel }。
//
// 边界：
// - 本文件**不写 SQL 字面量**（SQL 全部收敛在 preflight-collect.ts）；
// - 不 import mysql2（通过 DbQueryable / PoolLike 抽象）；
// - 不 import fs / path / electron（appVersion 走 process.versions.electron，可 deps 注入覆盖）；
// - 全程不 throw（准备阶段除节点不存在外）；采集失败一律转 PreflightUnknown；
// - 支持 AbortSignal：每次采集前后检查，aborted 后跳过剩余采集但保留已完成结果；
// - finally 关闭池：Promise.allSettled，不因 end() 失败掩盖前面的结果。
//
// 硬边界（禁止出现，检查由 preflight-run.test.ts + 本目录 grep 硬约束共同保证）：
// - 不出现 `pool.query(diffItem.sql)` / `pool.execute(...)` / 任何执行 DiffItem.sql 的调用；
// - 不出现 `pt-online-schema-change` / `gh-ost` / `cut-over` 等外部工具字符串。

import type { DiffItem, NodeMeta, SecretBundle } from '../src-core/types';
import { classifyDdl, lookupOnlineDdl } from '../src-core/preflight-ddl';
import {
  buildPreflightReport,
  preflightFileNames,
  preflightToMarkdown,
  serializePreflight,
} from '../src-core/preflight';
import type {
  PreflightFact,
  PreflightInference,
  PreflightReport,
  PreflightUnknown,
} from '../src-core/preflight-types';
import { createMysqlPool } from './connection';
import {
  collectGrantFacts,
  collectIndexFacts,
  collectReplicationFacts,
  collectServerFacts,
  collectTableFacts,
  collectVariablesFacts,
  type PreflightCollectHooks,
} from './preflight-collect';
import type { DbQueryable } from './metadata';
import { loadNodes } from './store-json';

// ---------------------------------------------------------------------------
// 类型契约
// ---------------------------------------------------------------------------

/** Preflight 请求：renderer 已经把 items 过滤为 DDL 项（v1 只处理表级 DDL）。 */
export interface PreflightRequest {
  /** 目标库节点 id（B 侧）。 */
  bId: string;
  /** 待检查的 DDL 项（来自 CompareResult.items）。 */
  items: DiffItem[];
  /** B 侧别名（写入报告 targetAlias）。 */
  bAlias: string;
  /** B 侧数据库名（information_schema 查询用）。 */
  bDatabase: string;
  /** 阈值覆盖；缺省使用 DEFAULT_THRESHOLDS。 */
  thresholds?: { bigTableRows?: number; replicaLagSeconds?: number };
}

/** runPreflight 返回值：两个文件名 + 序列化内容 + verdict 等级。 */
export interface PreflightExportResult {
  jsonFileName: string;
  markdownFileName: string;
  jsonContent: string;
  markdownContent: string;
  verdictLevel: PreflightReport['verdict']['level'];
}

export interface PreflightRunHooks {
  /** 用户取消：每次采集前后检查一次。 */
  signal?: AbortSignal;
  /** 步骤级进度（step 名 + 0-1 进度）。 */
  onProgress?: (step: string, fraction: number) => void;
}

/** 编排层最小 pool 形状（query + end）。mysql2 Pool 与假实现都满足此形状。 */
export interface PreflightPoolLike {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  end: () => Promise<unknown>;
}

export type PreflightPoolFactory = (
  node: NodeMeta,
  secret: SecretBundle,
) => Promise<PreflightPoolLike | null>;

export interface PreflightRunDeps {
  /** 池工厂；缺省使用 createMysqlPool。测试可注入 fake。 */
  createPool?: PreflightPoolFactory;
  /** SecretBundle 提供方（nodeId -> 凭据）；缺省时使用空 SecretBundle。 */
  secretProvider?: (nodeId: string) => SecretBundle | null;
  /** 报告中的 appVersion；缺省使用 process.versions.electron ?? 'unknown'。 */
  appVersion?: string;
  /** 报告中的 checkedAt（ISO）；缺省使用 new Date().toISOString()，测试可注入固定值。 */
  checkedAt?: string;
}

export interface PreflightRunContext {
  userDataDir: string;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/** 默认池工厂：包装 createMysqlPool（Pool 结构上满足 PreflightPoolLike）。 */
function defaultPoolFactory(
  node: NodeMeta,
  secret: SecretBundle,
): Promise<PreflightPoolLike | null> {
  return createMysqlPool(node, secret) as unknown as Promise<PreflightPoolLike | null>;
}

/**
 * 从 DiffItem.sql 中提取目标表名（推荐正则路径）。
 * 覆盖 ALTER / CREATE / DROP TABLE，以及 CREATE INDEX / DROP INDEX ... ON <tbl>。
 * 都失败时回落到 objectName（对 table objectType 就是表名）。
 */
const TABLE_NAME_RE =
  /(?:ALTER|CREATE|DROP|RENAME)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?`?([a-zA-Z_$][\w$]*)`?/i;
const ON_TABLE_RE = /\bON\s+`?([a-zA-Z_$][\w$]*)`?/i;

function extractTableNames(items: readonly DiffItem[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    if (item.objectType !== 'table') continue;
    const sql = typeof item.sql === 'string' ? item.sql : '';
    const m = TABLE_NAME_RE.exec(sql);
    if (m) {
      set.add(m[1]);
      continue;
    }
    const m2 = ON_TABLE_RE.exec(sql);
    if (m2) {
      set.add(m2[1]);
      continue;
    }
    if (typeof item.objectName === 'string' && item.objectName.length > 0) {
      set.add(item.objectName);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** 最小未知报告：池创建失败时使用；仅一条 unknown，让 verdict='unknown' 落地。 */
function buildNoPoolReport(params: {
  targetAlias: string;
  targetDatabase: string;
  appVersion: string;
  checkedAt: string;
  items: DiffItem[];
}): PreflightReport {
  const unknowns: PreflightUnknown[] = [
    {
      category: 'server',
      subject: 'target.pool',
      reason: 'query-failed',
      attempt: 'createMysqlPool',
      observedAt: params.checkedAt,
    },
  ];
  return buildPreflightReport({
    report: { facts: [], inferences: [], unknowns },
    items: params.items,
    targetAlias: params.targetAlias,
    targetDatabase: params.targetDatabase,
    appVersion: params.appVersion,
    checkedAt: params.checkedAt,
  });
}

/** 序列化 + 文件名一次做完，返回值同时满足主流程和"无池"降级路径。 */
function exportBundle(report: PreflightReport): PreflightExportResult {
  return {
    jsonFileName: preflightFileNames(report.checkedAt).jsonFileName,
    markdownFileName: preflightFileNames(report.checkedAt).markdownFileName,
    jsonContent: serializePreflight(report),
    markdownContent: preflightToMarkdown(report),
    verdictLevel: report.verdict.level,
  };
}

// ---------------------------------------------------------------------------
// runPreflight 主入口
// ---------------------------------------------------------------------------

/**
 * 主流程：
 * 1. 拿节点元数据与凭据（loadNodes + secretProvider）；
 * 2. 建池（deps.createPool ?? defaultPoolFactory），失败 → 最小未知报告；
 * 3. 从 items 里提取目标表清单；
 * 4. 并发采集 server / variables / grants / replication（Promise.allSettled）；
 * 5. 串行采集 tables → indexes（tables 依赖 items，indexes 复用同一表清单）；
 * 6. 对每条 table objectType 的 item 生成 DDL Inference 或 Unknown；
 * 7. buildPreflightReport + serialize + 文件名；
 * 8. finally 关闭池（Promise.allSettled，不因 end 失败掩盖结果）。
 *
 * 全程不 throw（准备阶段除节点不存在外）；采集失败转 PreflightUnknown；
 * signal.aborted 后跳过剩余采集但保留已完成结果。
 */
export async function runPreflight(
  req: PreflightRequest,
  ctx: PreflightRunContext,
  hooks: PreflightRunHooks = {},
  deps: PreflightRunDeps = {},
): Promise<PreflightExportResult> {
  const appVersion = deps.appVersion ?? process.versions.electron ?? 'unknown';
  const checkedAt = deps.checkedAt ?? nowIso();

  // --- 准备：拿节点元数据与凭据 ---
  const nodes = loadNodes(ctx.userDataDir);
  const node = nodes.find((n) => n.id === req.bId);
  if (!node) throw new Error(`preflight: 目标节点不存在（${req.bId}），请重新选择`);
  const secret: SecretBundle = deps.secretProvider?.(req.bId) ?? {};

  // --- 提取目标表清单（v1 只用 information_schema 查表规模/索引） ---
  const tables = extractTableNames(req.items);

  const collectHooks: PreflightCollectHooks = { signal: hooks.signal };

  // --- 建池（失败 → 最小未知报告，不 throw） ---
  const factory: PreflightPoolFactory = deps.createPool ?? defaultPoolFactory;
  let pool: PreflightPoolLike | null = null;
  try {
    pool = await factory(node, secret);
  } catch {
    return exportBundle(
      buildNoPoolReport({
        targetAlias: req.bAlias,
        targetDatabase: req.bDatabase,
        appVersion,
        checkedAt,
        items: req.items,
      }),
    );
  }
  if (pool === null) {
    return exportBundle(
      buildNoPoolReport({
        targetAlias: req.bAlias,
        targetDatabase: req.bDatabase,
        appVersion,
        checkedAt,
        items: req.items,
      }),
    );
  }

  // 把 pool 收窄到 DbQueryable（用于 collect*Facts），保留 pool 引用用于 finally end()。
  const db: DbQueryable = {
    query: (sql, params) => pool.query(sql, params),
  };

  try {
    const facts: PreflightFact[] = [];
    const unknowns: PreflightUnknown[] = [];
    const inferences: PreflightInference[] = [];
    let aborted = false;

    // 检查取消；首次 abort 时写一条 query-failed Unknown。
    const checkAbort = (): boolean => {
      if (!hooks.signal?.aborted) return false;
      if (!aborted) {
        unknowns.push({
          category: 'server',
          subject: 'preflight.aborted',
          reason: 'query-failed',
          attempt: 'aborted by user',
          observedAt: nowIso(),
        });
        aborted = true;
      }
      return true;
    };

    // --- 阶段 4：并发采集 server / variables / grants / replication ---
    if (!checkAbort()) {
      hooks.onProgress?.('collect-server', 0.1);
      hooks.onProgress?.('collect-variables', 0.1);
      hooks.onProgress?.('collect-permissions', 0.1);
      hooks.onProgress?.('collect-replication', 0.1);
      const [serverR, varsR, grantsR, replR] = await Promise.allSettled([
        collectServerFacts(db, collectHooks),
        collectVariablesFacts(db, collectHooks),
        collectGrantFacts(db, collectHooks),
        collectReplicationFacts(db, collectHooks),
      ]);
      for (const r of [serverR, varsR, grantsR, replR]) {
        if (r.status === 'fulfilled') {
          facts.push(...r.value.facts);
          unknowns.push(...r.value.unknowns);
        } else {
          unknowns.push({
            category: 'server',
            subject: 'collect-parallel',
            reason: 'query-failed',
            attempt: 'Promise.allSettled rejected',
            observedAt: nowIso(),
          });
        }
      }
    }

    // --- 阶段 5：串行采集 tables → indexes（依赖同一表清单） ---
    if (!checkAbort()) {
      hooks.onProgress?.('collect-tables', 0.5);
      const tableR = await collectTableFacts(db, req.bDatabase, tables, collectHooks);
      facts.push(...tableR.facts);
      unknowns.push(...tableR.unknowns);
    }
    if (!checkAbort()) {
      hooks.onProgress?.('collect-indexes', 0.7);
      const indexR = await collectIndexFacts(db, req.bDatabase, tables, collectHooks);
      facts.push(...indexR.facts);
      unknowns.push(...indexR.unknowns);
    }

    // --- 阶段 6：为每条 table DDL 生成 Inference 或 Unknown ---
    if (!checkAbort()) {
      hooks.onProgress?.('classify-ddl', 0.85);
      const versionRow = facts.find((f) => f.key === 'server.version')?.value;
      const version = typeof versionRow === 'string' ? versionRow : '';

      for (const item of req.items) {
        // v1 只处理表级 DDL；数据 / 视图 / 例程跳过。
        if (item.objectType === 'data') continue;
        if (item.objectType === 'view') continue;
        if (item.objectType === 'procedure') continue;
        if (item.objectType === 'function') continue;

        const cls = classifyDdl(item.sql);
        if (cls.op === 'OTHER') {
          unknowns.push({
            category: 'ddl',
            subject: `diff-item:${item.id}`,
            reason: 'unparsed-ddl',
            attempt: item.sql.slice(0, 200),
            observedAt: nowIso(),
          });
          continue;
        }
        const online = version ? lookupOnlineDdl(cls.op, version) : null;
        if (!online) {
          unknowns.push({
            category: 'ddl',
            subject: `diff-item:${item.id}`,
            reason: 'unsupported-version',
            attempt: `lookupOnlineDdl(${cls.op}, ${version || '?'})`,
            observedAt: nowIso(),
          });
          continue;
        }

        // evidence 非空硬约束（Stage 1 check 报告约束）：
        // 至少包含 diff-item:<id>.sql + server.version；有 tableName 时再补一条。
        const evidence = [`diff-item:${item.id}.sql`, 'server.version'];
        if (cls.tableName) evidence.push(`table.${cls.tableName}`);
        if (evidence.length === 0) continue;

        inferences.push({
          category: 'ddl',
          subject: `diff-item:${item.id}`,
          statement: `${item.id}: ${cls.op} on ${cls.tableName ?? '?'} → ${online.algorithm}/${online.lockMode}${
            online.rebuildsTable ? ' (rebuild)' : ''
          }`,
          confidence: cls.confidence,
          evidence,
          ruleId: 'ONLINE_DDL_MATRIX',
        });
      }
    }

    // --- 阶段 7：构建报告 ---
    hooks.onProgress?.('build-report', 0.95);
    const report = buildPreflightReport({
      report: { facts, inferences, unknowns },
      items: req.items,
      targetAlias: req.bAlias,
      targetDatabase: req.bDatabase,
      appVersion,
      thresholds: {
        bigTableRows: req.thresholds?.bigTableRows,
        replicaLagSeconds: req.thresholds?.replicaLagSeconds,
      },
      checkedAt,
    });
    hooks.onProgress?.('done', 1.0);

    // --- 阶段 8：序列化 + 文件名 ---
    return exportBundle(report);
  } finally {
    // --- 阶段 9：finally 关闭池 ---
    // try/catch 兜底：pool.end() 抛错不能掩盖前面积累的返回值；
    // 单池 close 失败也不构成产品级错误（compare-run.ts 同口径）。
    try {
      await pool.end();
    } catch {
      // ignore
    }
  }
}
