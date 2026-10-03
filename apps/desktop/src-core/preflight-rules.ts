// 生产 Preflight v1 · 高风险规则评估（纯函数，零运行时依赖）。
//
// 9 条规则各自独立函数 + 独立测试；evaluateRules 按固定顺序汇总（不重复、顺序稳定）。
// 所有规则纯函数：不修改入参、不产生副作用。
//
// 输入契约：
// - `report.facts`：由 preflight-collect 层产出（key 见文件内各规则的说明）。
// - `report.inferences`：由 classifyDdl + lookupOnlineDdl 组装（v1 阶段可为空）。
// - `report.unknowns`：由 preflight-collect 层产出。
// - `items`：CompareResult.items 中已过滤的结构 DDL 项（不含数据行）。
// - `thresholds`：内置默认见 preflight-types.ts 的 DEFAULT_THRESHOLDS。
//
// Issue id 格式：`RULE_ID:subject`，subject 形如 `table.orders` / `diff-item:<id>` /
// `server` / `replication` / `permissions`。

import type { DiffItem } from './types';
import { classifyDdl, lookupOnlineDdl, versionAtLeast } from './preflight-ddl';
import type {
  PreflightFact,
  PreflightInference,
  PreflightIssue,
  PreflightThresholds,
  PreflightUnknown,
} from './preflight-types';

// ---------------------------------------------------------------------------
// RuleInput
// ---------------------------------------------------------------------------

export interface RuleInput {
  report: {
    facts: PreflightFact[];
    inferences: PreflightInference[];
    unknowns: PreflightUnknown[];
  };
  items: DiffItem[];
  thresholds: PreflightThresholds;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function factValue(facts: readonly PreflightFact[], key: string): unknown {
  for (const f of facts) {
    if (f.key === key) return f.value;
  }
  return undefined;
}

function asNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function mysqlVersion(facts: readonly PreflightFact[]): string {
  const v = factValue(facts, 'server.mysql_version');
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------------------
// 规则 1：BIG_TABLE_COPY（block）
// ---------------------------------------------------------------------------

/**
 * BIG_TABLE_COPY：目标表 TABLE_ROWS > bigTableRows **且** DDL 判定 rebuildsTable。
 *
 * subject = `table.<tableName>`（来自 DDL 分类）；若 DDL 无表名则跳过。
 */
export function ruleBigTableCopy(input: RuleInput): PreflightIssue[] {
  const { report, items, thresholds } = input;
  const mysqlVer = mysqlVersion(report.facts);
  const issues: PreflightIssue[] = [];
  for (const item of items) {
    const cls = classifyDdl(item.sql);
    if (cls.op === 'OTHER' || !cls.tableName) continue;
    const online = lookupOnlineDdl(cls.op, mysqlVer);
    if (!online?.rebuildsTable) continue;
    const rowsKey = `table.${cls.tableName}.rows`;
    const rows = asNum(factValue(report.facts, rowsKey));
    if (rows <= thresholds.bigTableRows) continue;
    issues.push({
      id: `BIG_TABLE_COPY:table.${cls.tableName}`,
      severity: 'block',
      title: `表 ${cls.tableName} 变更将重建表`,
      detail: `TABLE_ROWS=${rows} 超过阈值 ${thresholds.bigTableRows}，且 ${cls.op} 判定 ${online.algorithm} + rebuildsTable。`,
      related: [rowsKey, `diff-item:${item.id}`, `server.mysql_version`],
      recommendation:
        '考虑使用 pt-online-schema-change / gh-ost 分块复制；或将发布窗口调整到低峰时段。',
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 规则 2：READ_ONLY_TARGET（block）
// ---------------------------------------------------------------------------

/**
 * READ_ONLY_TARGET：目标库 read_only===1 或 super_read_only===1。
 *
 * subject = `server`；两条读/只读标记各产生一个 Issue。
 */
export function ruleReadOnlyTarget(input: RuleInput): PreflightIssue[] {
  const { report } = input;
  const issues: PreflightIssue[] = [];
  const roKeys: Array<{ key: string; label: string }> = [
    { key: 'server.read_only', label: 'read_only' },
    { key: 'server.super_read_only', label: 'super_read_only' },
  ];
  for (const { key, label } of roKeys) {
    const v = factValue(report.facts, key);
    const on = v === 1 || v === '1' || v === true || v === 'ON' || v === 'on' || v === 'YES' || v === 'yes';
    if (!on) continue;
    issues.push({
      id: `READ_ONLY_TARGET:server`,
      severity: 'block',
      title: '目标库处于只读模式',
      detail: `${label}=ON；无法执行任何 DDL/DML。`,
      related: [key, 'server.mysql_version'],
      recommendation: '发布前必须临时解除只读模式（SET GLOBAL read_only=0 / super_read_only=0）。',
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 规则 3：NO_PRIMARY_KEY（warn）
// ---------------------------------------------------------------------------

/**
 * NO_PRIMARY_KEY：DDL 分类为 DROP_INDEX / DROP_COLUMN **且** 目标表 primaryIndexes 为空。
 *
 * subject = `table.<tableName>`；DROP_INDEX 若移除的就是主键索引，仍触发。
 */
export function ruleNoPrimaryKey(input: RuleInput): PreflightIssue[] {
  const { report, items } = input;
  const issues: PreflightIssue[] = [];
  for (const item of items) {
    const cls = classifyDdl(item.sql);
    if (cls.op !== 'DROP_INDEX' && cls.op !== 'DROP_COLUMN') continue;
    if (!cls.tableName) continue;
    const pkKey = `table.${cls.tableName}.primary_indexes`;
    const primary = factValue(report.facts, pkKey);
    const primaryCount = Array.isArray(primary) ? primary.length : 0;
    if (primaryCount > 0) continue;
    issues.push({
      id: `NO_PRIMARY_KEY:table.${cls.tableName}`,
      severity: 'warn',
      title: `表 ${cls.tableName} 变更将导致无主键`,
      detail: `当前主键索引数为 0，且执行 ${cls.op} 后仍无主键。无主键表后续 COPY ALTER 与增量复制都受影响。`,
      related: [pkKey, `diff-item:${item.id}`],
      recommendation: '发布前为该表补加主键或全非空 UNIQUE 索引。',
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 规则 4：REPLICA_LAG（warn）
// ---------------------------------------------------------------------------

/**
 * REPLICA_LAG：seconds_behind_master > replicaLagSeconds。
 *
 * subject = `replication`；seconds_behind_master 缺失或不可解析时跳过。
 */
export function ruleReplicaLag(input: RuleInput): PreflightIssue[] {
  const { report, thresholds } = input;
  const lagKey = 'replication.seconds_behind_master';
  const lagRaw = factValue(report.facts, lagKey);
  if (lagRaw === undefined || lagRaw === null) return [];
  const lag = asNum(lagRaw);
  if (Number.isNaN(lag)) return [];
  if (lag <= thresholds.replicaLagSeconds) return [];
  return [
    {
      id: 'REPLICA_LAG:replication',
      severity: 'warn',
      title: '复制延迟偏高',
      detail: `Seconds_Behind_Master=${lag}s 超过阈值 ${thresholds.replicaLagSeconds}s；发布期间可能加剧延迟。`,
      related: [lagKey, 'server.mysql_version'],
      recommendation: '等待延迟追平后再执行 DDL；或将本变更放入低延迟窗口。',
    },
  ];
}

// ---------------------------------------------------------------------------
// 规则 5：GTID_MISMATCH（warn）
// ---------------------------------------------------------------------------

/**
 * GTID_MISMATCH（v1 简化）：v1 只识别「非完全一致的 gtid 状态」。
 *
 * 目标库 gtid_mode 不是 'OFF' 且不是 'ON' 时告警（如 'ON_PERMISSIVE'、'OFF_PERMISSIVE'
 * 等中间态）；'OFF' 视为可跳过（未启用 GTID，无一致性约束）；'ON' 视为已启用一致状态。
 *
 * 注意：v1 无法读取主库的 gtid_mode（Preflight 只读 B 库），
 * 无法判定「主从 gtid_mode 不一致」；这一部分推迟到 v2。
 *
 * subject = `replication`。
 */
export function ruleGtidMismatch(input: RuleInput): PreflightIssue[] {
  const { report } = input;
  const gtidKey = 'replication.gtid_mode';
  const gtidMode = asStr(factValue(report.facts, gtidKey));
  if (!gtidMode || gtidMode === 'OFF' || gtidMode === 'ON') return [];
  return [
    {
      id: 'GTID_MISMATCH:replication',
      severity: 'warn',
      title: 'GTID 模式非一致状态',
      detail: `目标库 @@gtid_mode='${gtidMode}'（既非 'OFF' 也非 'ON'，属中间态或不完全一致状态）。`,
      related: [gtidKey, 'server.mysql_version'],
      recommendation:
        '确认主从 GTID 模式一致；若在迁移中，等待迁移完成或临时关闭中间态配置。',
    },
  ];
}

// ---------------------------------------------------------------------------
// 规则 6：PERMISSION_INCOMPLETE（warn）
// ---------------------------------------------------------------------------

/**
 * PERMISSION_INCOMPLETE：从 permissions fact 判断 reliable===false 或 visibility!=='full'。
 *
 * subject = `permissions`。
 */
export function rulePermissionIncomplete(input: RuleInput): PreflightIssue[] {
  const { report } = input;
  const reliable = factValue(report.facts, 'permissions.reliable');
  const visibility = asStr(factValue(report.facts, 'permissions.visibility'));
  const unreliable = reliable === false || reliable === 0 || reliable === 'false';
  const notFull = visibility !== '' && visibility !== 'full';
  if (!unreliable && !notFull) return [];
  const reasons: string[] = [];
  if (unreliable) reasons.push('可靠度判据失败');
  if (notFull) reasons.push(`visibility='${visibility}' 非 full`);
  return [
    {
      id: 'PERMISSION_INCOMPLETE:permissions',
      severity: 'warn',
      title: '授权不完整',
      detail: `${reasons.join('；')}；可能存在不可见的对象（授权盲区）。`,
      related: ['permissions.reliable', 'permissions.visibility'],
      recommendation:
        '使用库级 SELECT/ALL PRIVILEGES 授权重新建立连接，或确认本次比较范围已完整。',
    },
  ];
}

// ---------------------------------------------------------------------------
// 规则 7：LARGE_TABLE_INSTANT_ADD（warn，正面）
// ---------------------------------------------------------------------------

/**
 * LARGE_TABLE_INSTANT_ADD：DDL 为 ADD_COLUMN **且** MySQL ≥ 8.0.12
 * **且** 目标表 TABLE_ROWS ≥ bigTableRows **且** 矩阵判定可用 INSTANT。
 *
 * 这是**正面**推断（复用 issue 结构，severity='warn'）：提示用户该 DDL 可用 INSTANT 加速，
 * 因为 v1 的 lookupOnlineDdl 已对 ≥ 8.0.12 乐观推断为 INSTANT。
 *
 * subject = `diff-item:<item.id>`（规则主体是具体 DDL 而非表）。
 */
export function ruleLargeTableInstantAdd(input: RuleInput): PreflightIssue[] {
  const { report, items, thresholds } = input;
  const mysqlVer = mysqlVersion(report.facts);
  if (!versionAtLeast(mysqlVer, '8.0.12')) return [];
  const issues: PreflightIssue[] = [];
  for (const item of items) {
    const cls = classifyDdl(item.sql);
    if (cls.op !== 'ADD_COLUMN' || !cls.tableName) continue;
    const online = lookupOnlineDdl(cls.op, mysqlVer);
    if (!online || online.algorithm !== 'INSTANT') continue;
    const rowsKey = `table.${cls.tableName}.rows`;
    const rows = asNum(factValue(report.facts, rowsKey));
    if (rows < thresholds.bigTableRows) continue;
    issues.push({
      id: `LARGE_TABLE_INSTANT_ADD:diff-item:${item.id}`,
      severity: 'warn',
      title: `表 ${cls.tableName} 的大表 ADD_COLUMN 可用 INSTANT 加速`,
      detail: `MySQL ${mysqlVer} 支持 INSTANT 追加列；TABLE_ROWS=${rows} 远超阈值，用 INSTANT 可避免重建。`,
      related: [rowsKey, 'server.mysql_version', `diff-item:${item.id}`],
      recommendation: `该 DDL 可用 \`ALGORITHM=INSTANT\` 加速，避免长锁与重建。`,
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 规则 8：NO_UNIQUE_INDEX_AFTER_CHANGE（warn）
// ---------------------------------------------------------------------------

/**
 * NO_UNIQUE_INDEX_AFTER_CHANGE：DDL 分类为 DROP_INDEX **且** 目标索引是唯一索引
 * **且** 移除后目标表无任何唯一索引。
 *
 * subject = `table.<tableName>`；非唯一索引的 DROP_INDEX 不触发。
 */
export function ruleNoUniqueIndexAfterChange(input: RuleInput): PreflightIssue[] {
  const { report, items } = input;
  const issues: PreflightIssue[] = [];
  for (const item of items) {
    const cls = classifyDdl(item.sql);
    if (cls.op !== 'DROP_INDEX') continue;
    if (!cls.tableName) continue;
    const pkKey = `table.${cls.tableName}.primary_indexes`;
    const primary = factValue(report.facts, pkKey);
    const primaryCount = Array.isArray(primary) ? primary.length : 0;
    const uniqueKey = `table.${cls.tableName}.unique_indexes`;
    const unique = factValue(report.facts, uniqueKey);
    const uniqueList = Array.isArray(unique) ? unique.map((u) => String(u)) : [];
    if (uniqueList.length === 0) continue;
    const droppedIndex = cls.indexName ?? '';
    const isUnique = primaryCount > 0 ? droppedIndex === 'PRIMARY' : uniqueList.includes(droppedIndex);
    if (!isUnique) continue;
    const remainingUnique = primaryCount === 0 ? uniqueList.filter((n) => n !== droppedIndex) : [];
    if (remainingUnique.length > 0) continue;
    issues.push({
      id: `NO_UNIQUE_INDEX_AFTER_CHANGE:table.${cls.tableName}`,
      severity: 'warn',
      title: `表 ${cls.tableName} 变更后无任何唯一索引`,
      detail: `移除索引 ${droppedIndex} 后，该表将不再有任何唯一索引，可能影响数据一致性保障。`,
      related: [pkKey, uniqueKey, `diff-item:${item.id}`],
      recommendation: '确认是否保留至少一个唯一约束；若无业务必要，可忽略。',
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 规则 9：LARGE_TABLE_REBUILD（warn）
// ---------------------------------------------------------------------------

/**
 * LARGE_TABLE_REBUILD：(DATA_LENGTH + INDEX_LENGTH) > 5 GiB **且** DDL 判定 rebuildsTable。
 *
 * subject = `table.<tableName>`。
 */
const FIVE_GIB_BYTES = 5 * 1024 * 1024 * 1024;

export function ruleLargeTableRebuild(input: RuleInput): PreflightIssue[] {
  const { report, items } = input;
  const mysqlVer = mysqlVersion(report.facts);
  const issues: PreflightIssue[] = [];
  for (const item of items) {
    const cls = classifyDdl(item.sql);
    if (cls.op === 'OTHER' || !cls.tableName) continue;
    const online = lookupOnlineDdl(cls.op, mysqlVer);
    if (!online?.rebuildsTable) continue;
    const dataLength = asNum(factValue(report.facts, `table.${cls.tableName}.data_length`));
    const indexLength = asNum(factValue(report.facts, `table.${cls.tableName}.index_length`));
    const total = dataLength + indexLength;
    if (total <= FIVE_GIB_BYTES) continue;
    issues.push({
      id: `LARGE_TABLE_REBUILD:table.${cls.tableName}`,
      severity: 'warn',
      title: `表 ${cls.tableName} 大表重建`,
      detail: `(DATA_LENGTH + INDEX_LENGTH)=${total} 字节（约 ${(total / 1024 / 1024 / 1024).toFixed(2)} GiB）超过 5 GiB 阈值，且 ${cls.op} 判定重建表。`,
      related: [
        `table.${cls.tableName}.data_length`,
        `table.${cls.tableName}.index_length`,
        `diff-item:${item.id}`,
      ],
      recommendation:
        '考虑使用 pt-online-schema-change / gh-ost 分块复制；或将发布窗口调整到低峰时段。',
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const RULES: ReadonlyArray<(input: RuleInput) => PreflightIssue[]> = [
  ruleBigTableCopy,
  ruleNoPrimaryKey,
  ruleReplicaLag,
  ruleReadOnlyTarget,
  ruleGtidMismatch,
  rulePermissionIncomplete,
  ruleLargeTableInstantAdd,
  ruleNoUniqueIndexAfterChange,
  ruleLargeTableRebuild,
];

/** 应用所有规则，返回触发的 Issue 列表（顺序固定：不重复、可复现）。 */
export function evaluateRules(input: RuleInput): PreflightIssue[] {
  const out: PreflightIssue[] = [];
  for (const rule of RULES) {
    out.push(...rule(input));
  }
  return out;
}
