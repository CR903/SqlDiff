// M1 骨架：跨层契约的唯一事实来源（per design.md Contracts）。
// 引擎/存储逻辑分别在 M2（vault）、M3（连接层）、M4（diff 移植）实现，本文件只定类型。

export type ObjectType = 'table' | 'view' | 'procedure' | 'function';

/** 对象过滤口径（含数据行 'data'，与结构四类型并列，UI 对象 chips 多选用）。 */
export type ObjectTypeWithData = ObjectType | 'data';

/** 数据对比范围标记（非结构对象类型， CompareRequest.scopes 可携带，结构归一时剥离）。 */
export type DataScope = 'data';

export type ChangeType = 'CREATE' | 'DROP' | 'CHANGE';

/** 数据 DML 三态（独立三 Tab，不复用 ChangeType，见 Q1 决议）。 */
export type DmlType = 'INSERT' | 'DELETE' | 'UPDATE';

export type RiskLevel = 'high' | 'medium' | 'low';

/**
 * 语句切面（单语句独立打标）：
 * - column：ADD/DROP/CHANGE/MODIFY COLUMN
 * - primary：ADD/DROP PRIMARY KEY（Q1：不归 index）
 * - index：ADD/DROP INDEX|KEY|FULLTEXT|SPATIAL|UNIQUE INDEX
 * - table：CREATE/DROP TABLE 整表
 * - routine：视图/过程/函数（DROP+CREATE 保持原子）
 * - data：数据行 DML
 */
export type StmtAspect = 'column' | 'primary' | 'index' | 'table' | 'routine' | 'data';

/**
 * 语句动词（R7 全部行按动词搜）：单语句首关键字。
 * CREATE / DROP / ALTER / INSERT / UPDATE / DELETE 六桶；
 * 其余（DELIMITER 包裹的例程体重建块、TRUNCATE / REPLACE——引擎不产仅预留、
 * 空串 / 纯注释 / SELECT 等）归 OTHER，无桶。
 */
export type Verb = 'CREATE' | 'DROP' | 'ALTER' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';

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
  /** 语句切面（单语句条目恒 1 个，数组为以后多语句合并留余；R3）。 */
  aspects: StmtAspect[];
  risk: RiskLevel;
  sql: string;
  rollback?: string;
  explain?: string;
}

export interface ExportNodeEntry {
  meta: NodeMeta;
  secretsEnc: SecretsEnc;
}

/** 一键导出全部节点的自定义 JSON；DBeaver topology-only export lives in `src-main/converters/dbeaver.ts`. */
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
  /** index 切面条数（R3/R4：与所见列表一致）。 */
  INDEX: number;
  DML: DmlStats;
}

/**
 * 比较结果来源：real = 主进程真实比较；demo = 本地示例降级（仅开发/无后端态）。
 * 判定成本必须是"看一眼"级，故由调用方边界层显式标注（compare-run / demo）。
 */
export type ResultSource = 'real' | 'demo';

/**
 * 结构覆盖缺失原因码（粗粒度应用自有码，参照 DataTableStatus.reason 惯例）。
 * 不透传 MySQL errno / 原始 message：原始错误留在开发日志，不进界面与导出物。
 * - permission-denied：MySQL 权限类拒绝
 * - object-missing：扫描与 SHOW CREATE 之间对象消失（零行/缺列/已被删除）
 * - aborted：用户取消
 * - unknown：其余异常（保守降级，宁可少判不误判）
 */
export type CoverageReason = 'permission-denied' | 'object-missing' | 'aborted' | 'unknown';

/**
 * 单库可见性完整度（授权盲区判定，见 src-core/visibility.ts）：
 * - full：可证明该库对象全量可见（库级 SELECT / ALL PRIVILEGES 授权，或全局授权）
 * - partial：可证明存在不可见对象（表级授权），或完整性无法证明（保守默认）
 *
 * 语义方向不可颠倒：判据不可靠时一律退向 partial（收窄比较范围），
 * 绝不退向 full（放行基于无知推断出的 DROP TABLE）。
 */
export type Visibility = 'full' | 'partial';

/** 账号在一批库上的可见性判定结果（由 SHOW GRANTS FOR CURRENT_USER() 解析得到）。 */
export interface VisibilityAssessment {
  /** 库名 → 判定。未列出的库视为 'partial'（默认保守，见 visibilityFor）。 */
  byDatabase: Record<string, Visibility>;
  /** 判据是否可靠：false 表示查询失败、输出无法解析或存在角色授权，一律按 partial 处理。 */
  reliable: boolean;
}

/**
 * 一个因授权不可见而无法比较的单侧对象。
 * 不可见对象连名字都无从获得，因此「真的不存在」不可判定 —— 只能列为无法比较，
 * 不得让 compareRun 把它当成 missing 侧生成 CREATE/DROP（那正是本任务要归零的假 DROP）。
 */
export interface ExcludedObject {
  name: string;
  objectType: ObjectType;
  /** 哪一侧可见（另一侧不可见）。 */
  side: 'a-only' | 'b-only';
  reason: 'grant-invisible';
}

/** 比较范围报告：实际进入了比较的对象，以及因授权盲区被排除的单侧对象。 */
export interface CompareVisibility {
  /** 被排除的单侧不可见对象。 */
  excluded: ExcludedObject[];
  /** 实际进入比较的对象总数（收窄后的对象集，按类型 + 名称去重计数）。 */
  compared: number;
  /** 判据是否可靠；false 时界面需更强的提示措辞。 */
  reliable: boolean;
}

/** 一个未取到 SHOW CREATE 的结构对象（比较中被跳过，不参与 diff）。 */
export interface CoverageSkip {
  /** 对象名 */
  name: string;
  /** 对象类型，与 ObjectType 对齐（结构四类型，不含 'data'）。 */
  objectType: ObjectType;
  reason: CoverageReason;
}

/**
 * 结构对比覆盖报告：哪些对象真的被检查过，哪些没有。
 * null 跳过不变量不变（有 null 的对象仍不产生 CREATE/DROP 假象），
 * 本报告只把"静默跳过"变成"可判定跳过"。
 */
export interface StructureCoverage {
  /** 成功取到 SHOW CREATE 的对象数，按类型（A/B 两侧累加）。 */
  ok: Record<ObjectType, number>;
  /** 未取到 SHOW CREATE 的对象明细（A/B 两侧合并；同名对象可能各记一条）。 */
  skipped: CoverageSkip[];
}

export interface CompareResult {
  items: DiffItem[];
  stats: CompareStats;
  /** 数据对比逐表状态（含跳过/失败表），无数据对比时缺省。 */
  dataTables?: DataTableStatus[];
  /**
   * 结果来源；缺省视为 'real' 以兼容 core 内既有构造点（compareRun / postFilterResult
   * 无法在纯 core 判定来源）。边界层必须显式标注：compare-run 标 real、demo 标 demo。
   */
  source?: ResultSource;
  /** 结构覆盖报告；缺省表示未采集（兼容既有构造点）。 */
  coverage?: StructureCoverage;
  /**
   * 授权盲区导致的比较范围报告；缺省表示未采集（demo 路径不产出）。
   * 与 coverage 分工：coverage 记「列举得到但 SHOW CREATE 失败」，
   * visibility 记「因授权根本列举不到、无法证明存在与否」的单侧对象。
   */
  visibility?: CompareVisibility;
}
