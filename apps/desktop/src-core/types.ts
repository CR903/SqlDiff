// M1 骨架：跨层契约的唯一事实来源（per design.md Contracts）。
// 引擎/存储逻辑分别在 M2（vault）、M3（连接层）、M4（diff 移植）实现，本文件只定类型。

export type ObjectType = 'table' | 'view' | 'procedure' | 'function';

export type ChangeType = 'CREATE' | 'DROP' | 'CHANGE';

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
  objectType: ObjectType;
  objectName: string;
  changeType: ChangeType;
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
  scopes: ObjectType[];
  tableFilter?: string;
}

export interface CompareResult {
  items: DiffItem[];
  stats: Record<ChangeType | 'ALL', number>;
}
