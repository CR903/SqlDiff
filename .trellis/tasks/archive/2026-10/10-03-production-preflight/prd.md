# P0 生产 Preflight v1（只读变更检查）

- 前置：`09-29-review-manifest`、`09-29-result-source-state`、`09-29-grant-blindness-false-drop`、`09-29-compare-service-integration-tests` 均已归档
- 对应路线图：`.trellis/tasks/archive/2026-09/09-24-product-expansion-roadmap/roadmap.md` §4 Phase 2 方向 C
- 后续依赖：headless CI v1（需要 PreflightReport 作为 CI gate 输入）

## Goal

在把一次比较得到的 DDL/DML 交给外部执行流程之前，让 DBA/后端负责人**用一次只读检查**回答六个问题：

1. 目标库的 MySQL 版本、`sql_mode`、关键系统变量是什么？
2. 目标表的实际行规模、平均行宽、数据/索引空间估计有多大？
3. 每一条 DDL 对应的 Online DDL 算法与锁级别是什么？会不会重建表？
4. 目标库的复制状态（是否为主/从、是否有延迟、是否 `read_only`）如何？
5. 当前账号在目标库上的可见性盲区有多大？
6. 基于以上事实，哪些变更是**可以发布 / 需要确认 / 应当阻断**？

输出必须是「事实 / 推断 / 未知」三段结构：**Fact** = 从只读查询直接观测到；**Inference** = 基于 Fact 应用确定性规则推导；**Unknown** = 因权限、版本或查询失败无法判定。

调用外部 online migration 工具（`pt-online-schema-change`、`gh-ost`）、不生成 cut-over 命令、不执行 SQL 都在 Out of Scope。

## Background / Confirmed Facts

### 1. 只读基础设施已就绪（前 P0 子任务产出）

| 已有能力 | 位置 | 用途 |
|---|---|---|
| 单跳 SSH 隧道 + mysql2 pool | `apps/desktop/src-main/connection.ts:301-318` | 连接目标库 |
| `SHOW CREATE TABLE/PROCEDURE/FUNCTION/VIEW` | `apps/desktop/src-main/metadata.ts:127-150` | 拿 DDL 原文 |
| `information_schema.tables` 表名枚举 | `apps/desktop/src-main/metadata.ts:57-62` | 列清单 |
| `SHOW GRANTS FOR CURRENT_USER()` | `apps/desktop/src-main/grants.ts:20` | 权限盲区探针 |
| 授权可见性判定 | `apps/desktop/src-core/visibility.ts`（`parseGrantLines`、`visibilityFor`） | 库级 full/partial |
| 覆盖状态词汇 | `types.ts:211,304-311` | 与 coverage/manifest 共用 |
| Versioned manifest 序列化 | `apps/desktop/src-core/manifest.ts` | PreflightReport 复用其形状 |
| `escapeIdent` / `escapeDataIdent` / `sqlLiteral` | `metadata.ts:65`, `data-diff.ts:36-68` | 若需构造查询用 |

### 2. DiffItem 已带 DDL 原文

`DiffItem.sql` 是**已经生成好的 DDL/DML 文本**（`types.ts:96`）。Preflight 不需要重新构造 DDL——只需解析已有文本决定操作类别，然后查 Online DDL 矩阵。这避免了 preflight 与 compare 之间的一致性漂移。

### 3. 只读 SQL 清单是硬边界

`database-guidelines.md:17-22` 明确只允许：`SELECT 1`、`SELECT COUNT(*)` 和 keyset `SELECT *`、`information_schema` 列表、`SHOW CREATE`、`SHOW GRANTS FOR CURRENT_USER()`。**Preflight 新增的查询必须落在或紧贴这个清单**：新增的读库语句只能使用 `information_schema` / `performance_schema` / 系统变量 (`@@`) / `SHOW` 只读形式，不得引入任何写操作、`SET` 语句、`SELECT ... FOR UPDATE`。

### 4. MySQL Online DDL 官方矩阵是外部事实

MySQL 8.4 官方文档 [Online DDL operation matrix](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html) 与 [INPLACE vs COPY algorithm](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl.html) 明确区分每种 ALTER 操作对应的 Lock mode 与 Table rebuild。Percona pt-online-schema-change 与 gh-ost 把副本测试、分块复制、replica lag、load、cut-over 作为生产变更控制。这些是外部事实，Preflight 只引用不复制。

### 5. 已有 manifest / coverage / visibility 类型可复用

PreflightReport 的输出形状应**与 manifest 一致**（versioned、无秘密、可 JSON/Markdown 导出），但可以独立 schema 版本。**不合并到 ReviewManifest**——manifest 描述「差异是什么」，preflight 描述「应用差异会发生什么」，两者互补而非替代。

### 6. 无现有 preflight 代码

`grep -r "preflight\|Preflight\|@@version\|REPLICATION\|TABLE_STATS" apps/desktop/src-*` 结果：只在 `grants.ts` 与 `metadata.ts` 的注释中提及 SHOW GRANTS / information_schema，没有独立的 preflight 模块。**本任务是新建能力，不是重构。**

## Requirements

### R1 只读输入

- 输入为一个已完成的 `CompareResult`（来自一次真实比较，`source === 'real'`）与目标连接 B 的 `NodeMeta` / `SecretBundle`。
- Preflight 不重新跑比较；只读 B 侧数据库（A 侧的连接信息不用于 preflight，因为变更是应用到 B 的）。
- 全程只执行只读 SQL（`SELECT`、`SHOW`、`@@`、`information_schema`、`performance_schema`），不新增任何写库路径。

### R2 六类事实（Fact）

对目标库 B 采集以下事实，每项记录来源查询与观测时间：

- **Server**：`VERSION()`、`@@version_comment`、`@@sql_mode`、`@@innodb_file_per_table`、`@@transaction_isolation`、`@@lower_case_table_names`、`@@character_set_server`、`@@collation_server`。
- **Variables**：`@@innodb_buffer_pool_size`、`@@max_connections`、`@@tmp_table_size`、`@@sort_buffer_size`、`@@thread_cache_size`、`@@innodb_page_size`、`@@max_allowed_packet`。
- **Tables**：对每个 B 库中出现的表，从 `information_schema.tables` 取 `TABLE_ROWS`、`DATA_LENGTH`、`INDEX_LENGTH`、`DATA_FREE`、`ENGINE`、`ROW_FORMAT`、`AUTO_INCREMENT`、`UPDATE_TIME`、`CHECKSUM`。
- **Indexes**：从 `information_schema.statistics` 与 `information_schema.key_column_usage` 取每张表的主键、唯一/非唯一索引、外键。
- **Replication**：`SHOW REPLICA STATUS`（或 5.7 兼容的 `SHOW SLAVE STATUS`）、`@@server_id`、`@@read_only`、`@@super_read_only`、`@@log_bin`、`@@gtid_mode`。若查询失败或库不是 replica，标记为 `not-applicable`。
- **Grants**：`SHOW GRANTS FOR CURRENT_USER()`（复用 `assessVisibility`），产出库级 `Visibility`。

### R3 推断（Inference）

基于 R2 的 Fact，用**确定性、纯函数**的规则推出以下结论（每条都要能追溯到具体 Fact）：

- **DDL 分类**：把每条 `DiffItem.sql` 分类为 `ADD_COLUMN` / `DROP_COLUMN` / `MODIFY_COLUMN` / `CHANGE_COLUMN` / `ADD_INDEX` / `ADD_UNIQUE_INDEX` / `ADD_PRIMARY_KEY` / `DROP_INDEX` / `CONVERT_TO_CHAR_SET` / `CHANGE_ENGINE` / `CREATE_TABLE` / `DROP_TABLE` / `RENAME_TABLE` / `CREATE_INDEX` / `DROP_INDEX_STANDALONE` / `OTHER`。
- **Online DDL 算法与锁级别**：对每条 DDL，按 MySQL 版本查询内置矩阵表得到 `algorithm`（`INSTANT` / `INPLACE` / `COPY`）与 `lock_mode`（`NONE` / `SHARED` / `EXCLUSIVE` / `EXCLUSIVE-BRIEF`），并记录是否重建表。
- **空间预算**：对每张目标表估算「变更前后额外需要的空间」（如 `ADD INDEX` 需要 ≈ index_length 增量；`CONVERT_TO_CHAR_SET` 到 `utf8mb4` 需要 1.33× DATA_LENGTH）。
- **高风险规则**（每条规则触发一个 `PreflightIssue`）：
  - `BIG_TABLE_COPY`：目标表 `TABLE_ROWS` 超过阈值（默认 100 万）且 DDL 类别落入 COPY 类 → block。
  - `NO_PRIMARY_KEY`：DDL 涉及 `DROP INDEX` 后导致目标表无任何主键/唯一索引 → warn。
  - `REPLICA_LAG`：`Seconds_Behind_Master` 超过阈值（默认 30 秒）→ warn。
  - `READ_ONLY_TARGET`：目标库 `@@read_only` 或 `@@super_read_only` 为 1 → block（发布前必须临时解除）。
  - `GTID_MISMATCH`：主从 GTID 配置不一致 → warn。
  - `PERMISSION_INCOMPLETE`：目标库 `Visibility !== 'full'` 或 `reliable === false` → warn。
  - `LARGE_TABLE_INSTANT_ADD`：`ADD COLUMN` 在 MySQL 8.0.12+ 且不含默认值时 → 记录为「可用 INSTANT」的正面推断。

### R4 未知（Unknown）

对以下情形显式记录 Unknown，**不能用默认值伪装为确定**：

- **权限不足**：任何只读查询返回权限类错误码 → `reason: 'permission-denied'`。
- **查询失败**：非权限类的查询异常 → `reason: 'query-failed'`。
- **版本不支持**：MySQL 版本 < 5.7 或 > 8.4，且矩阵表未收录 → `reason: 'unsupported-version'`。
- **不适用**：目标是 replica 但当前账号无 `REPLICATION CLIENT`，无法查询 `SHOW REPLICA STATUS` → `reason: 'not-applicable'`。
- **DDL 无法解析**：`DiffItem.sql` 落入 `OTHER` 且未命中任何规则 → `reason: 'unparsed-ddl'`。

### R5 输出形状

- `PreflightReport`（versioned、无秘密、只含结论和证据摘要）。字段级结构见 design.md。
- 支持 JSON 与 Markdown 两种导出，Markdown 面向人工交接，JSON 面向机器消费。
- 导出物不含：连接凭据、行值、Vault 密文、原始 `SHOW GRANTS` 文本。
- 与 `ReviewManifest` **不合并**（后者是差异记录，本者是应用风险评估），但 schema 版本策略、序列化确定性、脱敏器规则保持一致。

### R6 无执行入口

- 全链无 `pool.query(diff.sql)` 路径。
- 不调用 `pt-online-schema-change` / `gh-ost` / 任何外部 migration 工具。
- 不生成 cut-over 命令、不写调度、不托管凭据。
- `mysqldiff/` 保持不动。

## Acceptance Criteria

- [ ] AC1 `PreflightReport` 携带 `schemaVersion: 1`、`appVersion`、`checkedAt`、`targetAlias`、`targetDatabase`、`source: 'real'`。
- [ ] AC2 六类 Fact 各自可查（Server / Variables / Tables / Indexes / Replication / Grants），每项含 `source` 查询名、`observedAt` 时间戳、原始值。
- [ ] AC3 对每条进入 preflight 的 `DiffItem`，产出确定性 DDL 分类；`OTHER` 分类的条目记录为 `unparsed-ddl` Unknown。
- [ ] AC4 DDL 分类 + MySQL 版本 → `algorithm` / `lock_mode` / `rebuild` 三态映射有完整单元测试（覆盖 MySQL 5.7 与 8.0 两个版本 × 至少 10 种 DDL 操作）。
- [ ] AC5 高风险规则至少 7 条（BIG_TABLE_COPY、NO_PRIMARY_KEY、REPLICA_LAG、READ_ONLY_TARGET、GTID_MISMATCH、PERMISSION_INCOMPLETE、LARGE_TABLE_INSTANT_ADD）各自有独立测试。
- [ ] AC6 Fact / Inference / Unknown 三段结构在导出物中显式区分；每条 Inference 能追溯到具体 Fact（`evidence` 字段非空）。
- [ ] AC7 Unknown 的 reason 至少覆盖 `permission-denied` / `query-failed` / `unsupported-version` / `not-applicable` / `unparsed-ddl`。
- [ ] AC8 JSON 导出为合法 JSON，字段顺序即类型声明顺序（byte 稳定），Markdown 导出含头部 + Fact 表 + Inference 表 + Unknown 表 + 结论 + 保密声明。
- [ ] AC9 Preflight 全程不执行任何 `DiffItem.sql`；`grep -rn "\.query\(.*sql\|pool\.execute" apps/desktop/src-main/preflight*` 为空。
- [ ] AC10 `mysqldiff/` 未改动；无 `pt-online-schema-change` / `gh-ost` / `cut-over` 字符串进入代码库。
- [ ] AC11 PreflightReport 不含任何 `password` / `privateKey` / `passphrase` / Vault 密文 / 行值 / 原始 SHOW GRANTS 文本（脱敏器单测覆盖）。
- [ ] AC12 typecheck / lint / test / build 四件套全绿。

## Out of Scope

- 调用 `pt-online-schema-change`、`gh-ost` 或任何外部 online migration 工具。
- 生成 cut-over 命令、脚本或调度。
- 修改目标库的读/写状态、执行任何 DDL/DML。
- 多目标并行 preflight（v1 只支持单目标）。
- 与 `ReviewManifest` 合并（互补不替代）。
- 自动判定「允许发布 / 阻断发布」（Preflight 只给建议 `verdict`，不做硬阻断）。
- A 侧数据库的 preflight（v1 只针对 B）。
- 数据 DML 的 preflight（v1 只针对 DDL；数据 DML 属后续 reconciliation 方向）。
- 版本 < 5.7 或 > 8.4 的完整支持（超出范围的版本记 `unsupported-version` Unknown，不做兜底猜测）。

## Open Questions

- ~~Q1 Preflight 是否重新拉一遍元数据？~~ **已定**：不重新拉。复用传入的 `CompareResult.items`（其 `sql` 字段已是 DDL 文本），只读 B 库的运行时状态。
- ~~Q2 PreflightReport 是否与 ReviewManifest 合并？~~ **已定**：不合并。两者互补：manifest 描述差异、preflight 描述应用风险；schema 独立版本。
- ~~Q3 高风险阈值由谁定？~~ **已定**：内置默认值（100 万行 / 30 秒延迟），可运行时覆盖；v1 不做可配置策略。
- ~~Q4 数据 DML 是否纳入？~~ **已定**：v1 不纳入。DML 的 preflight 语义（是否影响复制、是否触发 trigger、是否触及分区边界）与 reconciliation 报告高度重叠，单独排期。
- ~~Q5 Preflight 输出是否需要与 ReviewManifest 联动？~~ **已定**：v1 不联动。UI 提供两个独立按钮（导出审查报告 / 运行 preflight），各自独立导出。

## Key Decisions

| # | 决策 | 依据 |
|---|---|---|
| Q1 | 不重跑比较，只解析已有 DiffItem.sql | 避免 preflight 与 compare 的语义漂移；DDL 文本是 compare 的唯一事实来源 |
| Q2 | PreflightReport 独立 schema，不与 manifest 合并 | 差异记录 vs 应用风险是两种独立工件，用户交接时经常分开使用 |
| Q3 | 输出严格三段：Fact / Inference / Unknown | 路线图 §4 Phase 2 明确「输出事实/推断/未知」；避免「默认值伪装确定」的产品语义风险 |
| Q4 | DDL 矩阵为内置静态表 + 版本分支 | 官方矩阵是外部 FACT，产品不应在运行时抓取文档；矩阵缺失版本返回 Unknown 而非猜测 |
| Q5 | 阈值内置默认值，不做可配置 | v1 优先验证价值；用户反馈后再决定是否暴露配置 |

## Notes

- 依据：`.trellis/tasks/archive/2026-09/09-24-product-expansion-roadmap/roadmap.md` §4 Phase 2 方向 C，`research/candidate-directions-and-validation.md` §4 方向 C 最小切片。
- 前置任务的类型与 spec 已合并到 `main` 分支（`ReviewManifest` 契约见 `.trellis/spec/backend/manifest-export.md`）。
- 真实目标库环境（内网 MySQL）仍不可达；本任务的实验门槛以 Docker MySQL 5.7 / 8.0 fixture 为准，不宣称「已支持指定内网库」。
