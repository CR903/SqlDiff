# Backend — 生产 Preflight v1

## 1. 定位与边界

Preflight 面向「把一次比较得到的 DDL 交给外部执行流程**之前**」的一次性只读检查：它不重复比较、不重跑 diff，只读**目标库 B** 的运行时状态（版本、变量、表规模、索引、复制、授权），并把 `DiffItem.sql` 逐条分类后查在线 DDL 矩阵。输出用「事实 / 推断 / 未知」三段结构承载，避免「默认值伪装为确定」的产品语义风险。

与 `ReviewManifest` 的分工：

| 关注点 | ReviewManifest | PreflightReport |
|---|---|---|
| 回答的问题 | 「差异是什么」 | 「应用差异会发生什么」 |
| 数据来源 | `CompareResult` 的确定性投影 | `CompareResult.items` + B 侧只读观测 |
| 是否重跑比较 | 否 | 否 |
| 是否执行 SQL | 否 | 否 |
| schema 版本 | `REVIEW_MANIFEST_VERSION = 1` | `PREFLIGHT_REPORT_VERSION = 1`（**独立版本，不合并**） |
| 脱敏原则 | 无秘密、行值脱敏 | 无秘密、无行值、无原始 `SHOW GRANTS` 文本 |

详见 [Manifest Export Contract](./manifest-export.md)。Preflight 是 v1 的「单目标、只针对 B、只针对表级 DDL」；数据 DML、A 侧、多目标并行均属 Out of Scope。

Source of truth：

- `apps/desktop/src-core/preflight-types.ts`（PreflightReport 契约）
- `apps/desktop/src-core/preflight-ddl.ts`（`classifyDdl` / `lookupOnlineDdl` / `versionAtLeast`）
- `apps/desktop/src-core/preflight-rules.ts`（9 条规则）
- `apps/desktop/src-core/preflight.ts`（`buildPreflightReport` / `deriveVerdict` / `serializePreflight` / `preflightToMarkdown` / `preflightFileNames`）
- `apps/desktop/src-main/preflight-collect.ts`（6 个只读采集函数）
- `apps/desktop/src-main/preflight-run.ts`（8 阶段编排 + `PreflightRequest` / `PreflightExportResult`）
- `apps/desktop/src-main/preload.ts`（`preflight.run` 桥接）

## 2. 类型契约

### 2.1 `PreflightReport` 字段表

字段顺序即类型声明顺序，用于 byte 稳定序列化（`JSON.stringify(m, null, 2) + '\n'`）。

| 字段 | 类型 | 语义 |
|---|---|---|
| `schemaVersion` | `2 as const` | 报告 schema 版本；`PREFLIGHT_REPORT_VERSION` 常量（schema v2 见 §15） |
| `appVersion` | `string` | 主进程 `process.versions.electron`，缺省 `'unknown'` |
| `checkedAt` | `string` | ISO 时间戳（`buildPreflightReport` 默认 `new Date().toISOString()`，测试可注入） |
| `targetAlias` | `string` | 目标库 B 的节点别名 |
| `targetDatabase` | `string` | 目标库 B 的数据库名 |
| `source` | `'real'` | 目前唯一取值；Preflight 只在真实比较后运行 |
| `facts` | `PreflightFact[]` | 只读观测到的原始事实 |
| `inferences` | `PreflightInference[]` | 基于 Fact 应用确定性规则的结论 |
| `unknowns` | `PreflightUnknown[]` | 因权限、版本、查询失败无法判定 |
| `issues` | `PreflightIssue[]` | 高风险规则触发的可行动结论 |
| `verdict` | `{ level, blocking, warnings, unknowns }` | 见 §3.1 |

### 2.2 三段结构

**Fact** —— 严格可追溯的观测值：

```ts
export interface PreflightFact {
  category: PreflightCategory;
  key: string;          // 例：'server.mysql_version' / 'table.orders.rows'
  value: unknown;       // number / string / boolean / null
  source: PreflightFactSource;
  observedAt: string;   // ISO
}
```

**Inference** —— 必须能追溯到具体 Fact：

```ts
export interface PreflightInference {
  category: PreflightCategory;
  subject: string;               // 'diff-item:d12' / 'table.orders'
  statement: string;             // 一行结论
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];            // Fact.key 或 'diff-item:<id>.sql' 列表；非空硬约束
  ruleId: string;                // 例：'ONLINE_DDL_MATRIX' / 'BIG_TABLE_COPY'
}
```

**Unknown** —— 不能用默认值伪装确定：

```ts
export interface PreflightUnknown {
  category: PreflightCategory;
  subject: string;
  reason: PreflightUnknownReason;
  attempt: string;               // 尝试的 SQL / 规则
  observedAt: string;
}
```

### 2.3 `PreflightCategory`

```ts
export type PreflightCategory =
  | 'server'      // 版本、SQL_MODE、系统变量
  | 'table'       // 表规模、空间、引擎
  | 'index'       // 主键、唯一/普通索引、外键
  | 'ddl'         // 每条 DDL 的分类与算法判定
  | 'replication' // 复制状态
  | 'permissions' // 授权可见性
  | 'variables';  // 其它系统变量
```

### 2.4 `PreflightFactSource`

严格只读查询名，与 `PreflightCollectHooks.onProgress` 的 category 分类一一对应：

| 值 | 来源 |
|---|---|
| `select-version` | `SQL_SERVER`（`VERSION()` + `@@...` 一列查询） |
| `select-sysvars` | `SQL_VARIABLES` / `SQL_REPLICA_SYSVARS`（`@@` 系统变量查询） |
| `information-schema.tables` | 分批的 `information_schema.tables` 查询（每批 100 个 `IN (?, ?, ...)`） |
| `information-schema.statistics` | `information_schema.statistics` 索引查询 |
| `information-schema.key-column-usage` | `information_schema.key_column_usage` 外键查询 |
| `show-replica-status` | `SHOW REPLICA STATUS`（MySQL 8.0.22+ 优先） |
| `show-slave-status` | `SHOW SLAVE STATUS`（5.7 / 8.0.21- 兼容） |
| `show-grants-for-current-user` | `SHOW GRANTS FOR CURRENT_USER()`（复用 `grants.ts:SQL_SHOW_GRANTS`） |

### 2.5 `PreflightUnknownReason` 与触发场景

| Reason | 触发场景 |
|---|---|
| `permission-denied` | 任何只读查询返回 MySQL 权限类错误码（`classifyCoverageReason` 映射 `permission-denied`） |
| `query-failed` | 非权限类的查询异常（`classifyCoverageReason` 的 `object-missing` / `aborted` / `unknown` 统一归入此项；用户取消、pool 建池失败、批处理失败、`Promise.allSettled` rejected 都归此项） |
| `unsupported-version` | MySQL 版本 < `MIN_VERSION = '5.6'`，`lookupOnlineDdl` 返回 null |
| `not-applicable` | 目标是 replica 但当前账号无 `REPLICATION CLIENT`，`SHOW REPLICA STATUS` 与 `SHOW SLAVE STATUS` 都无行 |
| `unparsed-ddl` | `DiffItem.sql` 落入 `classifyDdl` 的 `OTHER`，或矩阵未收录 |

`classifyCoverageReason` 的粗粒度 `aborted` / `object-missing` 不穿透到 Preflight：`preflight-collect.ts:reasonOf` 只区分 `permission-denied` vs `query-failed`，其他一律 `query-failed`。这是有意的信息压缩：Preflight 报告不含 errno 或原始消息。

### 2.6 `PreflightIssue.severity` 语义

- `block`：**应当阻断发布**。触发即 `verdict.level = 'block'`。当前规则：`BIG_TABLE_COPY`、`READ_ONLY_TARGET`。
- `warn`：需要人工确认或提示。触发即 `verdict.level = 'warn'`（若无 block）。当前规则：其余 7 条。

`severity` 决定 Issue 排序：`preflightToMarkdown` 输出时 block 优先；`deriveVerdict` 计数按 severity 分列。

## 3. Verdict 与阈值

### 3.1 `deriveVerdict` 优先级

`level` 优先级：`block` > `warn` > `unknown` > `pass`。

| 计数项 | 来源 |
|---|---|
| `blocking` | `issues` 中 `severity === 'block'` 的计数 |
| `warnings` | `issues` 中 `severity === 'warn'` 的计数 |
| `unknowns` | `unknowns.length` |

```
blocking > 0       → level = 'block'
warnings > 0       → level = 'warn'
unknowns.length>0  → level = 'unknown'
otherwise          → level = 'pass'
```

### 3.2 `PreflightThresholds`

`DEFAULT_THRESHOLDS`（`src-core/preflight-types.ts`）：

| 阈值 | 默认 | 用于 |
|---|---|---|
| `bigTableRows` | `1_000_000` | `BIG_TABLE_COPY`（>） / `LARGE_TABLE_INSTANT_ADD`（≥） |
| `replicaLagSeconds` | `30` | `REPLICA_LAG`（>） |

`LARGE_TABLE_REBUILD` 的 5 GiB 阈值是硬编码常量 `FIVE_GIB_BYTES`，不通过 `PreflightThresholds` 暴露。

v1 内置默认，不做可配置策略（PRD Q3 已定）。renderer 可在 `PreflightRequest.thresholds` 覆盖任一字段；`buildPreflightReport` 缺省回填 `DEFAULT_THRESHOLDS`。

## 4. 只读 SQL 清单

`preflight-collect.ts` 是本模块唯一持有 SQL 字面量的位置（除 `SQL_SHOW_GRANTS` 复用自 `grants.ts`）。所有语句必须落在 `SELECT` / `SHOW` / `@@` / `information_schema` / `performance_schema` 的只读形式。

| 常量 | SQL | 使用位置 |
|---|---|---|
| `SQL_SERVER` | `SELECT VERSION() AS version, @@version_comment, @@sql_mode, @@innodb_file_per_table, @@transaction_isolation, @@lower_case_table_names, @@character_set_server, @@collation_server` | `collectServerFacts` |
| `SQL_VARIABLES` | `SELECT @@innodb_buffer_pool_size, @@max_connections, @@tmp_table_size, @@sort_buffer_size, @@thread_cache_size, @@innodb_page_size, @@max_allowed_packet` | `collectVariablesFacts` |
| `SQL_TABLE_PREFIX` | `SELECT table_name, table_rows, data_length, index_length, data_free, engine, row_format, auto_increment, update_time, checksum FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?, ?, ...)` | `collectTableFacts`（每批 100 个 `?`） |
| `SQL_INDEX_STATISTICS` | `SELECT table_name, index_name, column_name, seq_in_index, non_unique FROM information_schema.statistics WHERE table_schema = ? AND table_name IN (?, ?, ...)` | `collectIndexFacts` |
| `SQL_FOREIGN_KEYS` | `SELECT table_name, constraint_name, column_name FROM information_schema.key_column_usage WHERE table_schema = ? AND referential_constraint IS NOT NULL` | `collectIndexFacts` |
| `SQL_REPLICA_STATUS` | `SHOW REPLICA STATUS` | `collectReplicationFacts`（首选） |
| `SQL_SLAVE_STATUS` | `SHOW SLAVE STATUS` | `collectReplicationFacts`（降级） |
| `SQL_REPLICA_SYSVARS` | `SELECT @@server_id, @@read_only, @@super_read_only, @@log_bin, @@gtid_mode` | `collectReplicationFacts` |
| `SQL_SHOW_GRANTS` | `SHOW GRANTS FOR CURRENT_USER()`（来自 `src-main/grants.ts`） | `collectGrantFacts` |

### 4.1 硬边界

**必须禁用**（`preflight-run.test.ts` 与目录 `grep` 共同硬约束）：

- `SET` 语句（不含字符串内的 `CHARACTER SET` 短语）；
- `INSERT` / `UPDATE` / `DELETE`；
- `SELECT ... FOR UPDATE` / `SELECT ... FOR SHARE`；
- `pool.query(diff.sql)` / `pool.execute(...)` 或任何执行 `DiffItem.sql` 的路径；
- `pt-online-schema-change` / `gh-ost` / `cut-over` 字符串；
- 任何写库路径、外呼 migration 工具、调度、托管凭据。

完整清单另见 [Database Guidelines](./database-guidelines.md#read-operations)。

## 5. DDL 分类器

### 5.1 `DdlOp` 17 种枚举

```ts
export type DdlOp =
  | 'ADD_COLUMN' | 'DROP_COLUMN' | 'MODIFY_COLUMN' | 'CHANGE_COLUMN'
  | 'ADD_INDEX' | 'ADD_UNIQUE_INDEX' | 'ADD_PRIMARY_KEY' | 'DROP_INDEX'
  | 'CONVERT_TO_CHAR_SET' | 'CHANGE_ENGINE'
  | 'CREATE_TABLE' | 'DROP_TABLE' | 'RENAME_TABLE'
  | 'CREATE_INDEX' | 'DROP_INDEX_STANDALONE'
  | 'OTHER';
```

### 5.2 `DdlClassification` 字段

```ts
export interface DdlClassification {
  op: DdlOp;
  tableName: string | null;    // 已剥离反引号，``dbl`` 转义还原
  columnName: string | null;
  indexName: string | null;
  statement: string;           // 原始 SQL（已 trim）
  confidence: 'high' | 'medium' | 'low';
}
```

`confidence`：`high` = 关键字形态明确；`medium` = 语义有歧义（当前只有 `CREATE_INDEX`，无法从 SQL 判定是否为 UNIQUE）；`low` = `OTHER` 兜底。

### 5.3 `classifyDdl` 分类规则（正则优先级表）

首个命中即返回。顺序有依赖，改动需要覆盖单元测试：

| 优先级 | DdlOp | 正则要点 |
|---|---|---|
| 1 | `DROP_TABLE` | `^DROP\s+TABLE\b` |
| 2 | `CREATE_TABLE` | `^CREATE\s+TABLE\b` |
| 3 | `RENAME_TABLE` | `^RENAME\s+TABLE\b` |
| 4 | `CREATE_INDEX` | `^CREATE\s+(?:UNIQUE\s+)?INDEX\b` |
| 5 | `DROP_INDEX_STANDALONE` | `^DROP\s+(?:UNIQUE\s+)?(?:INDEX\|KEY)\b` |
| 6 | `ADD_PRIMARY_KEY` | `ALTER\s+TABLE\b.*\bADD\s+PRIMARY\s+KEY\b` |
| 7 | `ADD_UNIQUE_INDEX` | `ALTER\s+TABLE\b.*\bADD\s+UNIQUE\s+(?:INDEX\|KEY)\b` |
| 8 | `ADD_INDEX` | `ALTER\s+TABLE\b.*\bADD\s+(?:FULLTEXT\|SPATIAL\|INDEX\|KEY)\b` |
| 9 | `DROP_INDEX` | `ALTER\s+TABLE\b.*\bDROP\s+(?:INDEX\|KEY)\b` |
| 10 | `DROP_COLUMN` | `ALTER\s+TABLE\b.*\bDROP\s+COLUMN\b` |
| 11 | `CHANGE_COLUMN` | `ALTER\s+TABLE\b.*\bCHANGE\s+(?:COLUMN\b\|\S+\s+\S+)` |
| 12 | `MODIFY_COLUMN` | `ALTER\s+TABLE\b.*\bMODIFY\s+(?:COLUMN\s+\|\S+)` |
| 13 | `ADD_COLUMN` | `ALTER\s+TABLE\b.*\bADD\s+(?!PARTITION\|CONSTRAINT\|FOREIGN\|FULLTEXT\|SPATIAL\|INDEX\|KEY\|PRIMARY\|UNIQUE)(?:COLUMN\s+\|\S+)`（负向先行防止吞掉索引/约束类 ADD） |
| 14 | `CONVERT_TO_CHAR_SET` | `ALTER\s+TABLE\b.*\bCONVERT\s+TO\s+CHARACTER\s+SET\b` |
| 15 | `CHANGE_ENGINE` | `ALTER\s+TABLE\b.*\bENGINE\s*=` |

未命中 → `op: 'OTHER'`, `confidence: 'low'`，上层记 `unparsed-ddl` Unknown。

**复合 ALTER**（`ALTER TABLE t ADD COLUMN a, ADD COLUMN b`）按优先级取首条匹配，调用方在 Inference 备注里注明「多条 ALTER 子句，取首个操作类别」。

### 5.4 `OTHER` → `unparsed-ddl` Unknown

`preflight-run.ts` 阶段 6 对每条 table `DiffItem`：`cls.op === 'OTHER'` 直接 push 一条 `category: 'ddl'`, `subject: 'diff-item:<id>'`, `reason: 'unparsed-ddl'`, `attempt: sql.slice(0, 200)` 的 Unknown，跳过矩阵查询。

## 6. Online DDL 矩阵

`lookupOnlineDdl(op, mysqlVersion)` 返回 `OnlineDdlInfo | null`。

```ts
export interface OnlineDdlInfo {
  algorithm: 'INSTANT' | 'INPLACE' | 'COPY';
  lockMode: 'NONE' | 'SHARED' | 'EXCLUSIVE' | 'EXCLUSIVE-BRIEF';
  rebuildsTable: boolean;
  availableFrom: string | null;   // 形如 '8.0.12'；低于该版本该算法不可用
  notes: string;
}
```

### 6.1 版本处理

- `MIN_VERSION = '5.6'`：InnoDB 支持 INPLACE ALTER 的最低版本；`versionAtLeast(actual, '5.6') === false` 直接返回 `null`（上层记 `unsupported-version` Unknown）。
- `versionAtLeast` 支持 `X.Y.Z` 与 `X.Y.Z.N`（MariaDB-style 四段）前缀比较，只取首段纯数字（`8.0.36-0ubuntu` 之类的发行版后缀被忽略），缺位按 0 补齐，非法字符串返回 false。
- `availableFrom` 只表示「该算法从哪个版本开始出现」；`lookupOnlineDdl` 内部按 `versionAtLeast` 分支返回 INSTANT 或降级到 INPLACE。

### 6.2 17 种 Op × 版本矩阵（要点）

`ADD_COLUMN`：
- MySQL ≥ `8.0.12` → `INSTANT / SHARED / rebuildsTable=false / availableFrom='8.0.12'`（**v1 乐观推断**：未校验 DEFAULT 子句；实际默认值检测推迟到 v2；规则层用 `LARGE_TABLE_INSTANT_ADD` 表达正面提示）。
- MySQL < `8.0.12` → `INPLACE / SHARED / rebuildsTable=true / availableFrom='5.6'`。

`DROP_COLUMN`：
- MySQL ≥ `8.0.29` → `INSTANT / NONE / rebuildsTable=false / availableFrom='8.0.29'`。
- MySQL < `8.0.29` → `INPLACE / SHARED / rebuildsTable=true / availableFrom='5.6'`。

`ADD_INDEX` → `INPLACE / SHARED / rebuildsTable=false / 5.6`（非 UNIQUE、非 PRIMARY KEY）。
`ADD_UNIQUE_INDEX` → `INPLACE / SHARED / rebuildsTable=true / 5.6`。
`ADD_PRIMARY_KEY` → `INPLACE / EXCLUSIVE / rebuildsTable=true / 5.6`。
`DROP_INDEX` / `DROP_INDEX_STANDALONE` → `INPLACE / SHARED / rebuildsTable=false / 5.6`。
`MODIFY_COLUMN` / `CHANGE_COLUMN` → `INPLACE / SHARED / rebuildsTable=true / 5.6`。
`CONVERT_TO_CHAR_SET` → `INPLACE / SHARED / rebuildsTable=true / 5.6`（如 `utf8mb4` 可能翻倍空间）。
`CHANGE_ENGINE` → `INPLACE / SHARED / rebuildsTable=true / 5.6`。
`CREATE_TABLE` / `DROP_TABLE` / `RENAME_TABLE` → `INPLACE / EXCLUSIVE-BRIEF / rebuildsTable=false / 5.6`。
`CREATE_INDEX` → `INPLACE / SHARED / rebuildsTable=false / 5.6`（若目标列为唯一索引则实际需重建表；notes 明确记录）。
`OTHER` → `null`（上层记 `unparsed-ddl`）。

### 6.3 v1 简化说明

- v1 **只做「可用 INSTANT」的乐观推断**：无法读取 DDL 里的 `DEFAULT` 子句，因此对 `ADD_COLUMN` 在 ≥ 8.0.12 一律返回 INSTANT。规则层的 `LARGE_TABLE_INSTANT_ADD` 负责在正面场景提醒用户「可用 INSTANT 加速」；反向默认值检测留待 v2。
- `COPY` 算法当前矩阵未返回：MySQL 5.6+ 的 INPLACE 已覆盖表中所有列变更；`COPY` 只在无主键 / 不支持 INPLACE 的引擎降级路径出现，v1 不做降级建模。

## 7. 9 条高风险规则

`preflight-rules.ts` 的 `evaluateRules` 按下列固定顺序执行，不重复、可复现。每条规则独立可测。

| # | ruleId | severity | 触发条件 | 建议动作 |
|---|---|---|---|---|
| 1 | `BIG_TABLE_COPY` | `block` | 目标表 `TABLE_ROWS > bigTableRows` **且** DDL 判定 `rebuildsTable` | 低峰时段发布；超大表改用支持在线 DDL 分块复制的工具 |
| 2 | `NO_PRIMARY_KEY` | `warn` | DDL 为 `DROP_INDEX` / `DROP_COLUMN` **且** 目标表 `primary_indexes` 为空 | 发布前补加主键或全非空 UNIQUE |
| 3 | `REPLICA_LAG` | `warn` | `replication.seconds_behind_master > replicaLagSeconds`（缺失/NaN 跳过） | 等延迟追平或放入低延迟窗口 |
| 4 | `READ_ONLY_TARGET` | `block` | `server.read_only` 或 `server.super_read_only` 为真值（`1` / `'1'` / `true` / `'ON'` / `'on'` / `'YES'` / `'yes'`） | 发布前必须临时解除只读模式 |
| 5 | `GTID_MISMATCH` | `warn` | `replication.gtid_mode` 既非 `'OFF'` 也非 `'ON'`（中间态） | 确认主从 GTID 模式一致；v1 只读 B 库，无法判定主从差异，推迟到 v2 |
| 6 | `PERMISSION_INCOMPLETE` | `warn` | `permissions.reliable === false` **或** `permissions.visibility !== 'full'` | 用库级 SELECT / ALL PRIVILEGES 授权重连 |
| 7 | `LARGE_TABLE_INSTANT_ADD` | `warn`（**正面**） | `ADD_COLUMN` **且** MySQL ≥ `8.0.12` **且** `TABLE_ROWS ≥ bigTableRows` **且** 矩阵为 INSTANT | 该 DDL 可用 `ALGORITHM=INSTANT` 加速，避免长锁与重建 |
| 8 | `NO_UNIQUE_INDEX_AFTER_CHANGE` | `warn` | DDL 为 `DROP_INDEX` **且** 移除的是唯一索引（含 PRIMARY）**且** 移除后表内无任何唯一索引 | 确认是否保留至少一个唯一约束 |
| 9 | `LARGE_TABLE_REBUILD` | `warn` | `(DATA_LENGTH + INDEX_LENGTH) > 5 GiB` **且** DDL 判定 `rebuildsTable` | 低峰时段发布；超大表改用支持分块复制的工具 |

### 7.1 Issue id 与 subject 约定

`Issue.id` 格式：`RULE_ID:subject`。`subject` 形式：

| subject | 用途 |
|---|---|
| `table.<tableName>` | 表级规则（BIG_TABLE_COPY / NO_PRIMARY_KEY / NO_UNIQUE_INDEX_AFTER_CHANGE / LARGE_TABLE_REBUILD） |
| `diff-item:<item.id>` | 具体 DDL 规则（LARGE_TABLE_INSTANT_ADD 的规则主体是 DDL 而非表） |
| `server` | 全局规则（READ_ONLY_TARGET） |
| `replication` | 复制规则（REPLICA_LAG / GTID_MISMATCH） |
| `permissions` | 授权规则（PERMISSION_INCOMPLETE） |

`Issue.related` 引用 `Fact.key` / `Inference.subject` 混合，用于从 Issue 追溯到具体事实；至少包含本规则依赖的 `server.mysql_version` 与 `diff-item:<id>`。

### 7.2 Inference 生成（阶段 6）

`preflight-run.ts` 阶段 6 对每条 table objectType 的 item 生成一条 `Inference`：

- `category: 'ddl'`，`subject: 'diff-item:<id>'`，`ruleId: 'ONLINE_DDL_MATRIX'`；
- `evidence` 至少含 `diff-item:<id>.sql` + `server.mysql_version`（Stage 1 硬约束：非空）；有 `tableName` 时再补 `table.<tableName>`；
- `statement` 形如 `d12: ADD_COLUMN on orders → INSTANT/SHARED`（无 rebuild 不加后缀）；`rebuildsTable === true` 时追加 ` (rebuild)`。

跳过路径：
- `DiffItem.objectType` ∈ `{ data, view, procedure, function }` → v1 不处理，直接跳过；
- `cls.op === 'OTHER'` → 记 `unparsed-ddl` Unknown，跳过矩阵；
- `mysqlVersion` 为空或 `lookupOnlineDdl` 返回 null → 记 `unsupported-version` Unknown。

## 8. IPC 契约

`SqlDiffApi.preflight.run` 是唯一的 preflight 桥接入口。

### 8.1 `PreflightRequest`

```ts
export interface PreflightRequest {
  bId: string;                        // 目标库节点 id（B 侧）
  items: DiffItem[];                  // 待检查的 DDL 项（来自 CompareResult.items）
  bAlias: string;                     // B 侧别名（写入报告 targetAlias）
  bDatabase: string;                  // B 侧数据库名（information_schema 查询用）
  thresholds?: { bigTableRows?: number; replicaLagSeconds?: number };
}
```

### 8.2 `PreflightExportResult`

```ts
export interface PreflightExportResult {
  jsonFileName: string;
  markdownFileName: string;
  jsonContent: string;
  markdownContent: string;
  verdictLevel: 'pass' | 'warn' | 'block' | 'unknown';
}
```

`runPreflight` 主进程内部完成「采集 → 分类 → 规则 → 序列化 → 文件名」全部计算，返回值同时携带两个文件名与两份序列化内容，renderer 只需通过 `saveTextFiles`（`kind: 'bundle'`）写盘。

### 8.3 通道

- IPC 通道：`preflight:run`
- Preload：`SqlDiffApi.preflight.run(req: PreflightRequest): Promise<PreflightExportResult>`
- Main 处理：`apps/desktop/src-main/main.ts` 注册 `ipcMain.handle('preflight:run', ...)`

类型经 `import type` 从 `src-main/preflight-run.ts` 转由 `preload.ts` 再导出（同 `SaveRequest` / `SaveResult` 模式）。

### 8.4 `PreflightRunDeps`（可注入，用于测试）

```ts
export interface PreflightRunDeps {
  createPool?: PreflightPoolFactory;           // 默认 createMysqlPool
  secretProvider?: (nodeId: string) => SecretBundle | null;
  appVersion?: string;                          // 缺省 process.versions.electron ?? 'unknown'
  checkedAt?: string;                           // ISO；缺省 new Date().toISOString()
}
```

`PreflightRunHooks.signal`（AbortSignal）每次采集前后检查一次；aborted 后跳过剩余采集但保留已完成结果，并 push 一条 `reason: 'query-failed', attempt: 'aborted by user'` 的 Unknown。

## 9. 编排（`preflight-run.ts`）

`runPreflight(req, ctx, hooks, deps)` 的 9 个阶段（编号与源码注释一致）：

1. 拿节点元数据与凭据（`loadNodes` + `secretProvider`）；节点不存在 → `throw preflight: 目标节点不存在`。
2. 建池（`deps.createPool ?? defaultPoolFactory`），失败 → **最小未知报告**（`verdict.level === 'unknown'`），**不 throw**。
3. 从 `items` 里提取目标表清单（`TABLE_NAME_RE` / `ON_TABLE_RE` / `objectName` 回落）。
4. 并发采集 server / variables / grants / replication（`Promise.allSettled`）。
5. 串行采集 tables → indexes（依赖同一表清单）。
6. 为每条 table DDL 生成 Inference 或 Unknown。
7. `buildPreflightReport` 构建报告。
8. `serializePreflight` + `preflightToMarkdown` + `preflightFileNames`。
9. `finally` 关闭池（`try/catch` 兜底，不因 `pool.end()` 失败掩盖前面积累的结果）。

## 10. 序列化与导出

### 10.1 `serializePreflight`

`JSON.stringify(m, null, 2) + '\n'`，字段顺序即类型声明顺序（byte 稳定，同 `serializeManifest`）。

### 10.2 `preflightToMarkdown` 章节顺序

1. `# Preflight Report` 头部（检查时间 / schemaVersion / appVersion / 目标别名 / 目标数据库 / 来源）；
2. `## Facts`，按 `CATEGORY_ORDER`（server → variables → table → index → ddl → replication → permissions）分组，每类一个 `### Facts · <category>` 二级标题 + `| Key | Value | Source | Observed At |` 表格；空分类跳过；整体为空时输出 `_（无事实）_`；
3. `## Inferences`：`| Subject | Statement | Confidence | Rule | Evidence |`；
4. `## Unknowns`：`| Subject | Reason | Attempt | Observed At |`；
5. `## Issues`：`| ID | Severity | Subject | Title | Recommendation |`（block 优先排序，subject 从 `id` 中 `:` 后的片段）；
6. `## Verdict`：`Level` / `Blocking` / `Warnings` / `Unknowns`；
7. `## 保密声明`（固定文本，无秘密、无行值）。

Markdown 表格单元格中的 `|` 用 `\|` 转义（`mdCell`）。

### 10.3 `preflightFileNames`

`checkedAt` 的 `:` 与 `.` 全部替换为 `-`，产出：

- `sqldiff-preflight-<safe>.json`
- `sqldiff-preflight-<safe>.md`

示例：`sqldiff-preflight-2026-10-03T10-00-00-000Z.json`。

两份文件通过 `saveTextFiles`（`kind: 'bundle'`）在**一次**目录选择中写盘（同 ReviewManifest），成功 toast 上报真实路径；取消不写盘不报错。

## 11. 硬边界（Out of Scope）

| 项 | 状态 |
|---|---|
| 调用 `pt-online-schema-change` / `gh-ost` | 明确不做，grep 硬约束 |
| 生成 cut-over 命令 | 明确不做 |
| 执行 `DiffItem.sql`（`pool.query(diff.sql)` / `pool.execute`） | 明确不做，grep 硬约束 |
| A 侧数据库 preflight | v1 不覆盖 |
| 数据 DML preflight | v1 不覆盖，属后续 reconciliation 方向 |
| 视图 / 例程 DDL preflight | v1 只针对表级 DDL（阶段 6 跳过 view / procedure / function） |
| 多目标并行 preflight | v1 只支持单目标 |
| 自动判定「允许发布 / 阻断发布」 | Preflight 只给建议 `verdict`，不做硬阻断 |
| 自动执行、写库、托管凭据、调度 | 明确不做 |

### 11.1 保密边界

`PreflightReport` 与 Markdown 导出物**必须不含**：

- 连接凭据（`password` / `sshPassword` / `privateKey` / `passphrase` / `vaultCiphertext` / `userPassword`）；
- 未经裁定的行值（v1 只读元数据，本来就不产生行值，规则层的 Issue 也不引用行值）；
- 原始 `SHOW GRANTS` 文本（`collectGrantFacts` 只输出结构化的 `permissions.visibility` / `permissions.reliable`，不携带 privilege 语句或用户主机名，同 `grants.ts` 语义）；
- 连接串。

### 11.2 Real-only

`PreflightReport.source` 类型层面强制为 `'real'`；UI 在 `resultSource !== 'real'` 时禁用 preflight 按钮（`state-management.md` 与 `quality-guidelines.md` 覆盖）。

## 12. 测试要求

- `tests/core/preflight-ddl.test.ts`：
  - `classifyDdl` 覆盖 17 种 `DdlOp` + `OTHER`，含复合 ALTER、大小写、反引号包裹、``dbl`` 转义、`CHANGE` 无 COLUMN 关键字；
  - `versionAtLeast` 覆盖 `X.Y.Z` / `X.Y.Z.N` 前缀比较、`8.0.36-0ubuntu` 后缀、非法字符串、缺位补 0；
  - `lookupOnlineDdl` 覆盖 MySQL 5.7 / 8.0.11 / 8.0.12 / 8.0.28 / 8.0.29 / 8.0.36 六个版本 × 至少 10 种 DdlOp，含 `MIN_VERSION` 边界与 `OTHER → null`；
- `tests/core/preflight-rules.test.ts`：9 条规则各自独立测试（含正面 `LARGE_TABLE_INSTANT_ADD`、`read_only` 多形态真值识别、`GTID_MISMATCH` 中间态、`NO_UNIQUE_INDEX_AFTER_CHANGE` 的 PRIMARY/UNIQUE 分支）；
- `tests/core/preflight.test.ts`：`deriveVerdict` 优先级四分支、`buildPreflightReport` byte 稳定、`preflightToMarkdown` 章节齐全、`preflightFileNames` 冒号与点替换、保密声明存在；
- `tests/main/preflight-collect.test.ts`：6 个采集函数各自的正常路径与 3 类失败路径（`permission-denied` / 一般查询失败 / 空结果）；批处理失败只降级该批；`SHOW REPLICA STATUS` → `SHOW SLAVE STATUS` 降级；`SHOW GRANTS` 查询失败时 `reliable:false / visibility:partial`；
- `tests/main/preflight-run.test.ts`：节点不存在 throw、pool 建池失败返回最小未知报告、AbortSignal 检查、8 阶段顺序与进度回调、`finally` 关闭池不掩盖结果、`grep` 硬约束（无 `pool.query(diffItem.sql)`、无 `pt-online-schema-change` / `gh-ost` / `cut-over`）；
- 全量门禁：`npm run typecheck` / `npm run lint` / `npm test` / `npm run build`（在 `apps/desktop` 下）。

## 13. 与 Manifest 的边界

ReviewManifest 描述「差异是什么」，PreflightReport 描述「应用差异会发生什么」：

| 维度 | ReviewManifest | PreflightReport |
|---|---|---|
| schema 版本 | `REVIEW_MANIFEST_VERSION = 1` | `PREFLIGHT_REPORT_VERSION = 1`（**独立，不合并**） |
| 数据来源 | `CompareResult` 确定性投影 | `CompareResult.items` + B 侧只读观测 |
| 序列化 | `JSON.stringify(m, null, 2) + '\n'` | 同 |
| Markdown 面向 | 人工交接 | 人工交接（Fact/Inference/Unknown 三段） |
| 脱敏 | DML 行值 `'***'` / 数字 `0` | 无秘密、无行值、无 SHOW GRANTS 原文 |
| 执行入口 | 无 | 无 |
| UI 入口 | `导出审查报告` 按钮 | `运行 Preflight` 按钮（独立按钮，不联动 manifest） |

两者互补，不合并；用户交接时经常分开使用（PRD Q2 已定）。字段级脱敏原则一致（无秘密、无行值），但**脱敏器规则不共用**：ReviewManifest 的 `redactDmlSql` 只处理 DML 字符串，Preflight 不产生行值所以不需要红脱敏器。

参见 [Manifest Export Contract](./manifest-export.md)。

## 14. v2 结论式渲染（双视角 + 分层文件）

> 本节是 v1 契约的**渲染层补充**，不修改 v1 类型契约、序列化格式或规则引擎。JSON schema 保持 byte 稳定；旧 `preflightToMarkdown` 保留不删，供旧单测与外部引用。

### 14.1 三层产物

| 产物 | 消费者 | 生成函数 |
|---|---|---|
| `sqldiff-preflight-{ts}.json` | 程序（CI、审计、归档）| `serializePreflight`（不变） |
| `sqldiff-preflight-{ts}.md` | 人（首屏决策）| `preflightToExecutiveMarkdown`（新增） |
| `sqldiff-preflight-{ts}-detail.md` | 人（追溯细节）| `preflightToDetailMarkdown`（新增） |

三者**同源**（均由同一份 `PreflightReport` 派生）、**不重复**（结论文件不含 facts 表；细节文件不含决策语）、**可交叉引用**（结论底部有 `→ [完整原始数据](./xxx-detail.md)`；细节顶部有 `← [返回结论](./xxx.md)`）。

### 14.2 决策语三态

`deriveDecision(m: PreflightReport): { level: 'GO' | 'DEGRADED' | 'BLOCK'; message: string }`

优先级：

1. **BLOCK**：存在 `severity === 'block'` 的 issue。
2. **DEGRADED**：无 block 但存在以下任一：
   - 任一 inference.statement 含 `INPLACE/EXCLUSIVE`
   - issue id 前缀为 `BIG_TABLE_REBUILD` / `LARGE_TABLE_REBUILD` / `REPLICA_LAG`
3. **GO**：以上均不满足。

`unknowns` 不影响决策（多数是 not-applicable 噪声）；`permission-denied` / `query-failed` 等非噪声 unknowns 在消息中附带「附 N 条待确认的未知项」，不升级为 BLOCK。

Badge 图标：GO=🟢、DEGRADED=🟡、BLOCK=🔴。

### 14.3 双视角信息映射

| 视角 | 数据来源 | 派生逻辑 |
|---|---|---|
| 开发：DDL 分类成功率 | `inferences.length` vs `items.length` | 相除得百分比（整数四舍五入） |
| 开发：DdlOp 分布 | `inferences[].statement` 正则解析 | `parseInferenceStatement` 提取 op 计数 |
| 开发：Unparsed DDL | `unknowns.filter(reason === 'unparsed-ddl')` | 直接引用 |
| 开发：表结构隐患 | `issues`（NO_PRIMARY_KEY / NO_UNIQUE_INDEX_AFTER_CHANGE / LARGE_TABLE_REBUILD） | 按表名聚合 |
| 运维：DDL 风险分组 | `inferences[].statement` 含 algorithm/lock | 按 `INSTANT` / `INPLACE SHARED` / `INPLACE EXCLUSIVE` 三档 |
| 运维：表风险热图 | `facts.filter(category === 'table')` + inferences 计数 | 按表名聚合 rows/size/pk/ddlCount，风险：无 PK→block、有 PK 且 rows>1M→warn、其他→safe |
| 运维：环境状态 | `facts.filter(category in 'server','replication','permissions')` | 至少 4 项：MySQL 版本、read_only、gtid_mode、permissions.visibility |

**关键实现**：`parseInferenceStatement` 用正则 `(\w+) on (\w+) → (\w+)/( \w+)` 解析自由文本，返回 `{ op, tableName, algorithm, lockMode, rebuilds }`。

### 14.4 文件名约定

`preflightFileNames(checkedAt)` 返回三个文件名：

```ts
{
  jsonFileName: 'sqldiff-preflight-{ts}.json',
  markdownFileName: 'sqldiff-preflight-{ts}.md',         // 结论（v2 起）
  detailMarkdownFileName: 'sqldiff-preflight-{ts}-detail.md',  // 细节（新增）
}
```

`{ts}` 为 ISO 8601，冒号与点号替换为连字符（与 v1 一致）。

### 14.5 API 表面

新增导出（`src-core/preflight.ts`）：

- `preflightToExecutiveMarkdown(m: PreflightReport): string`
- `preflightToDetailMarkdown(m: PreflightReport): string`
- `parseInferenceStatement(s: string): InferenceStatement`
- `deriveDecision(m: PreflightReport): Decision`
- `groupDdlByRisk(inferences): { exclusive, inplaceShared, instant }`
- `buildTableHeatmap(facts, inferences): TableRow[]`
- `buildDeveloperView(m): DeveloperView`
- `buildOpsView(m): OpsView`
- 类型：`InferenceStatement`、`DecisionLevel`、`Decision`、`TableRow`、`DeveloperView`、`OpsView`

修改导出（`src-main/preflight-run.ts`）：

- `PreflightExportResult` 新增 `detailMarkdownFileName: string` 与 `detailMarkdownContent: string`（可选，保持向后兼容）

保留不删（v1 兼容）：

- `preflightToMarkdown(m: PreflightReport): string` —— 旧实现，主流程不再调用，仅供旧单测与外部引用

### 14.6 数据流

```
runPreflight()
  ↓ 收集 facts/inferences/unknowns
  ↓ evaluateRules() → issues
  ↓ deriveVerdict() → verdict
  ↓ buildPreflightReport() → PreflightReport 对象
  ↓
  ├─ serializePreflight() → jsonContent                    [不变]
  ├─ preflightToExecutiveMarkdown() → markdownContent      [v2 新增]
  ├─ preflightToDetailMarkdown() → detailMarkdownContent   [v2 新增]
  └─ preflightFileNames(checkedAt) → 3 个文件名           [v2 新增 detail]
```

UI 端（`App.tsx:handleExportPreflight`）通过 `saveTextFiles` 一次保存三个文件。

### 14.7 渲染约束

1. **纯函数**：所有新函数不引入 IO / 时间 / 随机（`checkedAt` 由上游注入）。
2. **byte 稳定**：JSON 序列化不变；Markdown 输出对同一输入确定性一致。
3. **优雅降级**：数据缺失时（如无 inferences）显示「无」而非抛错。
4. **不重复渲染**：结论不含 facts 表；细节不含决策语。
5. **交叉引用**：结论底部有相对路径链接到细节；细节顶部有反向链接。
6. **单元格转义**：沿用 `mdCell` / `mdValue` 处理 `|` 与 null/undefined。
7. **数字格式化**：`fmtRows`（>1M→M、>1K→K）+ `fmtSize`（GB/MB/KB），两处共用。

### 14.8 测试

新增 `apps/desktop/tests/core/preflight-exec.test.ts`（≥10 项），覆盖：

- `parseInferenceStatement` 三种典型 statement（INSTANT/SHARED、INPLACE/EXCLUSIVE、INPLACE/SHARED (rebuild)）
- `deriveDecision` 三态（BLOCK / DEGRADED / GO）
- `groupDdlByRisk` 三档分组
- `buildTableHeatmap` 无 PK 表标 block、大表标 warn、其他 safe
- `preflightToExecutiveMarkdown` 输出含决策语 + 双视角 + 交叉引用
- `preflightToDetailMarkdown` 保留完整 5 段结构
- 空数据不抛错

原有 `preflight.test.ts` 中针对旧 `preflightToMarkdown` 的测试全部保留（旧函数不删）。

### 14.9 回滚

- JSON 完全不动：schemaVersion=1、字段顺序、序列化格式 byte 稳定。
- 旧 `preflightToMarkdown` 保留：任何还在用的地方都能继续引用。
- 回滚路径：若问题严重，仅需 revert `preflight-run.ts` 的 `exportBundle` 装配（3 行）+ `App.tsx` 的 `handleExportPreflight`（10 行），把主流程退回用旧函数；其他新代码留在但不调用。

### 14.10 Follow-up（不在本任务）

- ~~UI 徽标三态同步~~ → **已落地，见 §15**：`verdict.level` 四态（pass/warn/block/unknown）保留为计数来源，UI 徽标与完成 toast 改读 `summary.decision` 三态（GO/DEGRADED/BLOCK）。
- ~~Schema v2 评估~~ → **已落地，见 §15**：`summary` 字段进 `PreflightReport`（`schemaVersion` 1→2）。
- ~~SQL 生成联动~~ → **已落地，见 §16**：加速建议派生（`deriveSuggestedEdits`）+ 一键应用（`applySuggestedEdit`，追加 `ALGORITHM=INSTANT`）。
- ~~历史对比~~ → **已落地，见 §17**：多次 preflight 结果 diff（`diffPreflight` + 独立历史视图）。

## 15. Schema v2：结论进结构

- `PreflightReport.summary: { decision: 'GO'|'DEGRADED'|'BLOCK'; message: string; blocking; warnings; unknowns }`，由 `deriveDecision` 在 `buildPreflightReport` 内一次算出并写入；`PREFLIGHT_REPORT_VERSION = 2`。
- `deriveDecision` 入参收窄为 `Pick<PreflightReport, 'issues'|'inferences'|'unknowns'>`（最小形状，v1 旧报告同样可传）。
- `getSummary(report)`：v2 直读存量快照；v1（缺 `summary`）用 `deriveDecision` 回填、计数取自 `verdict`；非法 `summary` 回退重算。
- UI 徽标（`App.tsx`）与完成 toast（`store.ts`）改读 `getSummary`，不再各自调 `deriveDecision`。
- `verdict` 四态字段保留（计数来源）；双视角全文仍只活在 md 文件里，不进 JSON。
- E2E `assertReportStructure` 要求 `schemaVersion === 2`。

## 16. SQL 生成联动（加速建议派生 + 一键应用）

> 本节是 v2 渲染层的**派生补充**，不改 schema、不改规则引擎、不改只读边界。
> 建议由报告派生（`deriveSuggestedEdits`），UI 应用只改本地待导出文本，不触线上执行。

### 16.1 定位

- preflight 的 `ALGORITHM=INSTANT`  previously 只躺在 `recommendation` 文案与 executive bullets 里，DDL 本体不受影响；
- 自动改写用户 DDL 是高风险动作（v1 乐观推断未校验 DEFAULT 子句），故采用「建议 + 一键应用，不直接改交付物」；
- 建议是**派生数据**，不是新事实：纯函数，不进 `PreflightReport` schema。

### 16.2 `SuggestedEdit` 与纯函数（`src-core/preflight.ts`）

```ts
interface SuggestedEdit {
  issueId: string;        // 例 'LARGE_TABLE_INSTANT_ADD:diff-item:d01'
  tableName: string;
  find: string;           // 待匹配的 DDL 片段（已归一化，如 'alter table orders'）
  replace: string;        // 追加子句（首批恒为 'ALGORITHM=INSTANT'）
  reason: string;         // 引用规则与版本依据（含 ≥8.0.12 前提与乐观推断提示）
}
```

- `normalizeDdl(s)`：小写 + 去反引号 + 空白折叠 + 去末尾分号；
- `deriveSuggestedEdits(m)`：只覆盖 `LARGE_TABLE_INSTANT_ADD`（ADD_COLUMN + ≥8.0.12 + 大表 + 矩阵 INSTANT，四条件与规则同源：issue 已保证，另用 inference 复核 op/algorithm）；找不到 inference / 非 ADD_COLUMN / 非 INSTANT / 无表名 → 该条跳过；
- `diffItemIdOfSuggestion(issueId)`：从 issueId 反解 diffItemId，供 UI 定位原文；
- `applySuggestedEdit(sql, edit)`：归一化不含 find 锚点 / 不含 `add` / 已含 `algorithm` / 空串 → 返回 `null`（调用方静默丢弃 + 不硬套）；成功 → 原文去尾分号后追加 `, ALGORITHM=INSTANT`（保留原文大小写与格式，幂等）；
- 建议文案必须带版本前提（"≥8.0.12 且无特殊 DEFAULT 子句"）+ 乐观推断提示。

### 16.3 executive 新增节

- `preflightToExecutiveMarkdown` 在「### 建议动作」之后、「### DDL 分组」之前插入「### 可应用的加速建议」（只做加法，不重排既有节）；
- 有建议：`| 建议 | 表 | 建议子句 | 依据 |` 表（规则 id / 表 / `ALGORITHM=INSTANT` / reason，均经 `mdCell` 转义）+ 应用方式脚注；
- 无建议：`暂无可应用的加速建议（仅 LARGE_TABLE_INSTANT_ADD 规则覆盖项会列出）。` 优雅降级。

### 16.4 UI 流程（`App.tsx`）

```
report → deriveSuggestedEdits → 预览 diff（原文 → 建议）→ window.confirm 确认
  → 待导出 DDL 文本替换（suggestedSqlOverrides，key 为 diffItemId）→ 可撤销
```

- `PreflightSuggestions` 卡片挂在中栏 DiffTable 之后（`lastPreflightResult && !resultError` 才渲染；无建议返回 null，界面保持安静）；
- `SqlPreview` 改吃 `effectiveTabItems`（tabItems 叠加 overrides）；DiffTable 行保持原文，交付物默认不变；
- 新比较（`items` / `lastPreflightResult` 变化）清空 overrides，避免 id 复用错套；
- 匹配不上（SQL 已变化 / 已含 ALGORITHM / 对应 DDL 不在结果中）禁用应用按钮，不硬套。

### 16.5 边界与回滚

- 无 schema 变更（`summary` 保持轻量，Q1 结论不变）；
- 只读边界不变：改的是用户本地待导出文本，不是线上执行；`preflight-run.ts` / IPC / `store-json.ts` 不动；
- 回滚：revert `preflight.ts` 尾部联动块 + executive 插入 3 行 + `App.tsx` 联动块，报告与导出退回无建议态。

### 16.6 测试

- `tests/core/preflight-linkage.test.ts`：`normalizeDdl`（大小写/空白/反引号/分号）+ `diffItemIdOfSuggestion` + `deriveSuggestedEdits`（命中 / 非本规则 / 无 inference / 非 ADD_COLUMN / 归一化 / 空报告）+ `applySuggestedEdit`（命中改写 / 归一化命中 / 表不一致 miss / 已含 ALGORITHM 幂等 / 空串）+ executive 新节（有表 / 无占位 / 节顺序建议动作→加速建议→DDL 分组）。

## 17. 多次 preflight 历史对比（10-04-history-diff）

目标：多次 preflight 结果可对比（「本次比上次新增 2 条 warn」），看到风险收敛还是恶化，而非每次只看孤立报告。

### 17.1 类型契约（`src-core/preflight-history.ts`，纯函数、零运行时依赖）

```ts
interface PreflightHistoryEntry {
  id: string;                 // run id（randomUUID）
  at: string;                 // ISO 时间（取报告 checkedAt，与文件名时间戳一致）
  bId: string; bAlias: string; database: string;
  schemaVersion: number; appVersion: string;
  report: PreflightReport;    // 完整报告（含 summary；v1 旧文件读时经 getSummary 回填）
}

interface PreflightDiff {
  verdictChanged: boolean;    // 任一 summary 快照字段变化即 true
  from: PreflightSummary; to: PreflightSummary;
  addedIssues: PreflightIssue[];      // to 有、from 无（按 issue.id）
  removedIssues: PreflightIssue[];    // from 有、to 无
  severityChanged: { id: string; from: string; to: string }[];  // 同 id 不同 severity
}
```

- `diffPreflight(a, b)`：同一目标库任意两次报告的 diff；入参为 `DiffableReport`
  （`Pick<PreflightReport,'issues'|'inferences'|'unknowns'> & { verdict?; summary? }`），
  v1 旧报告（缺 summary）经 `getSummary` 回填后参与对比，无需强制重跑。
- `historyGroupKey(e)` = `` `${bId}\n${database}` ``；`sameHistoryGroup(a, b)` 供 UI 禁用跨组选择。
- `isPreflightHistoryEntry(v)`：读文件时过滤非法条目（report 至少含 issues 数组），不抛。
- 本文件只读 issues/inferences/unknowns/verdict/summary，不碰 `preflight.ts` 渲染/规则逻辑。

### 17.2 存储（`src-main/store-json.ts`，只做加法）

- 新文件 `preflight-history.json`（与 nodes.json / history.json 同目录），无旧数据迁移；
  compare 的 `history.json`（20 条摘要）不动。
- `PREFLIGHT_HISTORY_LIMIT = 10`：按 `(bId, database)` 分组、每组最近 10 份滚动
  （compare 摘要留 20 条，preflight 报告体量大故取小，PRD R3）。
- `loadPreflightHistory / appendPreflightHistory / getPreflightHistoryEntry / clearPreflightHistory`，
  沿用既有原子写（tmp + rename）与读容错（缺失/损坏/非法条目 → 过滤，不抛）模式。
- 写盘时机：只在 `runPreflight` 成功后 append（阶段 7b，见 §17.3）；
  失败（无池降级早退）/ 取消（aborted）不留痕，避免半份报告污染对比。

### 17.3 编排（`preflight-run.ts`，只加阶段 7b 调用）

- 报告构建后（`buildPreflightReport` 之后、`exportBundle` 之前）、且 `!aborted` 时 append；
- `typeof appendPreflightHistory === 'function'` 守卫 + try/catch 隔离：
  append 失败只丢历史，不丢报告（旧单测 mock 缺该导出时自然跳过）。

### 17.4 IPC 契约（参照现有 preflight IPC 模式）

- 通道：`preflight-history.list` / `preflight-history.get` / `preflight-history.clear`；
- Preload：`SqlDiffApi.preflight.history.{ list, get, clear }`
  （`preflight.run` 保持不动；写入只发生在 runPreflight 成功后，此处仅暴露读/清）；
- `get` 按 id 取单份，不存在时 throw（renderer 侧 sanitize 展示）；
- diff 由 renderer 侧 `diffPreflight` 纯函数计算，不走 IPC。

### 17.5 UI（独立历史视图，不动现有 preflight 面板逻辑）

- 新文件 `src-renderer/preflight-history.tsx`（`PreflightHistoryModal`）；
  `App.tsx` 只加：import + `preflightHistoryOpen` 状态 + 顶栏「Preflight 历史」按钮 + 挂载。
- 视图：按目标库分组 → 同组内选两次（跨组点击直接换组并 toast 提示；已选时他组禁用）
  → 展示 verdict 变化 + issues 新增/消失/等级变化；`<2` 次时 hint 指引；清空需二次确认。
- 状态全 renderer-only 本地 state，不进 Zustand；复用既有 `modal` / `data-status` 行式，
  另补 3 行 `button.data-status-row` 样式（文件尾追加）。

### 17.6 保密边界

- `PreflightReport` 本不含 secret（facts 是版本/行数/结构计数，见 §11.1）；
  入库字段逐项可扫描：`password / sshPassword / privateKey / passphrase / vaultCiphertext /
  secret / SHOW GRANTS` 全文不得出现（`preflight-history-store.test.ts` 无秘密入库用例硬约束）。

### 17.7 测试

- `tests/core/preflight-history.test.ts`（9 项）：新增 / 消失 / 等级变化 / verdict 翻转 /
  无变化空 diff / v1 旧报告回填 / 分组键与同组判定 / 条目守卫（合法+非法）。
- `tests/main/preflight-history-store.test.ts`（7 项）：回环排序 / 同组 10 份滚动 /
  跨组互不影响 / 同 id 去重后置顶 / 非法 throw / get+clear / 无秘密入库扫描。
- `tests/main/preflight-run-history.test.ts`（3 项）：成功 append 一次（含字段与无秘密断言）/
  append 抛错隔离（主流程照常返回）/ aborted 不写。

### 17.8 回滚

- 删 `preflight-history.json` 即清空历史，无迁移脚本；
- 回滚路径：revert `preflight-run.ts` 阶段 7b + IPC 三通道 + `App.tsx` 4 处加法，
  其余新文件留存但不被调用。
