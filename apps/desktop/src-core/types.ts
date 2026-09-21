// M1 骨架：跨层契约的唯一事实来源（per design.md Contracts）。
// 引擎/存储逻辑分别在 M2（vault）、M3（连接层）、M4（diff 移植）实现，本文件只定类型。

export type ObjectType = 'table' | 'view' | 'procedure' | 'function';

/** 数据对比范围标记（非结构对象类型， CompareRequest.scopes 可携带，结构归一时剥离）。 */
export type DataScope = 'data';

export type ChangeType = 'CREATE' | 'DROP' | 'CHANGE';

/** 数据 DML 三态（独立三 Tab，不复用 ChangeType，见 Q1 决议）。 */
export type DmlType = 'INSERT' | 'DELETE' | 'UPDATE';

export type RiskLevel = 'high' | 'medium' | 'low';

export interface SshConfig {
  enabled: boolean;
  host: string;
  /** 默认 22 */
  port: number;
  user: string;
  authType: 'password' | 'privateKey';
}

/** 节点元数据（存 nodes.json）；密码等秘密走钥匙串，不进本结构。 */
export interface NodeMeta {
  id: string;
  alias: string;
  host: string;
  /** 默认 3306 */
  port: number;
  user: string;
  database: string;
  group?: string;
  tags?: string[];
  /** 我的（收藏星标） */
  star?: boolean;
  /** 常用（手动置顶） */
  pinned?: boolean;
  /** 常用（自动 Top 按频次） */
  useCount?: number;
  ssh: SshConfig;
  /** ISO 时间 */
  createdAt: string;
}

/** 明文秘密：只驻留内存 / 钥匙串（key `sqldiff/<nodeId>`），永不落盘明文。 */
export interface SecretBundle {
  password?: string;
  sshPassword?: string;
  privateKey?: string;
  passphrase?: string;
}

/** 导出 JSON 中的加密段：AES-GCM，主密钥存钥匙串（M2 实现编解码）。 */
export interface SecretsEnc {
  enc: 'aes-gcm';
  iv: string;
  data: string;
}

export interface DiffItem {
  id: string;
  /** 数据行归 'data'（与结构四类型并列，UI 独立分组展示）。 */
  objectType: ObjectType | 'data';
  objectName: string;
  /** 数据行按 INSERT->CREATE / DELETE->DROP / UPDATE->CHANGE 映射（统计兼容），展示以 dml 为准。 */
  changeType: ChangeType;
  /** 仅 objectType==='data' 时有值，对应独立 INSERT/DELETE/UPDATE 三 Tab。 */
  dml?: DmlType;
  risk: RiskLevel;
  sql: string;
  rollback?: string;
  explain?: string;
}

export interface ExportNodeEntry {
  meta: NodeMeta;
  secretsEnc: SecretsEnc;
}

/** 一键导出全部节点的自定义 JSON；`converters/` 预留二期 DBeaver/DataGrip 兼容。 */
export interface ExportJSON {
  version: 1;
  exportedAt: string;
  nodes: ExportNodeEntry[];
}

/** M2：对比历史条目（存 history.json，只留最近 20 条：时间 + A/B 别名 + 差异数）。 */
export interface HistoryEntry {
  id: string;
  /** ISO 时间 */
  at: string;
  aAlias: string;
  bAlias: string;
  aId?: string;
  bId?: string;
  diffCount: number;
}

/** M2 占位：连接测试结果；M3 实现真实 mysql2/ssh2 测试（含延迟 ms）。 */
export interface ConnTestResult {
  ok: boolean;
  /** 往返延迟毫秒 */
  ms: number;
  code?: string;
  message?: string;
}

export interface CompareRequest {
  aId: string;
  bId: string;
  /** 结构范围；可携带 'data' 表示同时跑数据对比（与 includeData 等价，兼容旧调用）。 */
  scopes: Array<ObjectType | DataScope>;
  tableFilter?: string;
  /** 显式数据开关（与 scopes 含 'data' 任一成立即跑数据对比）。 */
  includeData?: boolean;
  /** 数据表映射（A 表 -> B 表）；缺省为同名交集（受 tableFilter 约束）。 */
  dataTables?: DataTablePair[];
  dataOptions?: DataCompareOptions;
}

/** 数据表映射：一行 A 表对一行 B 表（同名自动 + 手动改 B 下拉）。 */
export interface DataTablePair {
  a: string;
  b: string;
}

export type DataTableStatusKind = 'pending' | 'running' | 'done' | 'skipped' | 'error' | 'confirm-needed';

/** 逐表状态行（待比 / 进行中 / 完成 / 跳过无主键 / 失败不中断 / 超阈待确认）。 */
export interface DataTableStatus {
  a: string;
  b: string;
  status: DataTableStatusKind;
  /** skipped/error/confirm-needed 的原因码：no-pk | pk-mismatch | over-threshold | fetch-failed | aborted */
  reason?: string;
  message?: string;
  countA?: number;
  countB?: number;
  insertCount?: number;
  deleteCount?: number;
  updateCount?: number;
}

export interface DataCompareOptions {
  /** 主键范围分页批量（默认 1000）。 */
  batchRows?: number;
  /** INSERT 多 VALUES 分批行数（默认 500）。 */
  insertBatch?: number;
  /** 单表行数阈值（默认 100000），超限需 confirmOverThreshold 否则记 confirm-needed。 */
  threshold?: number;
  /** 已二次确认超阈大表（UI confirm 后重跑时传 true）。 */
  confirmOverThreshold?: boolean;
}

export interface DmlStats {
  INSERT: number;
  DELETE: number;
  UPDATE: number;
}

export interface CompareStats {
  ALL: number;
  CREATE: number;
  DROP: number;
  CHANGE: number;
  DML: DmlStats;
}

export interface CompareResult {
  items: DiffItem[];
  stats: CompareStats;
  /** 数据对比逐表状态（含跳过/失败表），无数据对比时缺省。 */
  dataTables?: DataTableStatus[];
}
