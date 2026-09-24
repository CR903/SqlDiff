# Research: 候选扩展方向与验证计划

- **Query**: 将仓库能力、MySQL 迁移工作流、竞品格局和需求假设转化为可排序、可在 1–2 个小任务内验证的候选方向。
- **Scope**: mixed（内部基线 + 官方工作流/竞品证据）
- **Date**: 2026-09-24
- **证据标记**: `FACT` / `INFERENCE` / `HYPOTHESIS` 同 [`README.md`](README.md)。分数是技术与战略决策辅助，不是用户需求或收入预测。

## Findings

### 1. 排序方法

沿用 [`scorecard.md`](scorecard.md) 的权重：

- 问题严重性/频率：25%
- 与现有安全本地 diff 的战略契合：20%
- 复用/技术可行性：20%
- 差异化：15%
- 验证速度：10%
- 风险/安全逆向分：10%（5 = 低风险且有明确护栏）

评分为 **1–5 的假设分**。即使加权分高，只要没有用户/行为证据，仍标为 `HYPOTHESIS`，不能直接承诺开发。加权公式为 `0.25×严重性 + 0.20×契合 + 0.20×复用 + 0.15×差异化 + 0.10×验证速度 + 0.10×风险逆向`；“依据”列把直接事实和仍待验证的价值假设分开。分数相同按安全边界和验证门槛排序，不表示用户需求概率。

| ID | 候选方向 | 严重性 | 契合 | 复用 | 差异化 | 验证速度 | 风险逆向 | 加权分 | 依据（事实/假设） | 决策 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| A | MySQL 迁移审查工作台 + 可交接报告 | 4 | 5 | 5 | 4 | 5 | 4 | **4.50** | FACT：`HistoryEntry` 仅摘要，`DiffItem`/risk/export 可复用；HYPOTHESIS：交接价值和频率 | 近期推荐，先验证 |
| B | 本地基线、项目文件与环境漂移巡检 | 4 | 5 | 4 | 4 | 4 | 4 | **4.20** | FACT：外部工具存在 snapshot/drift 工作流；HYPOTHESIS：用户会重复比较并需要基线 | 方向 A 的一部分；先验证连续使用 |
| C | 大表/生产变更只读 preflight | 5 | 4 | 4 | 5 | 3 | 3 | **4.20** | FACT：Online DDL/Percona 提供检查维度，当前风险主要是关键字；HYPOTHESIS：生产阻塞足以改变决策 | A 的第二切片或备选重点 |
| D | Headless CLI / 项目文件 / CI 只读 gate | 4 | 4 | 4 | 4 | 5 | 3 | **4.00** | FACT：core 可复用但无 CLI/secret provider；HYPOTHESIS：团队会采用只读 CI 入口 | 中期高价值假设；需先有报告/manifest |
| E | 可审计的数据 reconciliation 与恢复计划 | 4 | 4 | 4 | 3 | 3 | 3 | **3.65** | FACT：PK/UNIQUE、DML、逐表状态可复用；HYPOTHESIS：选择性恢复和覆盖率报告有价值 | 条件推进，先做数据证据实验 |
| F | DBeaver/DataGrip 连接生态转换 | 2 | 3 | 4 | 2 | 5 | 4 | **3.10** | FACT：DBeaver topology-only 已实现，DataGrip fixture 阻塞；HYPOTHESIS：转换便利会重复发生 | 低风险便利功能；DataGrip 受 fixture 阻塞 |
| G | 团队协作、评论、审批、审计 | 5 | 2 | 2 | 4 | 2 | 1 | **2.95** | FACT：无身份、服务端权限或审计事件；HYPOTHESIS：静态报告交接后仍需要责任链 | 条件触发；不是当前桌面 MVP |
| I | 在线迁移/自动执行与 cut-over | 5 | 2 | 2 | 4 | 2 | 1 | **2.95** | FACT：自动执行违反当前只读边界；HYPOTHESIS：外部执行需求存在，但不纳入本产品 | 明确不做；不进入路线 |
| J | AI 差异解释/修复建议 | 3 | 2 | 3 | 4 | 3 | 1 | **2.75** | FACT：当前只有本地规则、无 AI；HYPOTHESIS：用户确有看不懂差异的样本 | 延后；先收集可解释性问题 |
| H | 多数据库方言（PG/SQL Server/Oracle 等） | 4 | 2 | 2 | 3 | 2 | 2 | **2.65** | FACT：MySQL 语义贯穿多层；HYPOTHESIS：非 MySQL 是重复且高价值的阻塞 | 延后；先取得重复场景 |

> 注：B 与 C 均为 4.20，表中先后只是便于阅读的验证顺序，不是价值差异；G 与 I 均为 2.95，但 I 触碰不可绕过的只读安全边界，因此即使问题严重性高也不进入近期路线；J（2.75）排在 H（2.65）之前。技术承载力的另一套评分见 [`technical-scalability.md`](technical-scalability.md)，不可与本表的验证优先级混用。

### 2. 推荐重点：安全迁移审查工作台（A）

#### 目标用户与问题（HYPOTHESIS）

- 发布/测试人员：需要确认两个环境是否一致，并把证据交给开发或审批人。
- 技术负责人/DBA：需要快速识别高危变更、权限盲区和不可自动恢复的操作。
- 独立开发者：需要一份可保存的 preflight 记录，而不是每次重新连库。

#### 价值假设

一次比较的结果应成为**可重放、可交接、可追责的审查记录**，而不只是临时 SQL。最小价值闭环是：

1. 保存输入元数据与 scope/options；
2. 保存差异项、覆盖状态、风险规则结果；
3. 导出脱敏 Markdown/JSON；
4. 允许用户在报告中标记“接受/排除/待确认”，但不执行 SQL。

#### 可复用点（FACT）

- `DiffItem`、`CompareStats`、风险/回滚字段：`apps/desktop/src-core/types.ts:87-104,186-207`。
- 已有结构/数据结果组装、过滤和 SQL 导出：`apps/desktop/src-core/compare.ts:104-173`、`apps/desktop/src-renderer/App.tsx:880-975`。
- 现有历史可作为入口，但必须升级为版本化 manifest，而不是继续把摘要当结果：`apps/desktop/src-core/types.ts:118-128`。

#### 成本与风险（INFERENCE）

- 需要新的 project/report schema、结果指纹、规则版本、导出隐私策略和迁移兼容策略。
- 报告可能包含表/列名、DDL、行值或节点别名；必须允许用户在导出前做拓扑/行值脱敏。
- “审批”若只存在本地 JSON，不能声称具备团队审计或权限控制；第一版应称“审查记录/签核备注”。
- 继续保持“只读生成”，避免把报告入口变成执行入口。

#### 最小实验

- 用一个脱敏 MySQL fixture 做“保存基线 → 再比较 → 导出 Markdown/JSON”原型。
- 给 5–8 名发布/测试/DBA 用户同一任务，不提供培训，观察他们是否完成闭环。
- 记录最常问的是 SQL、风险、回滚、覆盖率还是审批；不记录秘密或真实行值。

#### 预先约定的判据

- **通过**：在 5–8 人样本中，至少 60% 且不少于 4 人无需培训完成，并将产物放入真实交接路径；用户能解释报告中的 `unknown/skipped`。
- **失败/停止**：用户只要一次性 SQL、拒绝保存任何 schema/行信息，或没有人愿意接收产物；回到临时查询/过滤优化。

### 3. 方向 B：基线、项目文件与环境漂移

#### 目标用户与价值假设（HYPOTHESIS）

- 同一项目/环境会被反复比较的 DBA、测试和发布人员。
- “A 是本次期望状态、B 是当前环境”与“基线是上次批准状态、当前库是目标”可能不是同一语义，产品必须让用户明确选择。

#### 直接证据与推断

- Flyway snapshot/diff/validate、Liquibase drift、Atlas monitoring 证明基线/漂移是独立工作流（外部 `FACT`）。
- 当前 `HistoryEntry` 只有摘要，无法重放结果（内部 `FACT`）。
- 因而“基线/漂移”是合理相邻方向，但不是已证实的高频需求。

#### 最小切片

- 项目 manifest：节点别名/数据库名（可选脱敏）、scope、映射、选项、规则版本、输入 fingerprint、上次结果摘要。
- 比较模式明确区分 `live-vs-live`、`baseline-vs-live`；不把 baseline 悄悄当第二个实时库。
- 首版只读本地文件，不做后台调度、云同步或多用户锁。

#### 验证

连续两次使用同一 fixture：第一次保存基线，第二次只查看新增/消失/改变的对象。成功条件是用户能在第二次比较中准确解释“相对上次的变化”；若用户仍总是临时选两个库且不保存，暂缓。

### 4. 方向 C：大表/生产变更只读 preflight

#### 目标用户与价值假设（HYPOTHESIS）

DBA/后端负责人希望在把 SQL 交给发布流程前知道：当前表规模、DDL 是否可能重建/锁表、是否需要额外空间、复制是否延迟、对象是否因权限不可读。

#### 外部事实

- MySQL 8.4 Online DDL 明确区分 instant/in-place/copy、是否重建表、是否允许并发 DML；不同主键/索引操作差异很大。
- Percona/gh-ost 把副本测试、分块复制、replica lag、load、cut-over、审计和暂停作为生产变更控制。
- 详见 [`mysql-schema-data-diff-workflows.md`](mysql-schema-data-diff-workflows.md)。

#### 最小切片

只读检查并输出“事实/推断/未知”：

- MySQL 版本与 `sql_mode`/关键 metadata；
- 表行数（`COUNT(*)` 与估算值分开）、平均行宽、表/索引空间估计；
- DDL 操作对应的 online algorithm/lock 候选与版本限制；
- 主键/索引/外键/触发器/复制状态（只在权限和网络允许时）；
- 高危规则、人工确认项和证据时间。

不自动调用 `pt-online-schema-change`/`gh-ost`，不自动生成 cut-over 命令，不自动执行。

#### 风险

- 预检本身可能需要高权限或增加数据库查询负担。
- 版本/引擎/云变体会改变结论；未知必须显式显示，不能用默认值伪装确定。
- 空间和复制指标可能包含敏感拓扑；报告默认只保存结论和证据摘要。

#### 验证

使用脱敏生产规模 fixture 和一个权限不足/副本延迟场景；让用户判断“可发布/需确认/不可发布”。如果用户不能提供任何版本、规模或副本信息，或判断结果不影响实际流程，则不扩展。

### 5. 方向 D：Headless CLI / 项目文件 / CI gate

#### 目标用户与价值假设（HYPOTHESIS）

开发/平台工程师希望在 PR 或 CI 中得到稳定的结构 diff，而不是打开桌面 GUI；他们可能只需要结构差异、退出码和报告，不需要把行值送入 CI。

#### 外部与内部证据

- Prisma 提供 `migrate diff --exit-code`，Atlas/Flyway/Bytebase 提供 CI/validation/review 入口。
- 当前 `src-core` 有可复用的纯比较函数，但 `compare-run` 依赖 Electron 文件目录、Vault、连接实现和 renderer demo fallback；这是技术 `FACT`，不是现成 CLI 能力。

#### 最小切片

1. 只读 headless runner，接收项目文件和环境变量中的 secret reference；不从命令行参数明文传密码。
2. 输出稳定 JSON/Markdown 与退出码：成功无差异、发现差异、输入/权限错误需明确区分。
3. 默认只支持 schema diff；数据 diff 需显式开关和范围/脱敏策略。
4. 与 Electron 共用 core，不复制一套 diff 语义。

#### 风险与门槛

- 凭据注入、CI 日志泄漏、跨平台路径、长任务取消/超时和 artifact 体积。
- 在 H1 报告/manifest 未验证前，CLI 可能只是把同一不确定性搬到命令行；先做 H1 或同步做极薄脚本试用。

### 6. 方向 E：可审计数据 reconciliation

#### 目标用户与价值假设（HYPOTHESIS）

数据工程师/DBA 需要知道每张表是否完整对比、哪些行被判定为 INSERT/DELETE/UPDATE、为什么某表被跳过，以及如何选择性地恢复；不一定是自动同步。

#### 可复用与缺口

- 可复用 PK/UNIQUE、分页、阈值、逐表状态、DML 生成和过滤。
- 需要补 column mapping、覆盖率报告、差异抽样/哈希、选择性计划、二进制/时区/字符集策略、恢复前检查。
- DBeaver 的 key/column mapping 和 SQL/HTML/Daff 导出是相邻参照；Percona `pt-table-sync` 明确是会改数据的工具，不能直接嵌入当前只读产品。

#### 最小实验

提供脱敏 PK、复合 PK、UNIQUE、无 PK、BLOB 五类 fixture，让用户选择差异、解释跳过原因、导出“计划”但不执行。成功条件是用户能在没有猜测的情况下写出可复核的恢复计划；若用户只接受一键执行，应转介专门同步工具并暂缓该方向。

### 7. 方向 F：DBeaver/DataGrip 生态转换

- **现状（FACT）**：DBeaver topology-only 已实现且不迁移秘密；DataGrip 任务明确等待真实脱敏 XML/SSH fixture。
- **价值假设**：它降低工具切换成本，但不解决迁移审查本身。
- **建议**：保留 DBeaver 为低风险便利性；DataGrip 先完成 fixture/版本验收，不扩展双向同步或秘密迁移。
- **验证**：统计一次导出后是否实际在目标工具中使用；若没有重复任务，标记为维护项而非增长方向。

### 8. 方向 G：团队协作、评论、审批与审计

- **价值假设**：多人发布需要共享项目、评论、审批、权限和审计。
- **直接外部信号**：Bytebase、DBeaver Team、Atlas audit/SSO、Flyway Teams/Liquibase Secure 均有治理/协作层。
- **内部障碍（FACT）**：当前是 Electron 本地 Vault + JSON，无身份、服务端权限、共享存储、审计事件和密钥托管。
- **决策**：只有 H1 报告被真实交接、H5 CI gate 被重复使用后才验证；第一阶段不建云权限系统，不把本地备注称为合规审计。

### 9. 方向 H：多数据库方言

- **价值假设**：非 MySQL 是硬阻塞。
- **直接事实**：当前 `DatabaseMetadata`、DDL parser、literal renderer、metadata query 和 formatter 都是 MySQL 语义；增加 PG/SQL Server/Oracle 需要 adapter、权限和 fixture 体系。
- **决策**：先收集目标数据库、版本、对象类型、迁移频率和现有替代工具；至少一个明确且重复的场景出现后才设计 `DialectAdapter`，不把 adapter 当作近期 MVP。

### 10. 方向 I：在线迁移/自动执行（明确非推荐）

虽然严重性高且竞品有成熟能力，但自动执行会改变“只读、手工执行、秘密本地”的核心信任边界，并引入 cut-over、复制、锁、回滚和责任归属。SqlDiff 可以输出 preflight/审查报告和交给外部工具的 SQL，但不执行、不托管、不承诺自动恢复。来源：Percona/gh-ost 文档；内部 `src-core/data-diff.ts:1-4` 和任务 PRD `:63-68`。

### 11. 方向 J：AI 差异解释/修复建议（延后）

AI 可能有价值，但当前没有“用户看不懂哪类差异”的第一方样本。最小安全边界应是本地/脱敏上下文、引用原始 `DiffItem`、只解释不自动改写；不得默认上传行值、DDL 或凭据，也不应让模型决定执行。竞品 AI 入口是产品存在信号，不是 SqlDiff 的需求证明。

### 12. 分阶段路线图（INFERENCE，不是承诺）

#### Phase 0：证据与可信度门槛

- 完成 5–8 个目标用户的迁移审查/生产 preflight 访谈与可用性实验。
- 建立脱敏 MySQL fixture：表/视图/过程/函数、PK/复合 PK/UNIQUE/无 PK、BLOB、权限不足、大表/阈值、并发写入。
- 处理现有阻塞：DataGrip 真实 fixture；Windows 原生、SSH 私钥/跳板、目标内网；签名/公证/自动更新是否进入发布范围。
- 明确 demo fallback 不能进入 headless/CI 结果；不记录秘密和原始行值。

#### Phase 1：推荐重点——安全迁移审查最小闭环

- 版本化本地 project/manifest（不含秘密）。
- 覆盖状态：成功、权限失败、无行身份、超阈、取消/错误。
- 可配置但确定性的风险规则；导出 Markdown/JSON 审查报告。
- 支持“接受/排除/待确认”的人工备注，但不执行 SQL。
- 以 H1 实验结果决定是否加入 baseline 入口；不要同时铺开团队协作。

#### Phase 2：选择一个相邻重点（由 Phase 1 证据触发）

- 若用户最关心生产上线风险：做只读 preflight v1。
- 若用户最关心 PR/CI：做 headless JSON/退出码 gate v1。
- 若用户最关心数据恢复：做数据 reconciliation 报告/选择性计划 v1。
- 三者不应在同一 MVP 中同时实现。

#### Phase 3：条件触发

- 基线/漂移的连续使用成立后，加入本地 project history 和 drift report。
- H1 交接和 H5 CI 成立后，才评估团队协作/审计。
- 目标数据库场景重复出现后，才投入多数据库 adapter。
- DataGrip/DBeaver 仅按真实格式和重复使用信号维护。

#### 明确暂缓

- 自动执行/在线 cut-over、云端多租户、完整权限平台、默认 AI 生成修复、立即跨六种数据库、Tauri 重写。

### 13. 验证总表

| 优先级 | 实验 | 最小产物 | 成功判据（需在实验前登记） | 失败后的动作 |
|---|---|---|---|---|
| P0 | 迁移审查情境测试 | 脱敏 report prototype | 5–8 人中至少 60% 且不少于 4 人完成并愿意交接 | 停止报告扩展，回到 diff 体验/数据问题 |
| P0 | preflight 判断任务 | 版本/规模/锁/复制/权限检查纸面或原型 | 至少一项未知/警告改变发布决定 | 只保留基础风险提示 |
| P1 | CI gate 试用 | 只读 runner + JSON + exit code | 2–3 个团队可复现且不泄漏 secret | 不建设 CI 产品，转为内部脚本 |
| P1 | 数据 reconciliation 任务 | 选择/覆盖率/恢复计划报告 | 用户能解释每张表/每行为何进入计划 | 保留现有 DML 导出，暂不自动同步 |
| P1 | 基线连续使用 | 两次比较 fixture | 第二次能快速定位新增漂移 | 只保留 live-vs-live |
| P2 | 性能基准 | 10k/100k/1m 行及宽表/BLOB 报告 | 预先定义的耗时/内存/取消门槛达标 | 采用采样、流式或降低范围，不隐瞒限制 |
| P2 | 生态转换 | DBeaver/DataGrip 真实导入记录 | 目标版本可重复导入且秘密边界清楚 | 延后/维护现有 DBeaver |

### 14. 方向覆盖矩阵（AC2 检查）

下表把每个方向的目标用户/问题、价值假设、复用点、成本、风险和最小验证集中列出；它是研究决策索引，不是实现承诺。详细证据见各方向小节和 [`scorecard.md`](scorecard.md)。

| ID | 目标用户 / 问题 | 价值假设 | 可复用点 | 相对成本 | 主要风险 | 最小验证 |
|---|---|---|---|---|---|---|
| A | 发布/测试/DBA；结果难保存、复比和交接 | 可重放的审查记录会进入真实交接流程 | `DiffItem`、risk/rollback、SQL export、history | M | DDL/行值泄露、快照陈旧、被误当执行证明 | 5–8 人完成保存→复比→交接 |
| B | 重复比较同一项目的 DBA/测试/发布人员 | baseline/drift 比每次临时选库更有用 | compare core、history、过滤 | M | live-vs-live 语义混淆、陈旧快照 | 同一 fixture 连续两次使用 |
| C | DBA/后端；生产 ALTER 的锁/重建/空间/复制影响未知 | 只读 preflight 能改变上线判断 | metadata、连接、风险提示、进度 | M–L | 权限/查询负担、版本差异、未知被误判 | 生产规模 fixture 的可发布/阻断判断 |
| D | 开发/平台；GUI 难以进入 PR/CI | JSON、退出码和报告能复用 core | pure core、compare/data orchestration | M | secret/日志泄露、fallback、退出码语义 | 2–3 个团队试用只读入口 |
| E | 数据工程师/DBA；行差异难解释和选择性恢复 | 覆盖率、原因和计划比一键同步更可信 | PK/UNIQUE、分页、DML、逐表状态 | M–L | 内存、BLOB、列形状、敏感行值 | 选择差异并解释进入/跳过原因 |
| F | DBeaver/DataGrip 用户；重复录入连接拓扑 | 兼容导入降低切换成本 | `NodeConverter` seam、DBeaver exporter | S–M | 私有格式漂移、凭据边界、一次性便利 | 真实导入和重复使用记录 |
| G | 多人发布；评论、审批、权限和责任链缺失 | 共享服务能减少责任不清 | manifest/report 只能作为输入 | XL | 身份、租户、secret、审计和运维 | 先验证静态 manifest 是否已足够 |
| H | PG/SQL Server/Oracle 用户；MySQL-only 阻塞 | 明确且重复的场景值得 adapter | UI、slot、filter、report 外壳 | L–XL | 方言、权限、DDL/data literal 全链路差异 | 收集版本/对象/频率并做 fixture |
| I | 需要自动迁移的团队；希望直接执行/cut-over | 自动执行可能减少手工步骤，但不改变本产品边界 | 仅可复用差异文本和风险提示 | XL，且需安全重构 | 破坏只读信任、锁/复制/回滚责任 | 不设实现实验；保持明确不做 |
| J | 不熟悉 SQL 或需要快速理解差异的用户 | 引用式本地解释可降低学习成本 | `DiffItem`、explain、risk | 未定，需隐私评估 | DDL/行值外传、幻觉、错误修复建议 | 先收集“看不懂哪一段”的样本 |

### 15. 任务依赖与防重复建设

- 不重复 [`09-24-datagrip-converter/prd.md`](../../09-24-datagrip-converter/prd.md) 已明确的 DataGrip 实现；本路线图只把它作为条件性生态方向。
- 不把 DataGrip fixture、真实目标库验证、签名/公证/自动更新当作迁移审查 MVP 的隐含前置；分别记录为发布/生态任务。
- 任何新方向必须先回答：输入是实时库还是 baseline、输出是一次性 SQL 还是报告、是否允许数据值进入 artifact、是否改变 `NodeMeta`/`SecretBundle`/`CompareResult`。
- 若方向改变“只读、不执行”边界，必须重新做安全评审和用户价值实验，不能作为普通功能迭代隐式加入。

## External References

- [MySQL Online DDL](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl.html)
- [MySQL Online DDL operation matrix](https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html)
- [Percona pt-online-schema-change](https://docs.percona.com/percona-toolkit/pt-online-schema-change.html)
- [GitHub gh-ost](https://github.com/github/gh-ost)
- [DBeaver Schema Compare](https://dbeaver.com/docs/dbeaver/Schema-compare/)
- [DataGrip schema comparison](https://www.jetbrains.com/help/datagrip/schema-comparison-and-migration.html)
- [Flyway database comparisons](https://documentation.red-gate.com/flyway/flyway-concepts/database-comparisons)
- [Liquibase diff](https://docs.liquibase.com/secure/reference-guide-5-1-1/database-inspection-change-tracking-and-utility-commands/diff)
- [Atlas migration analyzers](https://atlasgo.io/lint/analyzers)
- [Bytebase change workflow](https://docs.bytebase.com/change-database/change-workflow)
- [Prisma migrate diff](https://www.prisma.io/docs/cli/migrate/diff)

## Caveats / Not Found

- 加权分没有用户数据加权；它是“下一步验证价值”排序，不是承诺或市场预测。
- 没有真实客户、下载、Issue、留存、付费或 CI 使用数据；H1–H9 仍需验证。
- 没有在本研究中执行真实 DDL/DML、在线迁移或外部账号操作。
- 本文件只提供研究与决策材料；研究阶段未修改产品代码、PRD、规范或任务配置，本次 Check Agent 仅修正当前任务文档，未修改产品代码、规范或任务配置。
