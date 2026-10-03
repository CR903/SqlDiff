// 生产 Preflight v1 · 报告构建（纯函数，零运行时依赖）。
//
// - deriveVerdict：level 优先级 block > warn > unknown > pass，counts 直接统计。
// - buildPreflightReport：字段顺序严格与 PreflightReport 类型声明一致（byte 稳定）。
// - serializePreflight：JSON.stringify(m, null, 2) + '\n'（与 manifest 同一策略）。
// - preflightToMarkdown：头部 + 目标信息 + Facts（按 category 分组）+ Inferences
//   （含 evidence）+ Unknowns（含 reason）+ Issues（block 优先）+ Verdict + 保密声明。
// - preflightFileNames：文件名含 checkedAt 时间戳（冒号与毫秒点替换为 '-'）。

import type { DiffItem } from './types';
import { evaluateRules } from './preflight-rules';
import { PREFLIGHT_REPORT_VERSION } from './preflight-types';
import type {
  PreflightCategory,
  PreflightFact,
  PreflightInference,
  PreflightIssue,
  PreflightReport,
  PreflightThresholds,
  PreflightUnknown,
} from './preflight-types';
import { DEFAULT_THRESHOLDS } from './preflight-types';

// ---------------------------------------------------------------------------
// PreflightBuildInput
// ---------------------------------------------------------------------------

export interface PreflightBuildInput {
  /** 已采集的事实/推断/未知（由 preflight-collect 层产出）。 */
  report: {
    facts: PreflightFact[];
    inferences: PreflightInference[];
    unknowns: PreflightUnknown[];
  };
  /** CompareResult.items 中已过滤的结构 DDL 项（不含数据行）。 */
  items: DiffItem[];
  targetAlias: string;
  targetDatabase: string;
  appVersion: string;
  /** 阈值覆盖；缺省使用 DEFAULT_THRESHOLDS。 */
  thresholds?: Partial<PreflightThresholds>;
  /**
   * 检查时间（ISO）；缺省使用 `new Date().toISOString()`。
   * 单测通过注入固定值验证 byte 稳定。
   */
  checkedAt?: string;
}

// ---------------------------------------------------------------------------
// deriveVerdict
// ---------------------------------------------------------------------------

/**
 * 计算 verdict（level + 计数），不修改入参。
 *
 * level 优先级：block > warn > unknown > pass。
 * counts：blocking = issues 中 severity=block 的计数；warnings = severity=warn 的计数；
 * unknowns = unknowns.length。
 */
export function deriveVerdict(
  issues: readonly PreflightIssue[],
  unknowns: readonly PreflightUnknown[],
): PreflightReport['verdict'] {
  const blocking = issues.reduce((n, i) => n + (i.severity === 'block' ? 1 : 0), 0);
  const warnings = issues.reduce((n, i) => n + (i.severity === 'warn' ? 1 : 0), 0);
  let level: PreflightReport['verdict']['level'];
  if (blocking > 0) level = 'block';
  else if (warnings > 0) level = 'warn';
  else if (unknowns.length > 0) level = 'unknown';
  else level = 'pass';
  return { level, blocking, warnings, unknowns: unknowns.length };
}

// ---------------------------------------------------------------------------
// buildPreflightReport
// ---------------------------------------------------------------------------

/**
 * 构建完整 PreflightReport（纯函数，byte 稳定）。
 *
 * 字段顺序严格与 PreflightReport 类型声明顺序一致，序列化输出 byte 稳定。
 * evaluateRules 会重新用 report.items 计算 issues；如已提供 issues，仍以此为准。
 */
export function buildPreflightReport(input: PreflightBuildInput): PreflightReport {
  const thresholds: PreflightThresholds = {
    bigTableRows: input.thresholds?.bigTableRows ?? DEFAULT_THRESHOLDS.bigTableRows,
    replicaLagSeconds: input.thresholds?.replicaLagSeconds ?? DEFAULT_THRESHOLDS.replicaLagSeconds,
  };
  const issues = evaluateRules({
    report: {
      facts: input.report.facts,
      inferences: input.report.inferences,
      unknowns: input.report.unknowns,
    },
    items: input.items,
    thresholds,
  });
  const verdict = deriveVerdict(issues, input.report.unknowns);
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  return {
    schemaVersion: PREFLIGHT_REPORT_VERSION,
    appVersion: input.appVersion,
    checkedAt,
    targetAlias: input.targetAlias,
    targetDatabase: input.targetDatabase,
    source: 'real',
    facts: input.report.facts,
    inferences: input.report.inferences,
    unknowns: input.report.unknowns,
    issues,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// serializePreflight
// ---------------------------------------------------------------------------

/** JSON 序列化：`JSON.stringify(m, null, 2) + '\n'`。 */
export function serializePreflight(m: PreflightReport): string {
  return JSON.stringify(m, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// preflightToMarkdown
// ---------------------------------------------------------------------------

/** Category 分组标题（按类型声明顺序渲染二级标题）。 */
const CATEGORY_LABEL: Record<PreflightCategory, string> = {
  server: 'server',
  table: 'table',
  index: 'index',
  ddl: 'ddl',
  replication: 'replication',
  permissions: 'permissions',
  variables: 'variables',
};

const CATEGORY_ORDER: readonly PreflightCategory[] = [
  'server',
  'variables',
  'table',
  'index',
  'ddl',
  'replication',
  'permissions',
];

/** 转义 Markdown 表格单元格里的 `|`。 */
function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function mdValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'null';
  if (typeof v === 'string') return v;
  return String(v);
}

/**
 * Markdown 人工交接报告：
 * 头部 + 目标信息 + Fact 表（按 category 分组，每类一个二级标题）
 * + Inference 表（含 evidence 引用）+ Unknown 表（含 reason）
 * + Issue 表（severity 排序：block 优先）+ Verdict 结论 + 保密声明。
 */
export function preflightToMarkdown(m: PreflightReport): string {
  const lines: string[] = [];

  // --- 头部 ------------------------------------------------------------------
  lines.push('# Preflight Report');
  lines.push('');
  lines.push(`- 检查时间: ${m.checkedAt}`);
  lines.push(`- schemaVersion: ${m.schemaVersion}`);
  lines.push(`- appVersion: ${m.appVersion}`);
  lines.push(`- 目标别名: ${m.targetAlias}`);
  lines.push(`- 目标数据库: ${m.targetDatabase}`);
  lines.push(`- 来源: ${m.source}`);
  lines.push('');

  // --- Facts（按 category 分组）----------------------------------------------
  lines.push('## Facts');
  lines.push('');
  const factsByCategory = new Map<PreflightCategory, PreflightFact[]>();
  for (const c of CATEGORY_ORDER) factsByCategory.set(c, []);
  for (const f of m.facts) {
    const arr = factsByCategory.get(f.category) ?? [];
    arr.push(f);
    factsByCategory.set(f.category, arr);
  }
  for (const c of CATEGORY_ORDER) {
    const arr = factsByCategory.get(c) ?? [];
    if (arr.length === 0) continue;
    lines.push(`### Facts · ${CATEGORY_LABEL[c]}`);
    lines.push('');
    lines.push('| Key | Value | Source | Observed At |');
    lines.push('| --- | --- | --- | --- |');
    for (const f of arr) {
      lines.push(
        `| ${mdCell(f.key)} | ${mdCell(mdValue(f.value))} | ${mdCell(f.source)} | ${mdCell(f.observedAt)} |`,
      );
    }
    lines.push('');
  }
  if (m.facts.length === 0) {
    lines.push('_（无事实）_');
    lines.push('');
  }

  // --- Inferences ------------------------------------------------------------
  lines.push('## Inferences');
  lines.push('');
  if (m.inferences.length === 0) {
    lines.push('_（无推断）_');
    lines.push('');
  } else {
    lines.push('| Subject | Statement | Confidence | Rule | Evidence |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const i of m.inferences) {
      lines.push(
        `| ${mdCell(i.subject)} | ${mdCell(i.statement)} | ${mdCell(i.confidence)} | ${mdCell(i.ruleId)} | ${mdCell(i.evidence.join('; '))} |`,
      );
    }
    lines.push('');
  }

  // --- Unknowns --------------------------------------------------------------
  lines.push('## Unknowns');
  lines.push('');
  if (m.unknowns.length === 0) {
    lines.push('_（无未知）_');
    lines.push('');
  } else {
    lines.push('| Subject | Reason | Attempt | Observed At |');
    lines.push('| --- | --- | --- | --- |');
    for (const u of m.unknowns) {
      lines.push(
        `| ${mdCell(u.subject)} | ${mdCell(u.reason)} | ${mdCell(u.attempt)} | ${mdCell(u.observedAt)} |`,
      );
    }
    lines.push('');
  }

  // --- Issues（block 优先）----------------------------------------------------
  lines.push('## Issues');
  lines.push('');
  if (m.issues.length === 0) {
    lines.push('_（无高危规则触发）_');
    lines.push('');
  } else {
    const sorted = [...m.issues].sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1,
    );
    lines.push('| ID | Severity | Subject | Title | Recommendation |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const i of sorted) {
      const subject = i.id.includes(':') ? i.id.slice(i.id.indexOf(':') + 1) : i.id;
      lines.push(
        `| ${mdCell(i.id)} | ${mdCell(i.severity)} | ${mdCell(subject)} | ${mdCell(i.title)} | ${mdCell(i.recommendation)} |`,
      );
    }
    lines.push('');
  }

  // --- Verdict ---------------------------------------------------------------
  lines.push('## Verdict');
  lines.push('');
  lines.push(`- Level: **${m.verdict.level}**`);
  lines.push(`- Blocking: ${m.verdict.blocking}`);
  lines.push(`- Warnings: ${m.verdict.warnings}`);
  lines.push(`- Unknowns: ${m.verdict.unknowns}`);
  lines.push('');

  // --- 保密声明 --------------------------------------------------------------
  lines.push('## 保密声明');
  lines.push('');
  lines.push(
    '本报告不含连接凭据（密码 / 私钥 / passphrase / Vault 密文）与未经裁定的行值。',
  );
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// preflightFileNames
// ---------------------------------------------------------------------------

export function preflightFileNames(checkedAt: string): {
  jsonFileName: string;
  markdownFileName: string;
} {
  const safe = checkedAt.replace(/[:.]/g, '-');
  return {
    jsonFileName: `sqldiff-preflight-${safe}.json`,
    markdownFileName: `sqldiff-preflight-${safe}.md`,
  };
}
