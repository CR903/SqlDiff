// 多次 preflight 历史对比 · 纯函数层（零运行时依赖，可单测、无 Electron 依赖）。
//
// - PreflightHistoryEntry：单次成功 run 的完整报告快照，按 (bId, database) 分组存放
//   （见 src-main/store-json.ts 的 preflight-history.json 读写）。
// - diffPreflight(a, b)：同一目标库任意两次报告的 diff —— verdict 变化 +
//   issues 新增 / 消失 / 等级变化三类。v1 旧报告（缺 summary）经 getSummary 回填后参与对比。
// - 本文件不碰 preflight.ts 的渲染/规则逻辑，只读 issues/inferences/unknowns/verdict/summary。

import { getSummary } from './preflight';
import type { PreflightIssue, PreflightReport, PreflightSummary } from './preflight-types';

/** 可参与对比的最小报告形状（v1 旧报告缺 summary，运行时经 getSummary 回填）。 */
export type DiffableReport = Pick<PreflightReport, 'issues' | 'inferences' | 'unknowns'> & {
  verdict?: PreflightReport['verdict'];
  summary?: PreflightSummary;
};

/** 单份历史快照：完整报告 + 定位键（同库约束：只有同 (bId, database) 才可比）。 */
export interface PreflightHistoryEntry {
  /** run id（`randomUUID`，与 compare 历史的 HistoryEntry.id 同源策略）。 */
  id: string;
  /** ISO 时间（取报告 checkedAt，保证与文件名时间戳一致）。 */
  at: string;
  bId: string;
  bAlias: string;
  database: string;
  schemaVersion: number;
  appVersion: string;
  /** 完整报告（含 summary；v1 旧文件读时回填，见 getSummary）。 */
  report: PreflightReport;
}

/** 同一 issue id 前后两次严重度不同。 */
export interface SeverityChange {
  id: string;
  from: PreflightIssue['severity'];
  to: PreflightIssue['severity'];
}

/** 两次报告的 diff 结果（纯数据，UI 只做展示）。 */
export interface PreflightDiff {
  /** 任一 summary 快照字段（decision/blocking/warnings/unknowns）变化即 true。 */
  verdictChanged: boolean;
  from: PreflightSummary;
  to: PreflightSummary;
  /** to 有、from 无（按 issue.id 比对）。 */
  addedIssues: PreflightIssue[];
  /** from 有、to 无。 */
  removedIssues: PreflightIssue[];
  /** 同 id 但 severity 不同。 */
  severityChanged: SeverityChange[];
}

/** 分组键：同库约束的唯一标识（跨组对比无意义，UI 直接禁用）。 */
export function historyGroupKey(e: Pick<PreflightHistoryEntry, 'bId' | 'database'>): string {
  return `${e.bId}\n${e.database}`;
}

/** 同组判定（供 UI 禁用跨组选择）。 */
export function sameHistoryGroup(
  a: Pick<PreflightHistoryEntry, 'bId' | 'database'>,
  b: Pick<PreflightHistoryEntry, 'bId' | 'database'>,
): boolean {
  return a.bId === b.bId && a.database === b.database;
}

/**
 * 对比同一目标库的任意两次报告。
 *
 * - verdict 变化：比较 getSummary 回填后的快照（v1 旧报告同样可传）；
 * - issues 三类：按 issue.id 精确比对（id 形如 `RULE_ID:subject`，跨 run 稳定）。
 * - 纯函数：不排序、不去重，按输入顺序返回（调用方决定展示顺序）。
 */
export function diffPreflight(a: DiffableReport, b: DiffableReport): PreflightDiff {
  const from = getSummary(a);
  const to = getSummary(b);
  const verdictChanged =
    from.decision !== to.decision ||
    from.blocking !== to.blocking ||
    from.warnings !== to.warnings ||
    from.unknowns !== to.unknowns;

  const aById = new Map(a.issues.map((i) => [i.id, i]));
  const bById = new Map(b.issues.map((i) => [i.id, i]));
  const addedIssues: PreflightIssue[] = [];
  const removedIssues: PreflightIssue[] = [];
  const severityChanged: SeverityChange[] = [];

  for (const [id, bi] of bById) {
    const ai = aById.get(id);
    if (!ai) {
      addedIssues.push(bi);
    } else if (ai.severity !== bi.severity) {
      severityChanged.push({ id, from: ai.severity, to: bi.severity });
    }
  }
  for (const [id, ai] of aById) {
    if (!bById.has(id)) removedIssues.push(ai);
  }

  return { verdictChanged, from, to, addedIssues, removedIssues, severityChanged };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIssue(v: unknown): v is PreflightIssue {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === 'string' &&
    (v.severity === 'block' || v.severity === 'warn') &&
    typeof v.title === 'string' &&
    typeof v.detail === 'string' &&
    Array.isArray(v.related) &&
    typeof v.recommendation === 'string'
  );
}

/** 历史条目守卫（读文件时过滤非法条目，不抛；report 至少含 issues 数组）。 */
export function isPreflightHistoryEntry(v: unknown): v is PreflightHistoryEntry {
  if (!isRecord(v)) return false;
  if (
    typeof v.id !== 'string' || v.id.length === 0 ||
    typeof v.at !== 'string' || v.at.length === 0 ||
    typeof v.bId !== 'string' || v.bId.length === 0 ||
    typeof v.bAlias !== 'string' ||
    typeof v.database !== 'string' || v.database.length === 0 ||
    typeof v.schemaVersion !== 'number' ||
    typeof v.appVersion !== 'string'
  ) {
    return false;
  }
  const r = v.report;
  if (!isRecord(r)) return false;
  if (!Array.isArray(r.issues) || !(r.issues as unknown[]).every(isIssue)) return false;
  // UI 直接读 report.verdict.level 展示行状态（preflight-history.tsx），缺 verdict 的
  // 脏条目必须在此过滤，否则渲染时崩溃；getSummary/diff 侧 verdict 可选，仅此处硬约束。
  if (!isRecord(r.verdict)) return false;
  const vd = r.verdict as Record<string, unknown>;
  if (
    (vd.level !== 'pass' && vd.level !== 'warn' && vd.level !== 'block' && vd.level !== 'unknown') ||
    typeof vd.blocking !== 'number' ||
    typeof vd.warnings !== 'number' ||
    typeof vd.unknowns !== 'number'
  ) {
    return false;
  }
  return true;
}
