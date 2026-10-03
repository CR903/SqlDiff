// Preflight E2E helpers：构造 PreflightRequest.items + 报告断言工具。
// 独立于产品代码，只在 e2e 层使用；不改 src-core / src-main。
//
// 边界：
// - buildFixtureItems 手工构造 11 条 DDL，覆盖 10 种 DdlOp + 1 条 OTHER，
//   与 `.trellis/tasks/10-03-preflight-e2e-mysql-8/design.md §2` 一一对应；
// - 断言工具只做观测（不 throw 产品错误）；对不存在的 Inference / Issue 返回 undefined，
//   让 spec 层能给出更精确的失败信息；
// - PreflightInference 没有 algorithm 字段（见 `src-core/preflight-types.ts`），
//   算法信息内嵌在 `statement` 字符串里（形如 "d01: ADD_COLUMN on users_big → INSTANT/SHARED"），
//   所以 `assertInstantAddDrop` 用字符串匹配判定。
//
// DiffItem 字段对齐 `src-core/types.ts` 的实际定义：
// - `id` / `objectType` / `objectName` / `changeType` / `aspects`（数组）/ `risk` / `sql` 均必填；
// - `dml` / `rollback` / `explain` 可选；
// - 任务描述里的 `verb` / `aspect` 单数字段不存在于 DiffItem 类型，此处改为
//   `changeType`（'CREATE'|'DROP'|'CHANGE'）+ `aspects: StmtAspect[]`。

import type { DiffItem, RiskLevel, StmtAspect } from '../../src-core/types';
import type {
  PreflightFact,
  PreflightInference,
  PreflightIssue,
  PreflightReport,
  PreflightUnknown,
} from '../../src-core/preflight-types';

/** 单条表级 DiffItem 构造辅助（避免每条重复写完整对象字面量）。 */
function tableItem(opts: {
  id: string;
  objectName: string;
  changeType: DiffItem['changeType'];
  aspects: StmtAspect[];
  risk: RiskLevel;
  sql: string;
}): DiffItem {
  return {
    id: opts.id,
    objectType: 'table',
    objectName: opts.objectName,
    changeType: opts.changeType,
    aspects: opts.aspects,
    risk: opts.risk,
    sql: opts.sql,
  };
}

/**
 * 构造 11 条 fixture DDL，覆盖：
 * - d01 ADD_COLUMN on users_big（~100 万行）→ 触发 LARGE_TABLE_INSTANT_ADD（≥8.0.12）
 * - d02 DROP_COLUMN on orders_empty → INSTANT ADD/DROP 版本分叉断言锚点
 * - d03 ADD INDEX
 * - d04 ADD UNIQUE INDEX
 * - d05 DROP INDEX
 * - d06 ADD PRIMARY KEY
 * - d07 CHANGE COLUMN
 * - d08 MODIFY COLUMN
 * - d09 CONVERT TO CHARACTER SET
 * - d10 CHANGE ENGINE
 * - d11 ALTER TABLE ... ADD PARTITION → 落入 OTHER → unparsed-ddl Unknown
 *
 * 注：DDL 引用的表 / 列名不需要在 fixture 库里真的存在——preflight 只分类 DDL 文本
 * 并查该表在 information_schema 里的运行时状态，不执行 DDL。但目标表名（如 users_big、
 * orders_empty 等）需要与 `mysql-fixture.ts` 的 8 表清单对齐，才能让 `collectTableFacts`
 * 拉到真实 rows / data_length / index_length / primary_indexes 等事实。
 */
export function buildFixtureItems(): DiffItem[] {
  return [
    tableItem({
      id: 'd01',
      objectName: 'users_big',
      changeType: 'CHANGE',
      aspects: ['column'],
      risk: 'low',
      sql: 'ALTER TABLE users_big ADD COLUMN nickname VARCHAR(50)',
    }),
    tableItem({
      id: 'd02',
      objectName: 'orders_empty',
      changeType: 'DROP',
      aspects: ['column'],
      risk: 'medium',
      sql: 'ALTER TABLE orders_empty DROP COLUMN created_at',
    }),
    tableItem({
      id: 'd03',
      objectName: 'products_no_pk',
      changeType: 'CHANGE',
      aspects: ['index'],
      risk: 'low',
      sql: 'ALTER TABLE products_no_pk ADD INDEX idx_name (name)',
    }),
    tableItem({
      id: 'd04',
      objectName: 'tags_unique',
      changeType: 'CHANGE',
      aspects: ['index'],
      risk: 'low',
      sql: 'ALTER TABLE tags_unique ADD UNIQUE INDEX idx_new (slug)',
    }),
    tableItem({
      id: 'd05',
      objectName: 'events_fk',
      changeType: 'DROP',
      aspects: ['index'],
      risk: 'medium',
      sql: 'ALTER TABLE events_fk DROP INDEX idx_legacy',
    }),
    tableItem({
      id: 'd06',
      objectName: 'config_wide',
      changeType: 'CHANGE',
      aspects: ['primary'],
      risk: 'high',
      sql: 'ALTER TABLE config_wide ADD PRIMARY KEY (id, c01)',
    }),
    tableItem({
      id: 'd07',
      objectName: 'audit_pk_unique',
      changeType: 'CHANGE',
      aspects: ['column'],
      risk: 'medium',
      sql: 'ALTER TABLE audit_pk_unique CHANGE COLUMN audit_key new_key VARCHAR(200)',
    }),
    tableItem({
      id: 'd08',
      objectName: 'slow_log_no_index',
      changeType: 'CHANGE',
      aspects: ['column'],
      risk: 'medium',
      sql: 'ALTER TABLE slow_log_no_index MODIFY COLUMN msg MEDIUMTEXT',
    }),
    tableItem({
      id: 'd09',
      objectName: 'tags_unique',
      changeType: 'CHANGE',
      aspects: ['table'],
      risk: 'high',
      sql: 'ALTER TABLE tags_unique CONVERT TO CHARACTER SET utf8mb4',
    }),
    tableItem({
      id: 'd10',
      objectName: 'orders_empty',
      changeType: 'CHANGE',
      aspects: ['table'],
      risk: 'medium',
      sql: 'ALTER TABLE orders_empty ENGINE=InnoDB',
    }),
    // ADD PARTITION 落入 ADD_COLUMN 正则的负向先行（PARTITION 在负向列表里），
    // 不匹配任何 ALTER TABLE 子模式 → classifyDdl 返回 OTHER → preflight 记 unparsed-ddl Unknown。
    tableItem({
      id: 'd11',
      objectName: 'events_fk',
      changeType: 'CHANGE',
      aspects: ['table'],
      risk: 'low',
      sql: 'ALTER TABLE events_fk ADD PARTITION (PARTITION p0 VALUES LESS THAN (1))',
    }),
  ];
}

// -- 报告结构断言 -------------------------------------------------------------

/** Fact 中必须存在的 5 类 category（ddl 走 inference，replication 可能退化为 not-applicable Unknown）。 */
const REQUIRED_FACT_CATEGORIES = [
  'server',
  'variables',
  'table',
  'index',
  'permissions',
] as const;

/** 断言 PreflightReport 基础结构完整。 */
export function assertReportStructure(report: PreflightReport): void {
  if (report.schemaVersion !== 1) {
    throw new Error(`schemaVersion expected 1, got ${report.schemaVersion}`);
  }
  if (report.source !== 'real') {
    throw new Error(`source expected 'real', got ${report.source}`);
  }
  if (!Array.isArray(report.facts) || report.facts.length === 0) {
    throw new Error('facts must be a non-empty array');
  }

  // 至少覆盖 5 类 Fact（ddl 由 inference 承载；replication 在开发机非从库时会退化为 Unknown）。
  const factCats = new Set(report.facts.map((f) => f.category));
  for (const cat of REQUIRED_FACT_CATEGORIES) {
    if (!factCats.has(cat)) {
      throw new Error(`missing fact category: ${cat}`);
    }
  }

  // 至少要有 ddl 类 inference（每条非 OTHER 的 DDL 都会产生一条）。
  const ddlInferences = report.inferences.filter((i) => i.category === 'ddl');
  if (ddlInferences.length === 0) {
    throw new Error('expected at least one ddl-category inference from classifyDdl + lookupOnlineDdl');
  }

  // verdict.level 是运行时校验（TS 类型已限定，但 JSON 反序列化后可能漂移）。
  const verdictLevels: PreflightReport['verdict']['level'][] = ['pass', 'warn', 'block', 'unknown'];
  if (!verdictLevels.includes(report.verdict.level)) {
    throw new Error(`verdict.level invalid: ${String(report.verdict.level)}`);
  }
}

// -- 查找工具（找不到返回 undefined，不断言）--------------------------------

/** 按 subject 找单条 Inference（第一个匹配）。找不到返回 undefined。 */
export function findInferenceBySubject(
  report: PreflightReport,
  subject: string,
): PreflightInference | undefined {
  return report.inferences.find((i) => i.subject === subject);
}

/** 按 id 找单条 Issue。找不到返回 undefined。 */
export function findIssueById(
  report: PreflightReport,
  issueId: string,
): PreflightIssue | undefined {
  return report.issues.find((i) => i.id === issueId);
}

/** 找到所有 subject 匹配的 Unknown（数组，可能为空）。 */
export function findUnknownsBySubject(
  report: PreflightReport,
  subject: string,
): PreflightUnknown[] {
  return report.unknowns.filter((u) => u.subject === subject);
}

/** 按 key 找单条 Fact。找不到返回 undefined。 */
export function findFactByKey(
  report: PreflightReport,
  key: string,
): PreflightFact | undefined {
  return report.facts.find((f) => f.key === key);
}

// -- 语义断言 -------------------------------------------------------------

/**
 * 断言 INSTANT ADD/DROP 的版本分叉：
 * - d01 ADD_COLUMN 双机一致 → algorithm 必须是 INSTANT（MySQL ≥ 8.0.12 的 v1 乐观推断）；
 * - d02 DROP_COLUMN 按 expectedDropAlgo 分叉：
 *   - 8.0.26（<8.0.29）→ INPLACE + rebuildsTable=true；
 *   - 8.0.46（≥8.0.29）→ INSTANT + rebuildsTable=false。
 *
 * PreflightInference 的 algorithm 信息内嵌在 statement 字符串里
 * （`d01: ADD_COLUMN on users_big → INSTANT/SHARED`），
 * 用字符串匹配判定：`INSTANT` / `INPLACE` / `COPY` 三态互斥，不会误命中。
 */
export function assertInstantAddDrop(
  report: PreflightReport,
  expectedDropAlgo: 'INSTANT' | 'INPLACE',
): void {
  const addCol = findInferenceBySubject(report, 'diff-item:d01');
  if (!addCol) throw new Error('d01 (ADD_COLUMN) inference missing');
  if (!addCol.statement.includes('INSTANT')) {
    throw new Error(`d01 ADD_COLUMN expected INSTANT, got statement: ${addCol.statement}`);
  }

  const dropCol = findInferenceBySubject(report, 'diff-item:d02');
  if (!dropCol) throw new Error('d02 (DROP_COLUMN) inference missing');
  if (!dropCol.statement.includes(expectedDropAlgo)) {
    throw new Error(
      `d02 DROP_COLUMN expected ${expectedDropAlgo}, got statement: ${dropCol.statement}`,
    );
  }
}

/**
 * 断言 OTHER 分类的 DiffItem 落到 unparsed-ddl Unknown：
 * - 不能有 inference（`classifyDdl` 返回 OTHER 时直接跳过矩阵查询）；
 * - 必须有一条 subject=`diff-item:<id>` 且 reason='unparsed-ddl' 的 Unknown。
 */
export function assertOtherGoesToUnknown(report: PreflightReport, itemId: string): void {
  const subject = `diff-item:${itemId}`;
  if (findInferenceBySubject(report, subject)) {
    throw new Error(`${subject} should not have inference (OTHER DDL should skip matrix)`);
  }
  const unknowns = findUnknownsBySubject(report, subject);
  if (!unknowns.some((u) => u.reason === 'unparsed-ddl')) {
    throw new Error(
      `${subject} should have unparsed-ddl Unknown, got: ${JSON.stringify(unknowns)}`,
    );
  }
}

/**
 * 断言 Issue 存在且 severity 符合预期（block 阻断 / warn 提示）。
 * Issue.id 约定见 `src-core/preflight-rules.ts`：
 * - BIG_TABLE_COPY:table.<t>
 * - READ_ONLY_TARGET:server
 * - NO_PRIMARY_KEY:table.<t>
 * - LARGE_TABLE_INSTANT_ADD:diff-item:<id>
 * - NO_UNIQUE_INDEX_AFTER_CHANGE:table.<t>
 * - LARGE_TABLE_REBUILD:table.<t>
 */
export function assertIssue(
  report: PreflightReport,
  issueId: string,
  expectedSeverity: 'block' | 'warn',
): PreflightIssue {
  const issue = findIssueById(report, issueId);
  if (!issue) {
    throw new Error(
      `expected Issue "${issueId}", issues present: ${report.issues.map((i) => i.id).join(', ') || '(none)'}`,
    );
  }
  if (issue.severity !== expectedSeverity) {
    throw new Error(`Issue "${issueId}" expected severity=${expectedSeverity}, got ${issue.severity}`);
  }
  return issue;
}

/**
 * 断言 Fact.value 存在且等于期望值（严格 ===，用于 server.mysql_version 之类确定值断言）。
 * Fact.value 类型是 unknown，所以先宽松取，再严格比较。
 */
export function assertFactValue(
  report: PreflightReport,
  key: string,
  expected: unknown,
): void {
  const fact = findFactByKey(report, key);
  if (!fact) {
    throw new Error(`Fact "${key}" missing from report`);
  }
  if (fact.value !== expected) {
    throw new Error(
      `Fact "${key}" expected ${JSON.stringify(expected)}, got ${JSON.stringify(fact.value)}`,
    );
  }
}

/**
 * 断言 Fact.value 是数字且 ≥ 阈值（用于 table.users_big.rows ≥ 1_000_000 之类下界断言）。
 * mysql2 从 information_schema 读出来的数字可能是 number / string，这里统一转成 number。
 */
export function assertFactNumberAtLeast(
  report: PreflightReport,
  key: string,
  min: number,
): void {
  const fact = findFactByKey(report, key);
  if (!fact) {
    throw new Error(`Fact "${key}" missing from report`);
  }
  const raw = fact.value;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(num)) {
    throw new Error(`Fact "${key}" expected number, got ${JSON.stringify(raw)}`);
  }
  if (num < min) {
    throw new Error(`Fact "${key}" expected >= ${min}, got ${num}`);
  }
}
