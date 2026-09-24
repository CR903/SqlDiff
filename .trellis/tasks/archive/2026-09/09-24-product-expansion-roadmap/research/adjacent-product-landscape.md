# Research: 相邻产品与竞争格局

- **Query**: 盘点 MySQL schema/data diff、数据库迁移治理、桌面数据库客户端和在线变更工具的真实功能/商业化边界，寻找 SqlDiff 的差异化位置与未满足空白。
- **Scope**: mixed（官方产品文档、定价页、GitHub README、当前仓库）
- **Date**: 2026-09-24
- **证据标记**: `FACT` = 官方页面直接描述；`INFERENCE` = 对产品定位的推导；`HYPOTHESIS` = 尚待用户验证的机会判断。

## Findings

### 1. 竞争地图摘要

- **INFERENCE**：基础 diff 已是拥挤品类。DBeaver、DataGrip、MySQL Workbench、Flyway、Liquibase、Atlas、Prisma 都能在某种输入/输出边界内比较结构；仅凭“能生成 SQL”不足以证明差异化。
- **INFERENCE（外部功能/包装事实）**：商业化重心在治理、自动化和协作。DBeaver 把 schema compare/migration 放在 Enterprise/Ultimate/Team 等更高层；Atlas/Bytebase/Flyway/Liquibase 把 CI、策略、漂移、审计、审批、回滚和团队能力分层呈现。
- **INFERENCE**：SqlDiff 的可防守起点是本地、MySQL-only、只读、秘密不进入普通导出，以及面向人工审查的轻量闭环。这是基于当前代码的定位推断，不是市场占有或用户偏好事实。
- **HYPOTHESIS**：最有价值的相邻空白不是“更多数据库连接选项”，而是把一次 diff 变成可解释、可交接、可验证的 MySQL 迁移证据；仍需用户实验证明。

### 2. 产品逐项观察

| 产品 | 官方直接证据 | 商业/包装信号 | 对 SqlDiff 的含义 |
|---|---|---|---|
| **DBeaver Schema Compare** | Enterprise/Ultimate；比较 schema/database/full DB；可选对象；生成 CREATE/ALTER/DROP；可导出 DDL/Change Log/JSON/YAML/纯文本；可保存任务、刷新报告、复制、打开编辑器或执行。页面明确警告迁移不能自动撤销。 | DBeaver edition 页面同时列出 Enterprise/Ultimate 的 schema compare/migration、table data comparison；Team Edition 强调 user/role、共享资源和实时协作。 | 证明结构比较本身可被商业化，但高级报告、任务、团队能力是分层价值；SqlDiff 不应靠基础 diff 与其正面竞争。 |
| **DBeaver Data Compare** | 表/查询结果、多表配对、列映射、key columns、复合键、行数限制、SQL/HTML/Daff 导出、summary；可指定把脚本应用到 source 或 target。 | 与 schema compare 一起作为开发/数据库工具能力，而非单纯社区小功能。 | SqlDiff 已有 A/B 表映射、PK/UNIQUE 和 DML；差异在报告/任务/大表治理/生态连接。 |
| **DataGrip** | 同类型对象比较；Origin/Target；Migration dialog、DDL diff、Script Preview；可逐项排除/包含并 Execute。数据比较支持表/视图/物化视图、tolerance，默认结果行限制 500。 | JetBrains IDE 产品，核心价值是开发工具集合；没有在所查官方页面看到单独 diff 价格。 | 证明“可视化差异 + 可编辑脚本”是 IDE 既有体验；SqlDiff 若做 IDE 入口需避免功能重叠，优先做跨工具审查包。 |
| **MySQL Workbench** | Schema Synchronization 可比较 live DB、models 或 model/live DB并同步；Migration Wizard 读取源/目标、反向工程、转换类型/默认值、展示并编辑生成代码、创建目标、复制数据。 | MySQL 官方桌面工具，能力与 MySQL 生态紧密结合。 | 是 MySQL 原生基准；SqlDiff 的机会不在重复完整迁移向导，而在更快的审查/交接或特定安全场景。 |
| **Redgate Flyway** | Teams comparison technology 支持 SQL Server/Oracle/PostgreSQL/MySQL；可比较 live DB、snapshot、schema model；diff artifact 供 generate/model 使用；DROP table 等会产生高等级 warning，可中止 pipeline。 | 文档标为 Teams；Enterprise CLI 支持 snapshot → check changes 或 diff → prepare。 | 证明“快照 + artifact + warning + pipeline”是比一次 GUI diff 更完整的迁移模型。 |
| **Liquibase** | `diff` 比较 reference URL 与 target URL，输出 Missing/Unexpected/Changed，可做 drift report、JSON/stdout、过滤对象类型；Secure 增加 procedure/function/trigger 等。`rollback` 区分自动/手写 rollback，并对 DROP/DELETE/TRUNCATE 给出 policy checks。 | OSS/Secure 分层；Secure 文档将扩展对象、rollback report 和 policy 作为高级能力。 | 证明长期价值来自变更历史、策略和可恢复性；SqlDiff 可先做确定性报告，不宜直接宣称完整 rollback。 |
| **Atlas** | `schema diff` 接受 DB URL/HCL/SQL/migration directory；支持 concurrent indexes、skip destructive、materialized view policy。Migration analyzers 覆盖 non-linear、destructive、data-dependent，并可接入 GitHub/GitLab CI。 | Starter 免费；Pro 从 `$9/开发者/月`，含 linting/governance/drift/audit；Pipelines 从 `$59/月/项目`；Schema Monitoring `$39/月/数据库`（访问日页面价格）。 | 这是“免费基础 diff + 付费 CI/治理/监控”的清晰商业先例；也提示 SqlDiff 未来收入可能来自工作流层而非基础算法。 |
| **Bytebase** | 生命周期包括 Plan、SQL Review、审批、Dev→Test→Staging→Prod rollout、监控和 rollback；SQL Review CI 支持 200+ 规则、命名/风险/兼容性检查，并把反馈发到 PR/MR。 | Community 免费；Pro `$20/用户/月`；Enterprise 定制，含 SSO、审计、审批、动态脱敏、外部 secret manager、air-gapped 等。 | 证明团队治理/审批/审计是强付费层；也说明直接做完整平台会引入身份、权限、服务运维和安全合规成本。 |
| **Prisma** | `migrate diff` 比较 schema、migration directory、config datasource 和空状态；可输出摘要或 SQL；`--exit-code` 以 2 表示检测到变化；不支持的 views/triggers 等不会显示。 | 开源 CLI/开发者生态入口，强调代码优先和 migration graph。 | 证明轻量 CLI gate 可成为开发者入口；也提醒 SqlDiff 若做 CLI 必须明确“不支持的 MySQL 对象”和退出码语义。 |
| **Percona Toolkit** | `pt-online-schema-change` 以副本表/分块复制降低锁，提供 load、replica lag、foreign key、replication filter 等保护；`pt-table-checksum` 在线检查复制一致性；`pt-table-sync` 修改数据并要求 dry-run/backup。 | 开源 CLI，能力按运维任务拆分，不以桌面 diff 为中心。 | 在线变更/一致性检查是生产安全的邻近能力；SqlDiff 可借鉴 preflight 维度，不宜直接执行迁移。 |
| **GitHub `gh-ost`** | triggerless online schema migration；支持 pause、动态控制、审计、replica test、noop、cut-over 控制和 checksum。 | GitHub 开源项目；README 建议先 replica/noop，再真实执行。 | 证明“先测试、再切换、可暂停/可审计”是高风险变更的核心期望；可转化为 SqlDiff 的审查清单。 |
| **Beekeeper Studio** | 功能矩阵覆盖 read-only mode、TLS/SSH、数据查看/编辑、schema table/key 管理；Cloud Workspace/Team Workspace 在付费层；未把 schema/data compare 作为其矩阵中的核心差异点。 | Community/Indie/Professional/Business 分层，协作与云工作区在高层。 | 说明通用数据库客户端的价值常在连接、数据浏览和协作；SqlDiff 不宜扩张成全能客户端。 |

### 3. 商业化信号（直接证据与不能推出的结论）

#### 直接证据（FACT）

- DBeaver 页面显示 Lite `$113/year`、Enterprise `$255/year`、Ultimate `$510/year`、Team `$1630/year`、CloudBeaver `$1025/year` 的年付展示（地区/时间可能影响实际价格）。
- Atlas 页面显示 Starter 免费、Pro 从 `$9/开发者/月`，Pipelines 从 `$59/月/项目`，Schema Monitoring 从 `$39/月/数据库`。
- Bytebase 页面显示 Community 免费、Pro `$20/用户/月`、Enterprise 定制。
- 这些价格页面把 schema compare、CI/CD、policy、drift、audit、approval、SSO/安全或 cloud/team 等能力分层呈现。

#### 不能推出的结论（INFERENCE / HYPOTHESIS）

- 价格不能证明某个 SqlDiff 候选方向有相同付费意愿；不同产品的购买者、部署形态和价值单位不同。
- “竞品有审批/审计”不等于目标用户愿意迁移到新桌面工具；也可能说明这类需求已被云平台吸收。
- 竞品功能存在只证明工作流被产品市场认可为一种任务，不证明 SqlDiff 用户的频率、痛点或留存。

### 4. SqlDiff 的相对位置（INFERENCE）

| 维度 | SqlDiff 当前事实 | 相对机会 | 风险 |
|---|---|---|---|
| 数据库范围 | MySQL-only | 可先做深 MySQL 迁移审查，而非泛化连接器 | 跨数据库需求可能被高估；MySQL 版本/变体也需覆盖。 |
| 交互 | 本地三栏、节点库、过滤、SQL 预览 | 适合人工快速审查和秘密本地化 | GUI 不适合无人值守/PR/CI。 |
| 输出 | `.sql`、剪贴板、风险/回滚提示 | 可增加 manifest/报告/基线，而不触碰执行 | 报告可能泄露 DDL/行值/拓扑。 |
| 安全 | 只读、safeStorage/AES-GCM、DBeaver 无秘密 | 可成为“可信本地审查”定位 | 自动执行/云协作会改变信任模型。 |
| 数据 | PK/UNIQUE、分页、阈值、DML | 可深化审计型数据 reconciliation | 全表内存、BLOB、列映射、在线变化仍是难点。 |
| 生态 | DBeaver topology-only；DataGrip 阻塞 | 连接配置迁移是低风险入口 | 便利功能不构成核心差异化，且格式会漂移。 |

### 5. 可观察的工具空白（INFERENCE，不是已验证需求）

1. **实时双库 + 本地安全 + 面向发布的可交接报告**：通用客户端和治理平台通常要么更偏数据库浏览，要么更偏云/CI；SqlDiff 可用小范围实验验证是否存在交叉需求。
2. **MySQL 生产 preflight，而不是 online migration executor**：把版本、表规模、主键/索引重建、空间、复制延迟和权限覆盖整理成只读检查，可能比执行迁移更符合当前信任边界。
3. **数据差异的“证据化”而非自动同步**：DBeaver/DataGrip 偏交互比较，Percona sync 偏运维执行；可验证用户是否需要选择、审计、恢复计划，而不是一键写库。
4. **可移植的本地项目/报告格式**：DBeaver/Flyway/Liquibase 都有任务/artifact/报告概念；SqlDiff 尚无稳定项目 manifest。是否值得做需用交接实验验证。
5. **轻量 CI gate**：Prisma/Atlas/Bytebase 证明代码审查入口存在；SqlDiff 可先提供只读 JSON/退出码，不能假设用户愿意把行数据送入 CI。

### 6. 不应追逐的方向

- **自动执行所有生成 SQL**：直接违背当前只读信任边界，且竞争者已有更成熟的执行/回滚平台。
- **立即做多数据库平台**：方言、权限、对象和数据类型差异会把一个可交付的 MySQL 工具变成多个半成品。
- **把 DataGrip/DBeaver 转换器当核心增长方向**：它们解决进入其他工具的便利性，不能替代迁移审查价值。
- **用 AI 生成“更安全的 SQL”**：在没有可验证引用、版本信息和回滚证据前，正确性与数据隐私风险都高。

## External References

- [DBeaver Schema Compare](https://dbeaver.com/docs/dbeaver/Schema-compare/)
- [DBeaver Data Compare](https://dbeaver.com/docs/dbeaver/Data-compare/)
- [DBeaver editions and pricing](https://dbeaver.com/edition)
- [DataGrip schema comparison and migration](https://www.jetbrains.com/help/datagrip/schema-comparison-and-migration.html)
- [DataGrip compare data](https://www.jetbrains.com/help/datagrip/compare-data.html)
- [MySQL Workbench schema synchronization](https://dev.mysql.com/doc/workbench/en/wb-design-schema.html)
- [MySQL Workbench migration overview](https://dev.mysql.com/doc/workbench/en/wb-migration-overview-steps.html)
- [Flyway database comparisons](https://documentation.red-gate.com/flyway/flyway-concepts/database-comparisons)
- [Flyway compare two databases](https://documentation.red-gate.com/fd/compare-two-databases-253394964.html)
- [Liquibase diff](https://docs.liquibase.com/secure/reference-guide-5-1-1/database-inspection-change-tracking-and-utility-commands/diff)
- [Liquibase rollback](https://docs.liquibase.com/secure/reference-guide-5-1/init-update-and-rollback-commands/rollback)
- [Atlas schema diff](https://atlasgo.io/declarative/diff)
- [Atlas migration analyzers](https://atlasgo.io/lint/analyzers)
- [Atlas pricing](https://www.atlasgo.io/pricing)
- [Bytebase SQL Review CI](https://docs.bytebase.com/gitops/migration-based-workflow/sql-review-ci)
- [Bytebase change workflow](https://docs.bytebase.com/change-database/change-workflow)
- [Bytebase pricing](https://www.bytebase.com/pricing.md)
- [Prisma migrate diff](https://www.prisma.io/docs/cli/migrate/diff)
- [Percona Toolkit](https://docs.percona.com/percona-toolkit/pt-online-schema-change.html)
- [GitHub gh-ost](https://github.com/github/gh-ost)
- [Beekeeper feature comparison](https://docs.beekeeperstudio.io/includes/feature_comparison)

## Caveats / Not Found

- 价格和 edition 信息是 2026-09-24 访问时的页面快照，不用于收入预测。
- 没有找到 SqlDiff 的下载量、用户访谈、竞品转化率或真实目标用户样本；因此“工具空白”仍需验证。
- 部分产品文档受 edition/region/登录状态影响；引用应以官方页面当前版本为准。
- 本研究没有下载、安装或执行外部数据库工具，只读取其官方功能/定价资料。
