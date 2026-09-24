# Research: MySQL schema/data diff 与迁移审查工作流

- **Query**: 研究 MySQL 结构/数据对比从“发现差异”到“安全迁移、验证、回滚和留痕”的真实工作流，并映射 SqlDiff 当前覆盖与缺口。
- **Scope**: mixed（官方 MySQL/工具文档 + 当前仓库）
- **Date**: 2026-09-24
- **证据标记**: `FACT` = 文档或源码直接显示；`INFERENCE` = 跨来源归纳；`HYPOTHESIS` = 需要用户/实验验证。

## Findings

### 1. 结论摘要

1. **结构/数据 diff 不是终点，而是迁移状态转换中的一个环节。** MySQL Workbench、Flyway、Liquibase、Atlas、Bytebase 和 DataGrip 的官方流程都把比较、生成脚本、风险/策略、发布/验证和留痕串成闭环；这是产品工作流事实，不是 SqlDiff 用户需求已被证明。
2. **SqlDiff 当前已经覆盖“读取实时 A/B → 生成差异 → 本地风险提示 → 预览/导出”，但还没有持久化的审查包、策略门禁、基线漂移、执行后验证或自动审计。** 依据：仓库路径见 [`repository-evidence.md`](repository-evidence.md)。
3. **生产安全的核心不是多生成几条 DDL，而是回答“这个 ALTER 在当前表、版本、空间、锁和复制条件下会怎样”。** MySQL 8.4 的 Online DDL 矩阵、Percona 和 gh-ost 都把算法、锁、重建、负载、复制延迟、备份和测试列为显式约束。
4. **数据 diff 的第一等问题是对齐身份和可承受的读取规模。** 无 PK/UNIQUE、复合键、宽表、BLOB、列映射、重复值和在线写入都会影响结果；SqlDiff 已对部分情况给出状态/阈值，但尚未提供数据库端流式或可审计的恢复工作流。

### 2. 跨产品工作流地图（FACT）

下表只记录各官方页面直接描述的能力；“缺口”是与 SqlDiff 当前范围的对照推断。

| 阶段 | 官方工作流证据 | 对 SqlDiff 的直接含义 |
|---|---|---|
| 选择输入状态 | Workbench 可比较两个 live databases、两个 models 或 model 与 live database；Flyway 支持 live DB、snapshot、schema model 和 empty source；Atlas 的 `--from/--to` 可为 DB URL、HCL/SQL schema 或 migration directory。 | SqlDiff 目前主要是两个实时 MySQL DB；“基线文件/快照”是相邻但未实现的状态来源。 |
| 读取与归一化 | Workbench Migration Wizard 先从源/目标取 schema，再 reverse engineer；DBeaver 允许 schema/database、对象类型、case-insensitive 等设置；Liquibase 将结果归为 Missing/Unexpected/Changed。 | 需要明确“对象身份、忽略项、权限失败和 dialect/version”是否可解释，而不是只显示文本差异。 |
| 生成结构差异 | Workbench 生成可编辑/可同步 SQL；DataGrip 生成把 Target 变成 Origin 的 migration script；DBeaver 支持 CREATE/ALTER/DROP 与多种报告格式。 | SqlDiff 已有 MySQL CREATE/DROP/ALTER 生成，但结果主要是一次性 IPC 返回，未形成可重放 artifact。 |
| 生成数据差异 | DBeaver Data Compare 支持表/查询、多对象配对、列映射、key columns、限制行数、SQL/HTML/Daff 导出；DataGrip 比较表/视图/物化视图输出并支持 tolerance。 | SqlDiff 的 PK/UNIQUE、表映射、阈值和 DML 三态是合理底座；仍缺少列映射可视化、容差/采样/二进制策略和可分享结果。 |
| 风险与兼容性 | Flyway 会对 DROP table 等生成高等级 warning；Atlas 有 destructive/data-dependent analyzer、skip destructive、concurrent index policy；Liquibase 有 rollback/policy checks；Bytebase 有 SQL advisor、风险评估和兼容性检查。 | 现有 `risk.ts` 是确定性提示，不等于 MySQL 版本/表规模/复制环境下的兼容性分析。 |
| 审查与选择 | DataGrip 可逐项排除/包含 change；DBeaver 可保存任务、查看报告、选择执行；Atlas/Bytebase 可在 CI/PR 中阻断错误。 | SqlDiff 的过滤和 DROP 二次确认是交互雏形，但没有“审查对象、策略结果、谁批准、批准了哪些语句”。 |
| 执行/发布 | DataGrip/Workbench/DBeaver 均可从预览进入执行；Bytebase 将审批、分环境 rollout、监控和回滚作为生命周期。 | SqlDiff 明确不执行，这是信任边界；不能把竞品的 execute 能力直接当作产品缺口。 |
| 验证/漂移 | Flyway 的 diff artifact、validate/checksum 和 drift；Liquibase diff 可检测 model/database drift；Atlas 监控/漂移检测；Prisma `migrate diff --exit-code` 可作 CI gate。 | 当前 `HistoryEntry` 只有摘要，不能回答“上次确认后哪里漂移”或“这次 artifact 是否仍对应目标状态”。 |
| 恢复与复盘 | Liquibase rollback 区分可自动生成与需手写 rollback，并警告 DROP/DELETE 数据不能恢复；Percona sync 要求 dry-run/backup；gh-ost 建议 replica test、noop、checksum。 | SqlDiff 的 rollback 文本应定位为“人工恢复提示/审查证据”，而非可承诺的自动回滚。 |

### 3. 一个可复用的迁移审查状态机（INFERENCE）

这是跨来源归纳的最小模型，不是任何单一产品的硬性规定：

```text
输入状态
  live DB / snapshot / schema model / migration history / query result
        ↓
读取与归一化
  scope、对象身份、case/owner/default/ignore policy、权限与版本信息
        ↓
差异计算
  schema diff + data diff + 行身份/映射/采样策略
        ↓
风险与兼容性
  destructive、数据依赖、online algorithm/lock、空间、复制延迟、备份
        ↓
人工审查
  逐项选择、解释、例外/allowlist、审批记录
        ↓
交付/执行
  SQL/报告/PR/CI；执行器由用户或外部系统负责
        ↓
验证与恢复
  drift check、行数/checksum、回滚或重新同步、审计归档
```

**SqlDiff 当前覆盖（FACT）**：输入状态主要是两个实时 MySQL DB；归一化和 diff 已有对象/范围/表过滤；数据行有身份决策和阈值；结果有分类、风险说明、预览、复制、导出；历史只保存摘要。证据：`apps/desktop/src-main/compare-run.ts:53-141`、`apps/desktop/src-main/data-run.ts:251-320`、`apps/desktop/src-core/risk.ts:37-116`、`apps/desktop/src-core/types.ts:118-128`。

**尚未覆盖（FACT）**：没有输入快照/项目 manifest、逐项审批状态、跨环境漂移 job、执行后验证、可执行 rollback、结构化 CI 输出。证据：`apps/desktop/src-core/types.ts:139-207` 没有 project/job/report 字段；`apps/desktop/src-main/store-json.ts:98-115` 只追加摘要历史。

### 4. MySQL 结构迁移的生产安全事实

#### 4.1 Online DDL 不是“所有 ALTER 都低风险”（FACT）

MySQL 8.4 官方 Online DDL 矩阵显示：

- 新增/删除二级索引通常可 in-place，并可并发 DML；删除索引主要修改元数据。
- 新增主键需要重建表并可能长时间昂贵；删除主键不是 in-place，不能并发 DML；主键替换会重建表。
- `ALGORITHM` 和 `LOCK` 可用于约束可用算法/并发度；请求的并发级别不可用时，操作应立即停止，而不是静默降级为更危险的 copy 行为。

来源：[`InnoDB and Online DDL`](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl.html)、[`Online DDL Operations`](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html)，访问 2026-09-24。

**INFERENCE**：SqlDiff 当前的 `ADD INDEX`/`DROP PRIMARY KEY` 风险分类不能直接回答这些运行时问题；若做 preflight，至少要把版本、表定义、算法/锁候选、空间和复制状态作为“证据字段”，不能只根据 SQL 关键字给出安全结论。

#### 4.2 权限与元数据不是无条件的全局事实（FACT）

MySQL 官方 `SHOW CREATE PROCEDURE` 文档说明，返回完整创建语句需要 routine `DEFINER` 身份或相应 `SHOW_ROUTINE`/全局 `SELECT`/routine scope 权限；权限不足时 `Create Procedure/Function` 可能为 `NULL`。`INFORMATION_SCHEMA.TABLES.TABLE_ROWS` 对 InnoDB 是近似值，官方警告误差可达约 40%–50%，准确行数应使用 `SELECT COUNT(*)`。

来源：[`SHOW CREATE PROCEDURE`](https://dev.mysql.com/doc/refman/8.4/en/show-create-procedure.html)、[`INFORMATION_SCHEMA.TABLES`](https://dev.mysql.com/doc/refman/8.4/en/information-schema-tables-table.html)，访问 2026-09-24。

**与实现的连接**：SqlDiff 已经在 `data-run` 中对无行身份和权限失败给出局部状态，但 metadata 的 `SHOW CREATE` 失败目前以 `null` 进入比较层并跳过；产品若要声称“全库无差异”，必须把不可读对象计入 coverage/permission report。证据：`apps/desktop/src-main/metadata.ts:26-32,190-201`、`apps/desktop/src-core/compare.ts:63-69,111-138`。

### 5. 数据 diff 的实际工作流与边界

#### 5.1 行身份是结果可信度的一部分（FACT）

- DBeaver 的 Data Compare 明确要求用户配置 key columns，复合 key 可组合；DataGrip 通过 tolerance 决定两行何时视为相同。
- SqlDiff 优先 PK；无 PK 时接受两侧一致的全列显式 `NOT NULL` UNIQUE；无身份时跳过行级 diff，只给行数并建议加身份或使用整行 hash 抽样；两侧身份不一致则报 `pk-mismatch`。
- 这说明“没有 PK”不是 UI 空状态，而是数据结论的覆盖率/可信度问题。

来源：[DBeaver Data Compare](https://dbeaver.com/docs/dbeaver/Data-compare/)、[DataGrip Compare Data](https://www.jetbrains.com/help/datagrip/compare-data.html)；内部：`apps/desktop/src-main/data-run.ts:121-166`、`apps/desktop/src-main/data-run.ts:180-210`。

#### 5.2 大表需要资源与复制保护（FACT）

- Percona `pt-online-schema-change` 默认在副本表上复制、分块并用触发器同步；文档要求先读风险、在非生产测试、备份，并提供 replica lag、load、foreign key 和 replication filter 等保护。
- `pt-table-checksum` 以小块在线检查复制一致性，监测 replica 延迟并在延迟过大时暂停；`pt-table-sync` 会修改数据，文档要求 dry-run、备份和谨慎使用。
- gh-ost 使用 binary log 而非 triggers，支持 pause、动态控制、审计、replica test、noop 和 cut-over 控制。

来源：[Percona pt-online-schema-change](https://docs.percona.com/percona-toolkit/pt-online-schema-change.html)、[`pt-table-checksum`](https://docs.percona.com/percona-toolkit/pt-table-checksum.html)、[`pt-table-sync`](https://docs.percona.com/percona-toolkit/pt-table-sync.html)、[GitHub gh-ost](https://github.com/github/gh-ost)，访问 2026-09-24。

**INFERENCE**：这些是“在线变更/复制一致性工具”的能力，不应被直接移植成 SqlDiff 自动执行功能；但它们提供了生产 preflight 应覆盖的风险维度：表大小、索引/主键重建、可用磁盘、复制延迟、触发器/外键冲突、备份和可回滚 cut-over。

#### 5.3 当前数据 diff 的工程限制（FACT）

- `fetchAllByPK` 虽采用 keyset 分页，但最终将整表放入 `DataRow[]`；`diffDataRows` 再建立 A/B 两个 Map。证据：`apps/desktop/src-main/data-fetch.ts:105-134`、`apps/desktop/src-core/data-diff.ts:89-142`。
- Buffer 当前调用 `toString('utf8')`，没有二进制专用序列化；INSERT 使用第一行的 `Object.keys` 生成 values，没有显式列清单。证据：`apps/desktop/src-core/data-diff.ts:64-80`。
- 逐表串行、A/B 并行和超阈确认能控制一部分峰值，但 `CompareResult` 仍同步返回完整 items；超大结果跨 IPC/本地存储的边界尚未验证。证据：`apps/desktop/src-main/data-run.ts:214-229,286-320`、`apps/desktop/src-core/types.ts:202-207`。

### 6. 迁移审查的最小可交付物（INFERENCE / HYPOTHESIS）

从上述工作流归纳，最小审查包不必一开始包含执行器，但应让结果可重放、可交接、可追责：

```text
manifest.json
  schemaVersion / toolVersion / timestamp
  source + target identity（别名、数据库、版本；不含密码）
  scope / filters / data mappings / options
  input fingerprints 或 snapshot references
  object coverage（成功、跳过、权限失败、超阈）
  diff items（SQL、分类、风险、解释、回滚提示）
  policy results（规则版本、warning/error、例外）
  reviewer / approval state（若允许人工填写）
```

这是**产品假设**，不是当前代码事实；其价值假设是用户需要在两个实时库之外保留“这次检查的证据”。最小验证应先导出脱敏 Markdown/JSON，再观察用户是否会把它交给同事、PR 或发布流程，而不是先建设云端审计系统。

## External References

| 来源 | 直接观察 | 对本研究的用途 |
|---|---|---|
| [MySQL Workbench Schema Synchronization](https://dev.mysql.com/doc/workbench/en/wb-design-schema.html) | 可比较 live DB、models、model/live DB，并可同步。 | 证明可视化比较/同步是 MySQL 官方既有工作流。 |
| [MySQL Workbench Migration Wizard](https://dev.mysql.com/doc/workbench/en/wb-migration-overview-steps.html) | 读取 schema、反向工程、转换、编辑生成代码、创建目标并复制数据。 | 证明迁移包含状态转换和人工修正，不只是 diff 文本。 |
| [DBeaver Schema Compare](https://dbeaver.com/docs/dbeaver/Schema-compare/) | Enterprise/Ultimate；source/target、对象过滤、DDL/JSON/YAML 等报告、任务保存、目标执行。 | 对比“报告/任务/执行”层与 SqlDiff 的只读边界。 |
| [DBeaver Data Compare](https://dbeaver.com/docs/dbeaver/Data-compare/) | 表/查询配对、列映射、key columns、限制、SQL/HTML/Daff 导出。 | 直接对照 SqlDiff 数据表映射和行身份设计。 |
| [DataGrip schema comparison](https://www.jetbrains.com/help/datagrip/schema-comparison-and-migration.html) | Origin/Target、DDL diff、脚本预览、选择变更、执行。 | 证明 IDE 用户期待可编辑/可选择的迁移脚本。 |
| [Flyway database comparisons](https://documentation.red-gate.com/flyway/flyway-concepts/database-comparisons) | snapshot/schema model、diff artifact、warning、生成脚本。 | 证明快照和 artifact 是治理型工具的重要中间层。 |
| [Liquibase diff](https://docs.liquibase.com/secure/reference-guide-5-1-1/database-inspection-change-tracking-and-utility-commands/diff) | reference/target、Missing/Unexpected/Changed、drift、JSON/stdout、对象类型过滤。 | 证明 drift 语义和结构化输出。 |
| [Atlas schema diff](https://atlasgo.io/declarative/diff) / [analyzers](https://atlasgo.io/lint/analyzers) | from/to 多种状态、skip destructive/concurrent index、CI lint。 | 提供策略/门禁方向参照。 |
| [Bytebase change workflow](https://docs.bytebase.com/change-database/change-workflow) / [SQL Review CI](https://docs.bytebase.com/gitops/migration-based-workflow/sql-review-ci) | 计划、SQL review、审批、多环境 rollout、回滚、PR/MR 反馈。 | 提供团队治理工作流参照。 |
| [Prisma migrate diff](https://www.prisma.io/docs/cli/migrate/diff) | 任意 schema source 比较、human/script 输出、`--exit-code`。 | 提供轻量 CLI gate 的开发者先例，同时提醒 unsupported features。 |

## Caveats / Not Found

- 官方文档证明的是产品能力和推荐工作流，不证明 SqlDiff 目标用户每周使用的频率、痛点强度或付费意愿。
- MySQL 8.4 文档用于说明 8.4 行为；其他 MySQL/MariaDB 版本、托管变体的 online DDL、权限和 metadata 语义必须用真实版本 fixture 验证。
- DBeaver/Flyway/Liquibase/Atlas/Bytebase 的 edition、授权和功能边界可能变化；价格和功能只作为方向信号。
- 本研究没有运行真实生产库、在线迁移工具或 DDL；没有把任何外部工具的执行能力当作 SqlDiff 的实现建议。
