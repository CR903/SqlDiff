# Design — 生产 Preflight v1（只读变更检查）

## Architecture / Boundaries

改动落在既有三层，不新增模块边界：

```
src-core/preflight-types.ts    PreflightReport / Fact / Inference / Unknown / Issue 类型契约
src-core/preflight-ddl.ts      DDL 分类器 + Online DDL 矩阵（纯函数）
src-core/preflight-rules.ts    高风险规则评估（纯函数）
src-core/preflight.ts          buildPreflightReport（纯函数：facts + items → PreflightReport）
src-main/preflight-collect.ts  只读采集器（Server / Variables / Tables / Indexes / Replication / Grants）
src-main/preflight-run.ts      编排：连接 → 采集 → 分类 → 评估 → PreflightReport
src-main/preload.ts            IPC：preflight.run
src-main/main.ts               IPC handler
src-renderer/App.tsx           UI 入口按钮 + 导出（复用 downloadJsonFile / downloadTextFile）
src-renderer/store.ts          记录 lastPreflightResult（可选，用于重新展示）
```

核心原则：

1. **分类 / 矩阵 / 规则是纯函数**——`src-core` 层可单测，不依赖 mysql2 / Node API。
2. **只读采集是 main 层**——直接调用 mysql2 pool，复用 `DbQueryable` 抽象（`metadata.ts:19-21`）。
3. **PreflightReport 构建是纯函数**——`buildPreflightReport` 输入 facts + items + target，输出报告；不触碰 vault / secret。
4. **导出复用现有下载通道**——`downloadJsonFile` / `downloadTextFile`（`renderer/sql.ts:101-124`）。

## Contracts

### 1. Preflight 输出（`src-core/preflight-types.ts`）

```ts
export const PREFLIGHT_REPORT_VERSION = 1;

export type PreflightCategory =
  | 'server'      // 版本、SQL_MODE、系统变量
  | 'table'       // 表规模、空间、引擎
  | 'index'       // 主键、唯一/普通索引、外键
  | 'ddl'         // 每条 DDL 的分类与算法判定
  | 'replication' // 复制状态
  | 'permissions' // 授权可见性
  | 'variables';  // 其它系统变量

export type PreflightFactSource =
  | 'select-version'
  | 'select-sysvars'
  | 'information-schema.tables'
  | 'information-schema.statistics'
  | 'information-schema.key-column-usage'
  | 'show-replica-status'
  | 'show-slave-status'
  | 'show-grants-for-current-user';

export interface PreflightFact {
  category: PreflightCategory;
  key: string;              // 例：'version', 'sql_mode', 'table.orders.rows'
  value: unknown;           // 原始值（数字 / 字符串 / 布尔 / null）
  source: PreflightFactSource;
  observedAt: string;       // ISO 时间
}

export type PreflightInferenceConfidence = 'high' | 'medium' | 'low';

export interface PreflightInference {
  category: PreflightCategory;
  subject: string;          // 例：'table.orders' 或 'diff-item:d12'
  statement: string;        // 人可读的一行结论
  confidence: PreflightInferenceConfidence;
  evidence: string[];       // Fact.key 列表（能追溯到具体事实）
  ruleId: string;           // 例：'BIG_TABLE_COPY' / 'INPLACE_ALGORITHM'
}

export type PreflightUnknownReason =
  | 'permission-denied'
  | 'query-failed'
  | 'unsupported-version'
  | 'not-applicable'
  | 'unparsed-ddl';

export interface PreflightUnknown {
  category: PreflightCategory;
  subject: string;          // 例：'replication.status' 或 'diff-item:d21'
  reason: PreflightUnknownReason;
  attempt: string;          // 尝试了什么查询/规则
  observedAt: string;
}

export type PreflightIssueSeverity = 'block' | 'warn';

export interface PreflightIssue {
  id: string;               // 例：'BIG_TABLE_COPY:table.orders'
  severity: PreflightIssueSeverity;
  title: string;            // 例：'表 orders 变更将重建表'
  detail: string;           // 详细说明
  related: string[];        // Fact.key / Inference.subject 混合
  recommendation: string;   // 建议动作
}

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
    blocking: number;       // issues 中 severity=block 的计数
    warnings: number;       // severity=warn 的计数
    unknowns: number;       // unknowns.length
  };
}
```

### 2. DDL 分类（`src-core/preflight-ddl.ts` 纯函数）

```ts
export type DdlOp =
  | 'ADD_COLUMN'
  | 'DROP_COLUMN'
  | 'MODIFY_COLUMN'
  | 'CHANGE_COLUMN'
  | 'ADD_INDEX'
  | 'ADD_UNIQUE_INDEX'
  | 'ADD_PRIMARY_KEY'
  | 'DROP_INDEX'
  | 'CONVERT_TO_CHAR_SET'
  | 'CHANGE_ENGINE'
  | 'CREATE_TABLE'
  | 'DROP_TABLE'
  | 'RENAME_TABLE'
  | 'CREATE_INDEX'
  | 'DROP_INDEX_STANDALONE'
  | 'OTHER';

export interface DdlClassification {
  op: DdlOp;
  tableName: string | null;
  columnName: string | null;
  indexName: string | null;
  confidence: 'high' | 'medium' | 'low';
}

/** 从 DDL 文本分类出 DdlOp。纯函数，正则/关键字驱动，不做完整 SQL AST。 */
export function classifyDdl(sql: string): DdlClassification
```

分类规则（按优先级）：

| 模式 | Op |
|---|---|
| `^(?i)DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?` | DROP_TABLE |
| `^(?i)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?` | CREATE_TABLE |
| `^(?i)RENAME\s+TABLE` | RENAME_TABLE |
| `^(?i)CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?` | CREATE_INDEX |
| `^(?i)DROP\s+(?:UNIQUE\s+)?INDEX\s+` | DROP_INDEX_STANDALONE |
| `(?i)ALTER\s+TABLE\s+.*\bADD\s+PRIMARY\s+KEY\b` | ADD_PRIMARY_KEY |
| `(?i)ALTER\s+TABLE\s+.*\bADD\s+UNIQUE\s+(?:KEY\|INDEX)\b` | ADD_UNIQUE_INDEX |
| `(?i)ALTER\s+TABLE\s+.*\bADD\s+(?:FULLTEXT\|SPATIAL\|KEY\|INDEX)\b` | ADD_INDEX |
| `(?i)ALTER\s+TABLE\s+.*\bDROP\s+(?:KEY\|INDEX)\b` | DROP_INDEX |
| `(?i)ALTER\s+TABLE\s+.*\bDROP\s+COLUMN\b` | DROP_COLUMN |
| `(?i)ALTER\s+TABLE\s+.*\bCHANGE\s+COLUMN?\b` | CHANGE_COLUMN |
| `(?i)ALTER\s+TABLE\s+.*\bMODIFY\s+COLUMN?\b` | MODIFY_COLUMN |
| `(?i)ALTER\s+TABLE\s+.*\bADD\s+COLUMN?\b` | ADD_COLUMN |
| `(?i)ALTER\s+TABLE\s+.*\bCONVERT\s+TO\s+CHARACTER\s+SET\b` | CONVERT_TO_CHAR_SET |
| `(?i)ALTER\s+TABLE\s+.*\bENGINE\s*=` | CHANGE_ENGINE |
| 其它 | OTHER |

多条 ALTER 子句的复合语句（如 `ALTER TABLE t ADD COLUMN a, ADD COLUMN b`）—— v1 只按**首条**匹配归类，并在 inference 里注明「多条 ALTER 子句，取首个操作类别」。

### 3. Online DDL 矩阵（内置静态表）

```ts
export interface OnlineDdlInfo {
  algorithm: 'INSTANT' | 'INPLACE' | 'COPY';
  lockMode: 'NONE' | 'SHARED' | 'EXCLUSIVE' | 'EXCLUSIVE-BRIEF';
  rebuildsTable: boolean;
  /** 版本下限（形如 '8.0.12'）；低于此版本该算法不可用。 */
  availableFrom: string | null;
  notes: string;             // 例：'仅当 ADD COLUMN 无默认值且为最后一个列时可用 INSTANT'
}

/** 版本前缀比较：'8.0.36' >= '8.0.12'。纯函数。 */
export function versionAtLeast(actual: string, required: string): boolean

/** 查矩阵：按 DdlOp + MySQL 版本返回 OnlineDdlInfo。 */
export function lookupOnlineDdl(op: DdlOp, mysqlVersion: string): OnlineDdlInfo | null
```

矩阵内容（节选，覆盖 MySQL 8.0 官方 [Online DDL operations matrix](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html) 的高频操作；5.7 差异通过 `availableFrom` 字段处理）：

| Op | algorithm | lockMode | rebuildsTable | availableFrom | notes |
|---|---|---|---|---|---|
| ADD_INDEX | INPLACE | SHARED | false | 5.6 | 非 UNIQUE、非 PRIMARY KEY |
| ADD_UNIQUE_INDEX | INPLACE | SHARED | true | 5.6 | 需重建表 |
| ADD_PRIMARY_KEY | INPLACE | EXCLUSIVE | true | 5.6 | 需重建表 + 排他锁 |
| DROP_INDEX | INPLACE | SHARED | false | 5.6 | |
| ADD_COLUMN | INPLACE | SHARED | true | 5.6 | 默认；8.0.12+ 且无默认值时 INSTANT |
| ADD_COLUMN (instant) | INSTANT | SHARED | false | 8.0.12 | 附加列且无默认值 |
| DROP_COLUMN | INPLACE | SHARED | true | 5.6 | 8.0.29+ 支持 INSTANT DROP |
| MODIFY_COLUMN (same type) | INPLACE | SHARED | true | 5.6 | 需重建表 |
| MODIFY_COLUMN (type change) | INPLACE | SHARED | true | 5.6 | 需重建表 |
| CHANGE_COLUMN | INPLACE | SHARED | true | 5.6 | 需重建表 |
| CONVERT_TO_CHAR_SET | INPLACE | SHARED | true | 5.6 | 需重建表；字符集扩张时空间翻倍 |
| CHANGE_ENGINE | INPLACE | SHARED | true | 5.6 | |
| CREATE_TABLE | INPLACE | EXCLUSIVE-BRIEF | n/a | 5.6 | |
| DROP_TABLE | INPLACE | EXCLUSIVE-BRIEF | n/a | 5.6 | |
| RENAME_TABLE | INPLACE | EXCLUSIVE-BRIEF | n/a | 5.6 | |

- **版本低于矩阵 `availableFrom`**：返回 `algorithm: 'COPY'`, `rebuildsTable: true`, `notes: '低于 X.Y.Z，默认 COPY'`；若版本 < 5.6，返回 `null` 由上层记为 `unsupported-version`。
- **矩阵完全找不到**：返回 `null`，上层记为 `unparsed-ddl` Unknown。

### 4. 高风险规则（`src-core/preflight-rules.ts` 纯函数）

```ts
export interface RuleInput {
  report: {
    facts: PreflightFact[];
    inferences: PreflightInference[];
    unknowns: PreflightUnknown[];
  };
  items: DiffItem[];         // 传入的 DDL/DML 项（v1 只处理 DDL）
  thresholds: {
    bigTableRows: number;    // 默认 1_000_000
    replicaLagSeconds: number;  // 默认 30
  };
}

/** 应用所有规则，返回触发的 Issue 列表。 */
export function evaluateRules(input: RuleInput): PreflightIssue[]
```

规则清单（每条独立函数 + 独立单测）：

| ruleId | severity | 触发条件 |
|---|---|---|
| `BIG_TABLE_COPY` | block | 目标表 `TABLE_ROWS > thresholds.bigTableRows` **且** DDL 分类算法为 `COPY` 或 `rebuildsTable=true` |
| `NO_PRIMARY_KEY` | warn | 目标表 `indexes.primary.length === 0` **且** DDL 分类为 `DROP_INDEX` / `DROP_COLUMN` |
| `REPLICA_LAG` | warn | `replication.status.seconds_behind_master > thresholds.replicaLagSeconds` |
| `READ_ONLY_TARGET` | block | `server.read_only === true` **或** `server.super_read_only === true` |
| `GTID_MISMATCH` | warn | `replication.gtid_mode` 主从模式不一致（若可查） |
| `PERMISSION_INCOMPLETE` | warn | `permissions.reliable === false` 或 `permissions.visibility !== 'full'` |
| `LARGE_TABLE_INSTANT_ADD` | warn | DDL 为 `ADD_COLUMN` **且** MySQL ≥ 8.0.12 **且** 表规模 ≥ bigTableRows **且** 该 ADD 可用 INSTANT → 记为**正面**推断（recommendation 提示用户可用 INSTANT 加速） |
| `NO_UNIQUE_INDEX_AFTER_CHANGE` | warn | DDL 分类为 `DROP_INDEX` 且该索引是唯一索引且移除后目标表无任何唯一索引 |
| `LARGE_TABLE_REBUILD` | warn | 目标表 `DATA_LENGTH + INDEX_LENGTH > 5GB` **且** DDL 判定 `rebuildsTable=true` |

`LARGE_TABLE_INSTANT_ADD` 是**正面**推断但复用 issue 结构：`severity: 'warn'`，`recommendation` 文本是「该 DDL 可用 ALGORITHM=INSTANT 加速」。

### 5. 报告构建（`src-core/preflight.ts` 纯函数）

```ts
export interface PreflightBuildInput {
  facts: PreflightFact[];
  inferences: PreflightInference[];
  unknowns: PreflightUnknown[];
  items: DiffItem[];             // 传入的 DiffItem 列表
  targetAlias: string;
  targetDatabase: string;
  appVersion: string;
}

/** 计算 verdict（level + 计数），不修改入参。 */
export function deriveVerdict(issues: PreflightIssue[], unknowns: PreflightUnknown[]): PreflightReport['verdict']

/** 构建完整 PreflightReport（纯函数，byte 稳定）。 */
export function buildPreflightReport(input: PreflightBuildInput): PreflightReport

/** JSON 序列化。 */
export function serializePreflight(m: PreflightReport): string

/** Markdown 人工报告。 */
export function preflightToMarkdown(m: PreflightReport): string

/** 导出文件名（含时间戳）。 */
export function preflightFileNames(checkedAt: string): { jsonFileName: string; markdownFileName: string }
```

### 6. 只读采集器（`src-main/preflight-collect.ts`）

复用 `metadata.ts` 的 `DbQueryable` 抽象，新增六个采集函数，每个都**只读**且**永不抛错**（错误转 Unknown）：

```ts
export interface PreflightCollectHooks {
  signal?: AbortSignal;
  /** 每采集完一类 fact 回调一次，供 UI 展示进度。 */
  onProgress?: (category: PreflightCategory, collected: number) => void;
}

export async function collectServerFacts(db: DbQueryable): Promise<CollectedFact[]>
export async function collectVariablesFacts(db: DbQueryable): Promise<CollectedFact[]>
export async function collectTableFacts(db: DbQueryable, database: string, tables: string[]): Promise<CollectedFact[]>
export async function collectIndexFacts(db: DbQueryable, database: string, tables: string[]): Promise<CollectedFact[]>
export async function collectReplicationFacts(db: DbQueryable): Promise<CollectedFact[]>
export async function collectGrantFacts(db: DbQueryable): Promise<CollectedFact[]>
```

SQL 清单（严格只读）：

- `SELECT VERSION(), @@version_comment, @@sql_mode, @@innodb_file_per_table, @@transaction_isolation, @@lower_case_table_names, @@character_set_server, @@collation_server`
- `SELECT @@innodb_buffer_pool_size, @@max_connections, @@tmp_table_size, @@sort_buffer_size, @@thread_cache_size, @@innodb_page_size, @@max_allowed_packet`
- `SELECT table_name, table_rows, data_length, index_length, data_free, engine, row_format, auto_increment, update_time, checksum FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?, ?, ...)`（分批，每批 100 个表名）
- `SELECT table_name, index_name, column_name, seq_in_index, non_unique FROM information_schema.statistics WHERE table_schema = ? AND table_name IN (?, ?, ...)`
- `SELECT table_name, constraint_name, column_name FROM information_schema.key_column_usage WHERE table_schema = ? AND referential_constraint IS NOT NULL`（外键）
- `SHOW REPLICA STATUS`（MySQL 8.0.22+）；失败则降级 `SHOW SLAVE STATUS`（MySQL 5.7 / 8.0.21-）；再失败记 `not-applicable`
- `SELECT @@server_id, @@read_only, @@super_read_only, @@log_bin, @@gtid_mode`
- `SHOW GRANTS FOR CURRENT_USER()`（复用 `assessVisibility`）

**任何新增 SQL 都必须落到 `database-guidelines.md:17-22` 清单的 `SELECT` / `SHOW` / `@@` / `information_schema` 范围内**；不引入 `SET`、`SELECT ... FOR UPDATE`、`INSERT`、`UPDATE`、`DELETE`。

### 7. IPC 契约（`src-main/preload.ts` + `src-main/main.ts`）

```ts
// preload.ts
preflight: {
  run: (input: PreflightRequest) => Promise<PreflightExportResult>;
}

export interface PreflightRequest {
  bId: string;                       // 目标库节点
  items: DiffItem[];                 // 已完成的比较结果中的 DDL 项（renderer 传入）
  bAlias: string;
  bDatabase: string;
  thresholds?: { bigTableRows?: number; replicaLagSeconds?: number };
}

export interface PreflightExportResult {
  jsonFileName: string;
  markdownFileName: string;
  jsonContent: string;
  markdownContent: string;
  verdictLevel: PreflightReport['verdict']['level'];
}
```

**关键设计**：`items` 由 renderer 传入，因为 `CompareResult.items` 已经在 renderer 内存里；main 侧不重复拉取，只读 B 库运行时状态。**敏感 DML 已在 renderer，preflight 只读不写，导出物只含 Fact/Inference/Unknown，不含 DML 原文**（Preflight 只关心 DDL，DDL 原文可从 DiffItem.sql 拿到，但导出物只保留分类结果，不重复 sql）。

## Data Flow

```
用户点击「运行 Preflight」：
  App 从 store 拿 lastCompareRequest 与当前 CompareResult
  调 preflight.run({
    bId, items: result.items.filter(i => i.objectType !== 'data'),
    bAlias, bDatabase,
  })
  → main: createMysqlPool(nodeB, secretB)
     → collectServerFacts / collectVariablesFacts / collectTableFacts / collectIndexFacts
       / collectReplicationFacts / collectGrantFacts（可并发）
     → 每条 item：classifyDdl → lookupOnlineDdl → 生成 ddl inference
     → evaluateRules({ facts, inferences, unknowns, items, thresholds })
     → deriveVerdict(issues, unknowns)
     → buildPreflightReport(input)
     → serializePreflight + preflightToMarkdown
  → renderer 拿到 PreflightExportResult，用 downloadJsonFile / downloadTextFile 下载
  → UI 展示 verdict.level 与 issue 计数（不自动阻断）
```

**并发策略**：Server / Variables / Grants 无依赖可并发；Tables / Indexes 依赖 Tables 的表清单，串行。Replication 与其它独立，可并发。

**取消语义**：`AbortSignal` 传入每个采集函数；用户取消时已完成的采集保留，未完成的记 `aborted` Unknown。

## Trade-offs

| 选择 | 代价 | 理由 |
|---|---|---|
| DDL 分类用正则，不用完整 SQL AST | 复杂 SQL 可能被误分类 | 完整 AST 是数月级工程，v1 目标是「分类高频 90% DDL」；OTHER 记 Unknown |
| 矩阵为内置静态表 | 需随 MySQL 版本演进维护 | 官方矩阵是外部 FACT，产品不应在运行时抓文档；Unknown 而非猜测 |
| 阈值内置默认 | 不同生产规模需手动覆盖 | v1 优先验证价值；配置 UI 属后续 |
| PreflightReport 与 ReviewManifest 分离 | 两个导出物 | 差异记录 vs 应用风险是两种工件；互补不替代 |
| 数据 DML 不纳入 v1 | 数据变更的 preflight 语义（trigger / partition / foreign key）属后续 | 与 reconciliation 报告高度重叠，单独排期 |
| Preflight 只读 B 侧 | 忽略 A 侧运行时状态 | 变更应用到 B；A 侧状态与本次发布无关 |

## Compatibility

- **不改** `CompareResult` / `DiffItem` / `ReviewManifest` / `CoverageStatus`。
- **新增** 三个独立 schema：`PreflightReport`（v1）、DDL 矩阵表、规则表。
- IPC 新增 `preflight.run`，纯增量。
- Store 新增 `lastPreflightResult`（可选，v1 不落盘，仅内存），不破坏既有字段。
- 只读 SQL 清单扩展（`information_schema.statistics` / `key_column_usage` / `SHOW REPLICA STATUS`），需在 `database-guidelines.md` 记录。

## Rollout / Rollback

1. `src-core/preflight-types.ts` + `preflight-ddl.ts` + `preflight-rules.ts` + `preflight.ts`：纯函数新增，可独立 typecheck + 单测。
2. `src-main/preflight-collect.ts`：采集器，纯 main 层，无 renderer 依赖。
3. `src-main/preflight-run.ts` + `preload.ts` + `main.ts`：IPC 编排，可独立 typecheck。
4. `src-renderer/store.ts` + `App.tsx`：UI 入口，可独立回滚。

回滚点：步骤 4 可单独回滚（UI 入口），1–3 纯增量无破坏。

## Operational Notes

- 所有新增 SQL 必须通过 `grep -n "SELECT\|SHOW\|SET" apps/desktop/src-main/preflight-collect.ts` 人工审核一次，确认无 `SET` / `INSERT` / `UPDATE` / `DELETE` / `FOR UPDATE`。
- DDL 分类器正则必须覆盖 MySQL 5.7 与 8.0 两个版本的高频 DDL（≥10 种 Op）；未覆盖的走 OTHER → Unknown。
- 矩阵 `lookupOnlineDdl` 必须处理 `availableFrom` 版本比较（含 patch 位，如 `8.0.12`）。
- 规则评估必须是纯函数，`facts` / `inferences` / `unknowns` 传入后不修改，方便单测断言。
- PreflightReport 的 `issues[].related` 是 `Fact.key` 或 `Inference.subject` 的字符串引用，不深拷贝——便于用户在导出物中从 Issue 追溯到具体事实。
- 采集器的错误分类复用 `metadata.ts:182-223` 的 `PERMISSION_ERRNOS` / `PERMISSION_CODES` 常量；避免重复定义。
- `SHOW REPLICA STATUS` 与 `SHOW SLAVE STATUS` 的降级链必须单测覆盖（8.0.22+ 前者成功，5.7 后者成功，两者都失败 → `not-applicable`）。
