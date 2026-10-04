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
  PreflightSummary,
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
  // summary 是 verdict/issues 的派生快照：用无 summary 的中间报告一次算出 decision，
  // 计数直接快照 verdict（与 deriveVerdict 同源，不重新统计）。
  const decision = deriveDecision({
    issues,
    inferences: input.report.inferences,
    unknowns: input.report.unknowns,
  });
  const summary: PreflightSummary = {
    decision: decision.level,
    message: decision.message,
    blocking: verdict.blocking,
    warnings: verdict.warnings,
    unknowns: verdict.unknowns,
  };
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
    summary,
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
  detailMarkdownFileName: string;
} {
  const safe = checkedAt.replace(/[:.]/g, '-');
  return {
    jsonFileName: `sqldiff-preflight-${safe}.json`,
    markdownFileName: `sqldiff-preflight-${safe}.md`,
    detailMarkdownFileName: `sqldiff-preflight-${safe}-detail.md`,
  };
}

// ---------------------------------------------------------------------------
// v2 结论式渲染（v2 executive summary + detail markdown）
// ---------------------------------------------------------------------------
//
// 三个产物：report.json（程序读）+ report.md（结论，人读）+ report-detail.md（细节，人读）。
// 新增函数保持纯函数（无 IO / 时间 / 随机），checkedAt 由上游注入。
// 复用 mdCell / mdValue 处理表格转义与 null 值。
// 保留旧 preflightToMarkdown 供 legacy 单测使用；主流程已切换到新函数。

/** 从 inference.statement 自由文本解析出结构化字段。 */
export interface InferenceStatement {
  op: string;                       // 'ADD_COLUMN' / 'DROP_COLUMN' / ...
  tableName: string | null;        // null 若 statement 用 '?' 占位
  algorithm: 'INSTANT' | 'INPLACE' | 'COPY' | null;
  lockMode: 'EXCLUSIVE' | 'SHARED' | 'NONE' | 'EXCLUSIVE-BRIEF' | null;
  rebuilds: boolean;               // true if statement contains '(rebuild)'
}

export type DecisionLevel = 'GO' | 'DEGRADED' | 'BLOCK';

export interface Decision {
  level: DecisionLevel;
  message: string;
}

export interface TableRow {
  name: string;
  rows: number | null;
  size: number | null;             // bytes
  hasPk: boolean;
  ddlCount: number;
  risk: 'safe' | 'warn' | 'block';
}

export interface DeveloperView {
  totalDdl: number;
  classifiedCount: number;
  classifiedPct: number;           // 0-100
  opDistribution: Record<string, number>;
  unparsed: PreflightUnknown[];
  tableIssues: { table: string; issue: string; severity: string }[];
}

export interface OpsView {
  decision: Decision;
  exclusive: { id: string; table: string; op: string }[];
  inplaceShared: { id: string; table: string; op: string }[];
  instant: { id: string; table: string; op: string }[];
  tableHeatmap: TableRow[];
  envStatus: {
    key: string;
    label: string;
    value: string;
    status: 'ok' | 'warn' | 'block';
  }[];
}

/** 匹配 `d01: ADD_COLUMN on users_big → INSTANT/SHARED` 与带 `(rebuild)` 后缀的变体。 */
const STATEMENT_RE = /^(\S+):\s+(\w+)\s+on\s+(\S+)\s+→\s+(\w+)\/([\w-]+)(?:\s+\(rebuild\))?$/;

/** 解析 inference.statement 自由文本，无法匹配时返回全空结构。 */
export function parseInferenceStatement(s: string): InferenceStatement {
  const m = s.match(STATEMENT_RE);
  if (!m) {
    return { op: '', tableName: null, algorithm: null, lockMode: null, rebuilds: false };
  }
  const [, , op, tableName, algorithm, lockMode] = m;
  const algo = algorithm === 'INSTANT' || algorithm === 'INPLACE' || algorithm === 'COPY'
    ? algorithm
    : null;
  const lock = lockMode === 'EXCLUSIVE' || lockMode === 'SHARED' || lockMode === 'NONE'
    || lockMode === 'EXCLUSIVE-BRIEF'
    ? lockMode
    : null;
  return {
    op,
    tableName: tableName === '?' ? null : tableName,
    algorithm: algo,
    lockMode: lock,
    rebuilds: s.includes('(rebuild)'),
  };
}

/** 数字行数格式化：>1M → '1.2 M'；>1K → '891 K'；其余原值。 */
export function fmtRows(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '?';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (abs >= 1_000) return `${Math.round(n / 1_000)} K`;
  return String(n);
}

/** 字节数格式化：>1GiB → '1.2 GiB'；>1MiB → '46.7 MiB'；>1KiB → '16 KiB'；其余原值。 */
export function fmtSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '?';
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  if (abs >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (abs >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/**
 * 三态决策语：block 优先；无 block 但有 EXCLUSIVE 锁 / 大表重建 / 复制延迟 → DEGRADED；
 * 其余 → GO。unknowns 不单独影响决策（多数是 not-applicable 噪声）。
 *
 * 入参取最小形状（issues/inferences/unknowns），v1 无 summary 的旧报告同样可传。
 */
export function deriveDecision(
  m: Pick<PreflightReport, 'issues' | 'inferences' | 'unknowns'>,
): Decision {
  const blocks = m.issues.filter((i) => i.severity === 'block');
  if (blocks.length > 0) {
    return {
      level: 'BLOCK',
      message: `不能发布。${blocks.length} 条阻断规则触发，需人工处理后再试。`,
    };
  }

  const hasExclusive = m.inferences.some((i) => {
    const stmt = parseInferenceStatement(i.statement);
    return stmt.lockMode === 'EXCLUSIVE' || stmt.lockMode === 'EXCLUSIVE-BRIEF';
  });
  const bigTableIds = m.issues.filter((i) =>
    i.id.startsWith('BIG_TABLE_COPY:') || i.id.startsWith('BIG_TABLE_REBUILD:')
      || i.id.startsWith('LARGE_TABLE_REBUILD:') || i.id.startsWith('REPLICA_LAG:'),
  );
  const exclusiveCount = m.inferences.filter((i) => {
    const stmt = parseInferenceStatement(i.statement);
    return stmt.lockMode === 'EXCLUSIVE' || stmt.lockMode === 'EXCLUSIVE-BRIEF';
  }).length;
  const warnCount = m.issues.filter((i) => i.severity === 'warn').length;

  if (hasExclusive || bigTableIds.length > 0) {
    return {
      level: 'DEGRADED',
      message: `可发布但需排期。${exclusiveCount} 条 DDL 会 EXCLUSIVE 锁 + 重建，`
        + `${warnCount} 条 warn 规则触发，建议低峰执行。`,
    };
  }

  return {
    level: 'GO',
    message: `可发布。全部 DDL 可用 INSTANT/INPLACE 完成，无阻断、无严重警告。`,
  };
}

/**
 * 读取报告结论快照（Schema v2）。
 *
 * - v2 报告（含 summary）直接返回存量快照，不重算；
 * - v1 旧报告（缺 summary）用 `deriveDecision` 按需回填，计数取自 `verdict`
 *  （与写入时快照同源），无报错、无强制重跑。
 */
export function getSummary(
  m: Pick<PreflightReport, 'issues' | 'inferences' | 'unknowns'> & {
    verdict?: PreflightReport['verdict'];
    summary?: PreflightSummary;
  },
): PreflightSummary {
  const s = m.summary;
  if (s && (s.decision === 'GO' || s.decision === 'DEGRADED' || s.decision === 'BLOCK')) {
    return s;
  }
  const decision = deriveDecision(m);
  const v = m.verdict;
  return {
    decision: decision.level,
    message: decision.message,
    blocking: v?.blocking ?? 0,
    warnings: v?.warnings ?? 0,
    unknowns: v?.unknowns ?? m.unknowns.length,
  };
}

/** 从 inferences 提取 DDL 并分三档：EXCLUSIVE 锁 / INPLACE SHARED / INSTANT。 */
export function groupDdlByRisk(inferences: readonly PreflightInference[]): {
  exclusive: { inference: PreflightInference; stmt: InferenceStatement }[];
  inplaceShared: { inference: PreflightInference; stmt: InferenceStatement }[];
  instant: { inference: PreflightInference; stmt: InferenceStatement }[];
} {
  const exclusive: { inference: PreflightInference; stmt: InferenceStatement }[] = [];
  const inplaceShared: { inference: PreflightInference; stmt: InferenceStatement }[] = [];
  const instant: { inference: PreflightInference; stmt: InferenceStatement }[] = [];
  for (const inf of inferences) {
    const stmt = parseInferenceStatement(inf.statement);
    if (stmt.algorithm === 'INSTANT') {
      instant.push({ inference: inf, stmt });
    } else if (stmt.lockMode === 'EXCLUSIVE' || stmt.lockMode === 'EXCLUSIVE-BRIEF') {
      exclusive.push({ inference: inf, stmt });
    } else {
      // INPLACE + SHARED（无论是否 rebuild）
      inplaceShared.push({ inference: inf, stmt });
    }
  }
  return { exclusive, inplaceShared, instant };
}

/** 从 facts 中提取某 key 的值。 */
function factValue(facts: readonly PreflightFact[], key: string): unknown {
  for (const f of facts) {
    if (f.key === key) return f.value;
  }
  return undefined;
}

/** 从 facts 中提取某 key 的数值（非数字返回 null）。 */
function factNum(facts: readonly PreflightFact[], key: string): number | null {
  const v = factValue(facts, key);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** 是否视为「开启」（1 / '1' / true / 'ON' / 'on' / 'YES' / 'yes'）。 */
function isTruthyFlag(v: unknown): boolean {
  return v === 1 || v === '1' || v === true || v === 'ON' || v === 'on' || v === 'YES' || v === 'yes';
}

/** 按表名聚合 facts 与 inferences，输出表热图行（按 rows 降序）。 */
export function buildTableHeatmap(
  facts: readonly PreflightFact[],
  inferences: readonly PreflightInference[],
): TableRow[] {
  const tableNames = new Set<string>();
  for (const f of facts) {
    const parts = f.key.split('.');
    if (parts.length >= 3 && parts[0] === 'table') tableNames.add(parts[1]);
  }
  const ddlCounts = new Map<string, number>();
  for (const inf of inferences) {
    const stmt = parseInferenceStatement(inf.statement);
    if (stmt.tableName) {
      ddlCounts.set(stmt.tableName, (ddlCounts.get(stmt.tableName) ?? 0) + 1);
    }
  }
  const rows: TableRow[] = [];
  for (const name of tableNames) {
    const rowsVal = factNum(facts, `table.${name}.rows`);
    const dataLen = factNum(facts, `table.${name}.data_length`) ?? 0;
    const idxLen = factNum(facts, `table.${name}.index_length`) ?? 0;
    const primary = factValue(facts, `table.${name}.primary_indexes`);
    const primaryCount = Array.isArray(primary) ? primary.length : 0;
    const hasPk = primaryCount > 0;
    const ddlCount = ddlCounts.get(name) ?? 0;
    let risk: TableRow['risk'];
    if (!hasPk) risk = 'block';
    else if (rowsVal !== null && rowsVal >= 1_000_000) risk = 'warn';
    else risk = 'safe';
    rows.push({
      name,
      rows: rowsVal,
      size: dataLen + idxLen,
      hasPk,
      ddlCount,
      risk,
    });
  }
  rows.sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1));
  return rows;
}

/** 开发视角装配：DDL 分类成功率 + 分布 + unparsed 清单 + 表结构隐患。 */
export function buildDeveloperView(m: PreflightReport): DeveloperView {
  const unparsed = m.unknowns.filter((u) => u.reason === 'unparsed-ddl');
  const unsupported = m.unknowns.filter((u) => u.reason === 'unsupported-version');
  // PreflightReport 类型不含 items，用 inferences + ddl 类 unknowns 估算 totalDdl。
  const totalDdl = m.inferences.length + unparsed.length + unsupported.length;
  const classifiedCount = m.inferences.length;
  const classifiedPct = totalDdl === 0 ? 100 : Math.round((classifiedCount / totalDdl) * 100);

  const opDistribution: Record<string, number> = {};
  for (const inf of m.inferences) {
    const stmt = parseInferenceStatement(inf.statement);
    if (!stmt.op) continue;
    opDistribution[stmt.op] = (opDistribution[stmt.op] ?? 0) + 1;
  }

  // 表结构隐患：NO_PRIMARY_KEY / NO_UNIQUE_INDEX_AFTER_CHANGE / LARGE_TABLE_REBUILD。
  const tableIssueRuleIds = [
    'NO_PRIMARY_KEY',
    'NO_UNIQUE_INDEX_AFTER_CHANGE',
    'LARGE_TABLE_REBUILD',
  ];
  const tableIssues: { table: string; issue: string; severity: string }[] = [];
  for (const iss of m.issues) {
    const idx = iss.id.indexOf(':');
    if (idx < 0) continue;
    const ruleId = iss.id.slice(0, idx);
    if (!tableIssueRuleIds.includes(ruleId)) continue;
    const subject = iss.id.slice(idx + 1);
    const tableName = subject.startsWith('table.') ? subject.slice(6) : subject;
    tableIssues.push({ table: tableName, issue: ruleId, severity: iss.severity });
  }

  return { totalDdl, classifiedCount, classifiedPct, opDistribution, unparsed, tableIssues };
}

/** 运维视角装配：决策语 + DDL 分组 + 表热图 + 环境状态。 */
export function buildOpsView(m: PreflightReport): OpsView {
  const { exclusive, inplaceShared, instant } = groupDdlByRisk(m.inferences);
  const toRows = (
    arr: { inference: PreflightInference; stmt: InferenceStatement }[],
  ): { id: string; table: string; op: string }[] => {
    return arr.map(({ inference, stmt }) => ({
      id: inference.subject.replace(/^diff-item:/, '') ?? '',
      table: stmt.tableName ?? '?',
      op: stmt.op,
    }));
  };
  const envStatus = buildEnvStatus(m.facts);
  return {
    decision: deriveDecision(m),
    exclusive: toRows(exclusive),
    inplaceShared: toRows(inplaceShared),
    instant: toRows(instant),
    tableHeatmap: buildTableHeatmap(m.facts, m.inferences),
    envStatus,
  };
}

/** 从 facts 提取关键环境键值，给出状态标注。 */
function buildEnvStatus(facts: readonly PreflightFact[]): OpsView['envStatus'] {
  const out: OpsView['envStatus'] = [];

  const version = factValue(facts, 'server.mysql_version');
  out.push({
    key: 'server.mysql_version',
    label: 'MySQL 版本',
    value: version === undefined || version === null ? '?' : String(version),
    status: 'ok',
  });

  const ro = factValue(facts, 'server.read_only');
  out.push({
    key: 'server.read_only',
    label: '只读模式',
    value: ro === undefined || ro === null ? '?' : (isTruthyFlag(ro) ? 'ON' : 'OFF'),
    status: isTruthyFlag(ro) ? 'block' : 'ok',
  });

  const sro = factValue(facts, 'server.super_read_only');
  if (sro !== undefined) {
    out.push({
      key: 'server.super_read_only',
      label: '超级只读',
      value: sro === null ? '?' : (isTruthyFlag(sro) ? 'ON' : 'OFF'),
      status: isTruthyFlag(sro) ? 'block' : 'ok',
    });
  }

  const lag = factNum(facts, 'replication.seconds_behind_master');
  if (lag !== null) {
    out.push({
      key: 'replication.seconds_behind_master',
      label: '复制延迟',
      value: `${lag}s`,
      status: lag > 30 ? 'warn' : 'ok',
    });
  }

  const gtid = factValue(facts, 'replication.gtid_mode');
  if (gtid !== undefined) {
    const gs = gtid === null ? '' : String(gtid);
    out.push({
      key: 'replication.gtid_mode',
      label: 'GTID 模式',
      value: gs || '?',
      status: !gs || gs === 'OFF' || gs === 'ON' ? 'ok' : 'warn',
    });
  }

  const vis = factValue(facts, 'permissions.visibility');
  if (vis !== undefined) {
    const vs = vis === null ? '' : String(vis);
    out.push({
      key: 'permissions.visibility',
      label: '权限可见性',
      value: vs || '?',
      status: vs === 'full' ? 'ok' : 'warn',
    });
  }

  const reliable = factValue(facts, 'permissions.reliable');
  if (reliable !== undefined) {
    const unreliable = reliable === false || reliable === 0 || reliable === 'false';
    out.push({
      key: 'permissions.reliable',
      label: '权限可靠度',
      value: unreliable ? 'false' : 'true',
      status: unreliable ? 'warn' : 'ok',
    });
  }

  return out;
}

/**
 * 结论式 Markdown（report.md）：首屏可读的决策语 + 开发视角 + 运维视角 + 详情链接。
 * 不塞 Facts 表（那是 detail 文件的活）。
 */
export function preflightToExecutiveMarkdown(m: PreflightReport): string {
  const lines: string[] = [];
  const names = preflightFileNames(m.checkedAt);
  const decision = deriveDecision(m);
  const dev = buildDeveloperView(m);
  const ops = buildOpsView(m);
  const version = factValue(m.facts, 'server.mysql_version');
  const versionStr = version === undefined || version === null ? '?' : String(version);

  // --- 头部 ---
  lines.push('# Preflight Executive Summary');
  lines.push('');
  const badge = decision.level === 'GO' ? '🟢' : decision.level === 'DEGRADED' ? '🟡' : '🔴';
  lines.push(`## 决策 · ${badge} ${decision.level}`);
  lines.push('');
  lines.push(decision.message);
  lines.push('');
  lines.push(
    `**目标** ${m.targetAlias} / ${m.targetDatabase}  ·  MySQL ${versionStr}  ·  检查时间 ${m.checkedAt}`,
  );
  lines.push('');

  // --- 开发视角 ---
  lines.push('## 开发视角（我写的 DDL 对不对）');
  lines.push('');
  lines.push('### DDL 分类');
  lines.push('');
  lines.push(`- 共 ${dev.totalDdl} 条 DDL，成功分类 ${dev.classifiedCount} 条（${dev.classifiedPct}%）`);
  const distEntries = Object.entries(dev.opDistribution);
  if (distEntries.length > 0) {
    lines.push(`- 分布：${distEntries.map(([op, n]) => `${op}:${n}`).join(', ')}`);
  } else {
    lines.push('- 分布：（无）');
  }
  lines.push('');

  lines.push(`### Unparsed DDL（${dev.unparsed.length} 条）`);
  lines.push('');
  if (dev.unparsed.length === 0) {
    lines.push('全部可识别。');
  } else {
    lines.push('| 编号 | SQL 摘要 | 原因 |');
    lines.push('| --- | --- | --- |');
    for (const u of dev.unparsed) {
      const sqlPreview = (u.attempt ?? '').slice(0, 80).replace(/\|/g, '\\|');
      lines.push(`| ${mdCell(u.subject)} | ${mdCell(sqlPreview)} | ${mdCell(u.reason)} |`);
    }
  }
  lines.push('');

  lines.push('### 表结构隐患');
  lines.push('');
  if (dev.tableIssues.length === 0) {
    lines.push('无。');
  } else {
    lines.push('| 表 | 隐患 | 严重度 |');
    lines.push('| --- | --- | --- |');
    for (const ti of dev.tableIssues) {
      lines.push(`| ${mdCell(ti.table)} | ${mdCell(ti.issue)} | ${mdCell(ti.severity)} |`);
    }
  }
  lines.push('');

  // --- 运维视角 ---
  lines.push('## 运维视角（执行会发生什么）');
  lines.push('');
  lines.push('### 建议动作');
  lines.push('');
  for (const bullet of buildRecommendations(m, decision, ops)) {
    lines.push(`- ${bullet}`);
  }
  lines.push('');

  lines.push('### DDL 分组（按风险）');
  lines.push('');
  const renderGroup = (
    title: string,
    arr: { id: string; table: string; op: string }[],
  ): void => {
    lines.push(`${title} (${arr.length})`);
    if (arr.length === 0) {
      lines.push('_（无）_');
      lines.push('');
      return;
    }
    lines.push('| 编号 | 表 | 操作 |');
    lines.push('| --- | --- | --- |');
    for (const row of arr) {
      lines.push(`| ${mdCell(row.id)} | ${mdCell(row.table)} | ${mdCell(row.op)} |`);
    }
    lines.push('');
  };
  renderGroup('🔴 EXCLUSIVE 锁 + 重建', ops.exclusive);
  renderGroup('🟡 INPLACE 重建（允许并发 DML）', ops.inplaceShared);
  renderGroup('🟢 INSTANT 无锁无重建', ops.instant);

  lines.push('### 表风险热图');
  lines.push('');
  if (ops.tableHeatmap.length === 0) {
    lines.push('_（无表数据）_');
  } else {
    lines.push('| 表 | 行数 | 大小 | PK | DDL | 风险 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const row of ops.tableHeatmap) {
      const riskIcon = row.risk === 'block' ? '🔴' : row.risk === 'warn' ? '🟡' : '🟢';
      const pkIcon = row.hasPk ? '✅' : '❌';
      lines.push(
        `| ${mdCell(row.name)} | ${fmtRows(row.rows)} | ${fmtSize(row.size)} | ${pkIcon} | ${row.ddlCount} | ${riskIcon} ${row.risk} |`,
      );
    }
  }
  lines.push('');

  lines.push('### 环境状态');
  lines.push('');
  if (ops.envStatus.length === 0) {
    lines.push('_（无环境数据）_');
  } else {
    lines.push('| 键 | 值 | 状态 |');
    lines.push('| --- | --- | --- |');
    for (const row of ops.envStatus) {
      const statusIcon = row.status === 'block' ? '🔴' : row.status === 'warn' ? '🟡' : '🟢';
      lines.push(
        `| ${mdCell(row.label)} | ${mdCell(row.value)} | ${statusIcon} ${row.status} |`,
      );
    }
  }
  lines.push('');

  // --- 详情链接 ---
  lines.push('## 详情');
  lines.push('');
  lines.push(`→ [完整原始数据](./${names.detailMarkdownFileName})`);
  lines.push('');

  // --- 保密声明 ---
  lines.push('## 保密声明');
  lines.push('');
  lines.push('本报告不含连接凭据（密码 / 私钥 / passphrase / Vault 密文）与未经裁定的行值。');
  lines.push('');

  return lines.join('\n');
}

/** 构建「建议动作」bullet 列表。 */
function buildRecommendations(
  m: PreflightReport,
  decision: Decision,
  ops: OpsView,
): string[] {
  const bullets: string[] = [];
  if (decision.level === 'BLOCK') {
    const blocks = m.issues.filter((i) => i.severity === 'block');
    bullets.push(`不能发布。先解除 ${blocks.length} 条阻断项（${blocks.map((i) => i.id.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i).join('、')}）。`);
  } else if (decision.level === 'DEGRADED') {
    if (ops.exclusive.length > 0) {
      bullets.push(`建议低峰时段执行：${ops.exclusive.length} 条 DDL 需 EXCLUSIVE 锁 + 重建。`);
    }
    bullets.push('考虑使用在线 DDL 分块复制工具处理超大表变更。');
  } else {
    bullets.push('可立即执行：全部 DDL 为 INSTANT 或 INPLACE + SHARED 锁。');
  }

  // 附加大表 INSTANT 加速提示（正面）
  const instantAdds = m.issues.filter((i) => i.id.startsWith('LARGE_TABLE_INSTANT_ADD:'));
  if (instantAdds.length > 0) {
    bullets.push(`${instantAdds.length} 条大表 ADD_COLUMN 可用 ALGORITHM=INSTANT 加速。`);
  }

  // 非 not-applicable 的 unknown 值得提示但不升级决策
  const noiseUnknowns = m.unknowns.filter((u) =>
    u.reason !== 'not-applicable' && u.reason !== 'unparsed-ddl' && u.reason !== 'unsupported-version',
  );
  if (noiseUnknowns.length > 0) {
    bullets.push(`附 ${noiseUnknowns.length} 条待确认的未知项（权限 / 查询失败）。`);
  }

  return bullets;
}

/**
 * 细节式 Markdown（report-detail.md）：保留完整 5 段结构（Facts/Inferences/Unknowns/Issues/Verdict）。
 * 与旧 preflightToMarkdown 输出几乎一致，仅改标题并追加返回链接。
 */
export function preflightToDetailMarkdown(m: PreflightReport): string {
  const names = preflightFileNames(m.checkedAt);
  const body = preflightToMarkdown(m);

  // 定位并替换首个一级标题；插入返回链接。
  const lines = body.split('\n');
  const out: string[] = [];
  out.push(`# Preflight Detail Report`);
  out.push('');
  out.push(`← [返回结论](./${names.markdownFileName})`);
  out.push('');
  for (let i = 0; i < lines.length; i += 1) {
    if (i === 0 && lines[i].startsWith('# Preflight Report')) continue; // 跳过原一级标题
    out.push(lines[i]);
  }
  return out.join('\n');
}
