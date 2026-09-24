# Research: 用户需求、痛点与优先级信号

- **Query**: 判断 MySQL schema/data diff、迁移审查、数据库工具和数据恢复工作流中的真实需求信号、未满足痛点、付费/优先级线索，并严格区分事实与假设。
- **Scope**: mixed（仓库证据、官方竞品工作流/定价、已有任务材料）
- **Date**: 2026-09-24
- **证据标记**: `FACT` = 直接观察；`INFERENCE` = 基于事实的推导；`HYPOTHESIS` = 需要访谈/行为数据/付费实验验证。

## Findings

### 1. 证据强弱与研究结论

#### 已证实的任务事实（FACT）

- SqlDiff 当前的核心闭环是“节点 → A/B → 只读比较 → 风险/回滚提示 → SQL 复制/导出”，而不是执行、审批或持续治理。证据：`apps/desktop/README.md:1-18`、`apps/desktop/src-main/compare-run.ts:53-141`、`apps/desktop/src-core/risk.ts:37-116`。
- 数据比较已支持表映射、PK/UNIQUE 身份、阈值、分页、进度和取消，但无身份表只能给行数/跳过，且大表结果仍会 materialize 到本地内存。证据：`apps/desktop/src-main/data-run.ts:121-166,180-248`、`apps/desktop/src-main/data-fetch.ts:105-134`。
- 历史只保存最近 20 条摘要，不能恢复完整结果、策略、审批或输入版本。证据：`apps/desktop/src-core/types.ts:118-128`、`apps/desktop/src-main/store-json.ts:98-115`。
- MySQL Workbench、DBeaver、DataGrip、Flyway、Liquibase、Atlas、Prisma 和 Bytebase 都把比较嵌入更大的迁移/开发/治理工作流，而不是只提供孤立 diff。来源见 [`adjacent-product-landscape.md`](adjacent-product-landscape.md) 和 [`mysql-schema-data-diff-workflows.md`](mysql-schema-data-diff-workflows.md)。

#### 没有找到的第一方证据（NOT FOUND）

- 没有用户访谈、问卷、可用性测试、Issue/Support 统计、下载/活跃/留存、任务频率日志、付费转化或流失原因。
- 没有证据证明某类用户每周需要多少次对比、哪一步最耗时、是否愿意把结果交给同事、是否愿意付费。
- 因此以下内容都是 **HYPOTHESIS**，即使竞品功能/价格很强，也不能写成“用户一定需要”。

### 2. 需求假设登记表

| ID | 目标用户与问题 | 价值假设 | 当前证据 | 证据强度（非需求概率） | 最小验证问题 |
|---|---|---|---|---|---|
| H1 迁移审查工作台 | 发布/测试人员、技术负责人、DBA：对比结果难形成可交接的变更证据 | 若能保存 scope/输入摘要/差异/风险/回滚提示并导出报告，用户会更愿意在发布前使用 SqlDiff | 当前 `HistoryEntry` 只有摘要；DBeaver/Flyway/Bytebase 都有报告、任务、artifact 或审批层；SqlDiff 有现成 DiffItem/risk/export 可复用 | 中低 | 找 5–8 名真实发布/DBA 用户完成一次脱敏审查；观察是否主动导出、修改、转发或提交报告 |
| H2 生产变更 preflight | DBA/后端负责人：知道有 ALTER，但不知道当前版本、表规模、锁/重建和复制影响 | 只读 preflight 比自动迁移更快、更可信，能减少上线前人工查资料 | MySQL Online DDL 矩阵、Percona、gh-ost 直接覆盖算法/锁/空间/复制/测试；当前风险规则只有 SQL 关键字 | 中 | 用一个生产规模脱敏 fixture，让用户判断“哪些检查改变了决策”；若只关心生成 SQL，停止扩展 |
| H3 可审计数据 reconciliation | 数据工程师/DBA：两库行不一致，需要选择、解释和恢复 | 选择性同步计划、覆盖率、失败原因和恢复证据比“一键同步”更符合信任边界 | DBeaver 有列/键映射、限制和导出；SqlDiff 已有 DML/逐表状态但无报告/选择性回滚 | 中低 | 提供脱敏两表让用户选择 INSERT/DELETE/UPDATE、导出计划并模拟恢复；观察他们是否需要执行按钮还是证据包 |
| H4 基线与漂移巡检 | 平台/DBA：环境多次发布后不知道相对“上次确认状态”的变化 | 版本化基线能发现未授权/遗漏变更，且比每次临时比较更可追踪 | Flyway snapshot/diff/validate、Liquibase drift、Atlas monitoring/drift 都有直接产品证据；SqlDiff 尚无 snapshot/project | 低中 | 记录用户是否会在同一天/同一项目重复比较；给一个“保存基线→重跑→只看新增漂移”原型，测试连续两次使用率 |
| H5 CI/PR 只读入口 | 开发/平台工程师：桌面 GUI 难以进入代码评审和流水线 | JSON/退出码/可选报告能复用现有 diff 核心，而不要求 GUI | Prisma `--exit-code`、Atlas CI、Bytebase SQL Review CI、Flyway pipeline 都证明入口形态存在；仓库没有 CI runner | 低中 | 让 2–3 个团队用本地脚本/CI 试跑一次；成功标准应包括凭据不落盘、差异可读、退出码稳定 |
| H6 连接配置迁移 | 已经在 DBeaver/DataGrip 工作的人：想快速把连接拓扑带入 SqlDiff | 兼容导入能降低切换成本，尤其 SSH/多环境节点 | DBeaver topology-only 已实现；DataGrip 任务明确阻塞在真实 fixture | 中（便利性） | 统计现有用户是否有转换需求；没有重复使用就不应扩展成双向同步 |
| H7 多数据库方言 | PG/SQL Server/Oracle 用户：MySQL-only 阻塞工作流 | 若目标场景足够集中，adapter 可降低阻塞 | Atlas/Liquibase/Workbench 等支持多数据库，但这是竞品能力，不是 SqlDiff 用户证据 | 低 | 先收集具体数据库、版本、对象、迁移频率和现有替代工具；出现重复场景才设计 dialect contract |
| H8 团队协作/审批 | 多人发布：评论、审批、权限、审计 | 共享项目和审批可减少发布风险 | Bytebase/Liquibase/Atlas 商业层提供直接信号；当前本地 Vault/JSON 无身份和服务边界 | 低 | 只有在 H1 报告确实被多人交接后才测试；不要先建云权限系统 |
| H9 AI 解释/修复建议 | 不熟悉 SQL 或需要快速理解差异的人 | 基于本地差异证据的解释可能降低学习成本 | 竞品已加入 AI 入口；当前无用户证据，且涉及 DDL/行值隐私和幻觉 | 低 | 先收集“看不懂哪一段”的具体样本；仅允许引用本地 diff、默认不自动改写/执行 |

### 3. 痛点地图：事实、推断、未知

| 痛点 | 证据状态 | 当前产品反应 | 仍需知道 |
|---|---|---|---|
| 差异“看起来有”但不敢执行 | **INFERENCE**：Workbench/DBeaver/DataGrip/Flyway/Atlas/Bytebase 都把警告、风险、策略或脚本审查放在 diff 周边；SqlDiff 也有风险提示 | 风险说明、回滚占位、DROP 二次确认 | 用户最常问的是风险、兼容性、回滚还是审批？ |
| 大表/生产变更影响未知 | **FACT（外部能力）/HYPOTHESIS（SqlDiff 用户痛点）**：MySQL 矩阵和在线工具提供复杂约束 | 阈值、进度、取消；没有锁/空间/复制 preflight | 用户是否有生产表规模、版本和副本信息可供只读检查？ |
| 无主键/列名不同导致数据结论不可信 | **FACT**：SqlDiff 明确跳过无身份表；DBeaver 要求 key columns | `no-pk`、`pk-mismatch`、行数替代 | 无 PK 表在目标用户中占比多少？是否接受 hash/人工映射？ |
| 结果难交接、难复现 | **FACT（当前模型）**：历史只有摘要；**INFERENCE（工作流）**：竞品普遍有任务/artifact/report | 目前只有 SQL/节点导出 | 用户是把结果贴到 PR、工单、聊天还是只本地看？ |
| 环境漂移没人发现 | **FACT（竞品）**：Liquibase/Atlas/Flyway 提供 drift/monitoring；**HYPOTHESIS（SqlDiff）** | 当前无 baseline/scheduler/notification | 用户是否需要在无操作时发现漂移，还是只在发布前比较？ |
| 桌面 GUI 不能进 CI | **FACT（竞品）+HYPOTHESIS（用户）**：Prisma/Atlas/Bytebase/Flyway 都有 CLI/CI | 无 headless runner | 目标用户是否愿意维护第二套配置和 secret provider？ |
| 连接配置重复录入 | **FACT（当前能力）**：DBeaver exporter 已有；DataGrip fixture 阻塞 | topology-only、秘密不迁移 | 这是高频任务还是一次性迁移便利？ |

### 4. 优先级信号（不是需求证明）

| 信号 | 直接证据 | 可支持的判断 | 不能支持的判断 |
|---|---|---|---|
| 风险/回滚/策略被多层产品拆成高级能力 | DBeaver schema compare 警告不可自动撤销；Flyway warnings；Atlas destructive/data-dependent analyzer；Bytebase SQL Review/approval | “安全审查”比基础 diff 更可能形成产品层价值 | 不能证明 SqlDiff 用户愿意购买这些功能 |
| CI/监控/审计有独立价格或套餐 | Atlas Pro/Pipelines/Monitoring、Bytebase Pro、DBeaver Team/Enterprise、Flyway Teams | 自动化、治理、协作是可行商业模式 | 不能把竞品价格映射成 SqlDiff 收入预测 |
| 用户在生产场景面对算法/复制/空间约束 | MySQL Online DDL、Percona、gh-ost 官方文档 | preflight 的检查项有可解释来源 | 不能证明用户愿意提供权限/副本连接 |
| 当前实现已投入数据对比和风险规则 | `data-run.ts`、`risk.ts`、UI 数据映射/阈值 | 这些是产品团队已识别的邻近任务 | 不能证明它们是最高频或最高价值任务 |
| 现有 DBeaver 导出已完成、DataGrip 阻塞 | 内部任务与 converter 源码 | 生态兼容可作为低风险小步 | 不能证明兼容性是长期核心 |

### 5. 建议的用户研究问题（按优先级）

#### A. 先验证 H1/H2（推荐近期）

1. 过去 30 天最后一次数据库变更由谁发现、谁批准、谁执行？比较了哪些环境？
2. 从发现差异到执行，最耗时的三步是什么？是 SQL 正确性、风险、锁/复制、回滚还是沟通？
3. 用户如何保存和传递这次变更证据？是否需要脱敏、评论、审批、PR 链接？
4. 生产表多大、MySQL 版本是什么、是否有副本/监控权限？愿意让工具只读哪些信息？
5. 如果只能选择一个能力：报告、preflight、CI gate、数据恢复计划，哪个会改变实际发布行为？

#### B. 验证 H3/H4/H5

- 是否经常比较同一对环境？多久一次？是否需要“上次确认”作为基线？
- 数据不一致时，用户想看 SQL、统计、列级差异、覆盖率，还是可恢复的选择清单？
- CI 中能否接受只输出结构差异？行数据是否永远不能进入 CI？退出码如何定义？
- 用户现有工具（DBeaver/DataGrip/Workbench/Flyway/Liquibase/Atlas/自研脚本）承担哪一步，SqlDiff 要补哪一步？

#### C. 验证生态与跨边界

- DBeaver/DataGrip 导入是一次性迁移还是会反复发生？
- 非 MySQL 需求是硬阻塞还是“有替代工具即可”？需要哪些对象/版本？
- 用户能否接受本地 JSON/Markdown 报告，还是必须写入现有工单/PR 系统？

### 6. 最小研究设计

| 实验 | 样本/材料 | 行为任务 | 成功判据（需预先约定） | 失败/停止判据 |
|---|---|---|---|---|
| 迁移审查原型的情境访谈 | 5–8 人：发布/测试、DBA、后端各至少一组；使用脱敏项目 | 完成“保存基线/审查/导出交接包” | 至少 60% 且不少于 4 人能在无培训下完成，并说明会把产物交给谁/放在哪 | 多数人只要临时 SQL，或无法接受报告中的信息范围 |
| 生产 preflight 纸面/原型 | 一个大表、一个副本延迟和权限不足 fixture | 判断是否可上线、找出需要人工确认的项 | 用户能区分“阻断/警告/未知”，且至少一项检查改变决策 | 只需 SQL 文本，或所有环境信息都无法获得 |
| CI gate 脚本试用 | 2–3 个有 CI 的小团队；只读 fixture | 在 PR 中输出 JSON/SQL/退出码 | 能复现一次比较，凭据不落盘，团队愿意保留入口 | 无稳定凭据注入、输出难读或频率不足以维护 |
| 数据 reconciliation 任务 | 2–3 个脱敏表：PK、复合 PK、UNIQUE、无 PK、BLOB | 选择差异、解释跳过原因、导出恢复计划 | 用户能说出为何某行/表不在计划中 | 用户强烈要求自动执行且无法接受人工审查；转交专门数据同步产品 |
| 性能/资源基准 | 10k/100k/1m 行，宽表/BLOB，至少 100/500 表结构 fixture（规模按实验前定义） | 记录耗时、峰值内存、取消恢复和结果大小 | 达到预设的交互/资源门槛且结果可解释 | 只能靠显著降低范围或改用流式架构；不直接承诺产品支持 |

### 7. 事件/日志研究建议（不记录秘密）

若要做 opt-in 本地使用分析，只记录最小事件并默认本地保存/可关闭：`compare_started`（scope/对象数/是否有 data）、`compare_completed`（耗时/差异统计/跳过原因）、`export/copy`（类型，不记录 SQL/行值）、`preflight_warning`（规则 ID，不记录秘密）、`connection_error`（阶段/错误码，不记录 host/password）。任何包含 DDL、DML 行值、节点拓扑或私钥的日志都不应默认上传。

## Related Specs

- `.trellis/tasks/09-24-product-expansion-roadmap/prd.md:17-31,34-76` — 研究范围、禁止无证据结论、评价维度和开放问题。
- [`repository-evidence.md`](repository-evidence.md) — 当前实现事实和边界。
- [`mysql-schema-data-diff-workflows.md`](mysql-schema-data-diff-workflows.md) — 官方工作流与 MySQL 安全事实。
- [`adjacent-product-landscape.md`](adjacent-product-landscape.md) — 竞品功能、定价和商业信号。
- `.trellis/spec/backend/database-guidelines.md` — 数据读取、只读和秘密边界。

## Caveats / Not Found

- 本文没有把竞品功能直接当作用户需求；所有“优先级”都必须通过 H1–H9 的实验重新检验。
- 没有用户样本、统计显著性或付费实验，因此不应据此做市场规模、收入或留存预测。
- 任务目录由用户明确指定；`task.py current --source` 在本会话返回 `(none)`，不改变本文件归属。
- 研究阶段只写研究文件，没有改产品代码、PRD 或任务配置；本次 Check Agent 仅修正当前任务文档，未修改产品代码或任务配置。
