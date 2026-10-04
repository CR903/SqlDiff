// 生产 Preflight v1 类型契约（纯定义，零运行时依赖 —— src-core 层可跨宿主共享）。
//
// 与 ReviewManifest 的关系（互补而非替代）：
// - ReviewManifest 描述「差异是什么」，是 DiffItem 的确定性投影（见 manifest.ts）。
// - PreflightReport 描述「应用差异会发生什么」：事实 / 推断 / 未知三段结构 + 高危规则。
// - 两者 schema 独立版本，导出物均无秘密、字段顺序即类型声明顺序（byte 稳定）。
//
// 边界：本文件不引入任何 Node / mysql2 依赖；所有跨宿主共享。

/** Preflight 报告 schema 版本（升级路径必须有测试覆盖）。 */
export const PREFLIGHT_REPORT_VERSION = 2 as const;

/** Fact / Inference / Unknown / Issue 的类别归属（与 PRD §R2 六类事实对齐）。 */
export type PreflightCategory =
  | 'server'      // 版本、SQL_MODE、系统变量
  | 'table'       // 表规模、空间、引擎
  | 'index'       // 主键、唯一/普通索引、外键
  | 'ddl'         // 每条 DDL 的分类与算法判定
  | 'replication' // 复制状态
  | 'permissions' // 授权可见性
  | 'variables';  // 其它系统变量

/** Fact 的来源查询名（严格只读：SELECT / SHOW / @@ / information_schema）。 */
export type PreflightFactSource =
  | 'select-version'
  | 'select-sysvars'
  | 'information-schema.tables'
  | 'information-schema.statistics'
  | 'information-schema.key-column-usage'
  | 'show-replica-status'
  | 'show-slave-status'
  | 'show-grants-for-current-user';

/** 推断的置信度：high = 有确定性矩阵/规则依据；low = 版本不足以判定。 */
export type PreflightInferenceConfidence = 'high' | 'medium' | 'low';

/** 无法判定的原因码（PRD §R4）：不能用默认值伪装为确定。 */
export type PreflightUnknownReason =
  | 'permission-denied'
  | 'query-failed'
  | 'unsupported-version'
  | 'not-applicable'
  | 'unparsed-ddl';

/** Issue 严重度：block = 应阻断发布；warn = 需要人工确认或提示。 */
export type PreflightIssueSeverity = 'block' | 'warn';

/** 单条事实：可追溯的具体观测值。 */
export interface PreflightFact {
  category: PreflightCategory;
  /** 例：'version', 'sql_mode', 'table.orders.rows', 'server.read_only' */
  key: string;
  /** 原始值：数字 / 字符串 / 布尔 / null */
  value: unknown;
  source: PreflightFactSource;
  /** ISO 时间戳 */
  observedAt: string;
}

/** 单条推断：基于 Fact 应用确定性规则得出的结论。 */
export interface PreflightInference {
  category: PreflightCategory;
  /** 例：'table.orders' 或 'diff-item:d12' */
  subject: string;
  /** 人可读的一行结论。 */
  statement: string;
  confidence: PreflightInferenceConfidence;
  /** Fact.key 列表：能追溯到具体事实。 */
  evidence: string[];
  /** 规则 id（例：'INPLACE_ALGORITHM' / 'BIG_TABLE_COPY'）。 */
  ruleId: string;
}

/** 单条未知：因权限、版本或查询失败无法判定的情况。 */
export interface PreflightUnknown {
  category: PreflightCategory;
  /** 例：'replication.status' 或 'diff-item:d21' */
  subject: string;
  reason: PreflightUnknownReason;
  /** 尝试了什么查询/规则。 */
  attempt: string;
  observedAt: string;
}

/** 单条 Issue：高危规则触发的可行动结论。 */
export interface PreflightIssue {
  /** 例：'BIG_TABLE_COPY:table.orders' 或 'BIG_TABLE_COPY:diff-item:orders_add' */
  id: string;
  severity: PreflightIssueSeverity;
  /** 例：'表 orders 变更将重建表' */
  title: string;
  detail: string;
  /** Fact.key / Inference.subject 混合引用（用于从 Issue 追溯到具体事实）。 */
  related: string[];
  /** 建议动作。 */
  recommendation: string;
}

/** Schema v2 结论快照：deriveDecision 在报告生成时一次算出并写入（UI/程序直接复用）。 */
export interface PreflightSummary {
  decision: 'GO' | 'DEGRADED' | 'BLOCK';
  message: string;
  blocking: number;
  warnings: number;
  unknowns: number;
}

/** Preflight 报告总结构（字段顺序即类型声明顺序，用于 byte 稳定序列化）。 */
export interface PreflightReport {
  schemaVersion: typeof PREFLIGHT_REPORT_VERSION;
  appVersion: string;
  checkedAt: string;
  targetAlias: string;
  targetDatabase: string;
  source: 'real';
  facts: PreflightFact[];
  inferences: PreflightInference[];
  unknowns: PreflightUnknown[];
  issues: PreflightIssue[];
  verdict: {
    level: 'pass' | 'warn' | 'block' | 'unknown';
    blocking: number;
    warnings: number;
    unknowns: number;
  };
  summary: PreflightSummary;
}

/** 内置默认阈值（Q3 已定：v1 内置默认，不做可配置策略）。 */
export interface PreflightThresholds {
  bigTableRows: number;
  replicaLagSeconds: number;
}

export const DEFAULT_THRESHOLDS: PreflightThresholds = {
  bigTableRows: 1_000_000,
  replicaLagSeconds: 30,
} as const;
