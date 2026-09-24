# SqlDiff 产品可扩展性与需求路线图

- 任务：`.trellis/tasks/09-24-product-expansion-roadmap`
- 研究日期：2026-09-24
- 状态：研究结论与验证路线；不是功能承诺或收入预测
- 检查状态：AC1–AC7 已完成文档审查；需求假设仍须按实验门槛验证，不能视为产品承诺
- 证据规则：源码/测试/官方文档为 `FACT`，跨来源归纳为 `INFERENCE`，尚未有用户证据的方向为 `HYPOTHESIS`。详见 [`research/README.md`](research/README.md)。

## 1. 执行结论

### 1.1 一句话判断

SqlDiff 已经是一个**可用但仍偏垂直的单机 MySQL 迁移检查器**，不是通用数据库平台：

- MySQL 结构/数据只读对比、风险提示、SQL 交付、节点安全和桌面主闭环已经成立；
- 横向扩展到跨数据库、团队协作、持续调度、云服务或 AI 的技术准备度明显不足；
- 真正值得优先验证的不是“再增加一个数据库连接”，而是把一次性的 diff 变成**可保存、可复比、可交接、可追责的安全迁移证据**。

### 1.2 两个技术分数

| 评估对象 | 分数 | 含义 |
|---|---:|---|
| 当前 MySQL 桌面产品继续纵向加深 | **4.0/5** | 核心 seam、纯函数、测试和桌面闭环已具备，主要风险是规模/真实环境/证据 |
| 扩展为跨数据库、自动化、团队/服务平台 | **2.2/5** | 可复用部分存在，但数据模型、资源生命周期、结果传输、身份/审计和部署合同尚未形成 |

分数是技术就绪度，不是用户价值、市场规模或付费意愿；竞品价格只能证明某种商业模式存在，不能映射成 SqlDiff 的付费意愿。方向排序另见 [`candidate-directions-and-validation.md`](research/candidate-directions-and-validation.md)，技术承载力与验证优先级是两套指标。依据：[`technical-scalability.md`](research/technical-scalability.md)、[`capability-map-and-maturity.md`](research/capability-map-and-maturity.md)。

### 1.3 推荐顺序

1. **先做安全迁移审查工作台/报告**：保存项目与运行清单、覆盖状态、风险结果、差异和人工审查备注；不执行 SQL。
2. **以一个相邻方向做验证切片**：在生产 preflight、headless CI、数据 reconciliation 三者中只选一个，取决于访谈结果。
3. **再做 host-neutral runner**：让 Electron GUI 和本地 CLI 共用同一比较服务，前提是报告/项目合同已被用户接受。
4. **条件触发边界扩展**：基线漂移、DataGrip、MariaDB/其他数据库、团队协作、持续巡检、AI 和新桌面壳都不默认进入近期开发。

## 2. 当前能力地图

### 2.1 已验证/部分验证的能力

| 能力层 | 当前状态 | 事实与限制 |
|---|---|---|
| 节点与秘密 | 本地闭环已验证 | CRUD、safeStorage/AES-GCM Vault、加密 JSON、老连接串导入；跨机器自定义导入和更多凭据来源未覆盖 |
| MySQL 连接 | 部分验证 | 直连、单跳 password/privateKey、pool、tunnel cache、延迟；私钥真机、可转发 SSH、TLS/证书和多跳未闭环 |
| 结构 diff | MySQL 窄域已验证 | 表/视图/过程/函数、分类、风险、回滚、过滤和 SQL 导出；legacy text parser 不是完整 schema AST |
| 数据 diff | 小表/明确身份已验证 | PK/联合 PK/全非空 UNIQUE、keyset、阈值、进度、取消、DML；整表 materialize、BLOB/无主键/大表仍是边界 |
| UI 工作流 | demo + Docker/CDP 已验证 | 三栏、节点管理、A/B、过滤、复制、下载、数据面板；真实目标库/Windows/部分连接环境受限 |
| 互操作 | DBeaver 结构化完成 | `data-sources-sqldiff.json`、SSH 映射、无秘密下载；真实 DBeaver IDE import 未验证，DataGrip fixture 阻塞 |
| 发布 | 产物可构建 | Win x64、mac x64/arm64、图标和 DMG 校验；unsigned、无 updater/CI、Linux target 未配置 |
| 协作/运营 | 未建立 | 无项目、基线、账号、角色、审批、审计、调度、通知或用户行为数据 |

详细证据：[`capability-inventory.md`](research/capability-inventory.md)、[`desktop-ui-flow.md`](research/desktop-ui-flow.md)、[`data-security-deployment-constraints.md`](research/data-security-deployment-constraints.md)。

### 2.2 明确未实现/未闭环与已知技术债

| 类别 | 当前状态与边界 | 主要依据 |
|---|---|---|
| 结果来源 | 真实比较失败时 renderer 填入 demo；`CompareResult` 没有独立的 real/demo/source 字段 | `apps/desktop/src-renderer/store.ts:611-629`；`apps/desktop/src-core/types.ts:202-207`；`e2e-report.md:51-57` |
| 审查/项目对象 | 没有 project、baseline、manifest、review status、审批或审计；`HistoryEntry` 只是最近 20 条摘要 | `apps/desktop/src-core/types.ts:118-207`；`apps/desktop/src-main/store-json.ts:98-115` |
| 覆盖率 | 单个 `SHOW CREATE` 失败变成 `null` 并跳过，可能把权限盲区误读为无差异 | `apps/desktop/src-main/metadata.ts:190-201`；`apps/desktop/src-core/compare.ts:63-69,111-138` |
| 数据规模/类型 | keyset 分页后仍整表 materialize；BLOB/无身份/异形列和大表峰值尚未有基准或完整策略 | `apps/desktop/src-main/data-fetch.ts:105-134`；`apps/desktop/src-main/data-run.ts:121-166`；`apps/desktop/src-core/data-diff.ts:48-80` |
| 连接与资源 | 单跳 SSH；无 TLS/CA/host identity/多跳；pool 部分构造、全局取消、退出未等待和 tunnel 失效边界仍存在 | `apps/desktop/src-main/connection.ts:55-103,232-427`；`apps/desktop/src-main/compare-run.ts:80-89,139-141`；`apps/desktop/src-main/main.ts:280-288,408-411` |
| 输出与执行 | 生成的 DDL/DML 不在应用内执行；legacy DDL 仍有对象名反引号插值，外部执行没有 recheck/审计 | `apps/desktop/src-core/diff.ts:59-60,141-170`；`.trellis/spec/backend/database-guidelines.md:7-23` |
| 互操作 | DBeaver 只有结构化/no-secret/CDP 证据，真实 IDE import 未验证；DataGrip 缺真实脱敏 XML/SSH fixture | `apps/desktop/src-main/converters/dbeaver.ts:97-217`；`dbeaver-report.md:5-7,34-54`；`09-24-datagrip-converter/prd.md:1-42` |
| 环境与发布 | 指定内网真库、SSH 私钥/可转发隧道、Windows 原生运行、签名/公证、updater、CI 和 Linux target 未闭环 | `smoke-report2.md:5-18,28-33`；`e2e-report.md:14-20,49-58,101-111`；`apps/desktop/electron-builder.yml:1-27` |

### 2.3 当前最重要的产品语义风险

真实比较失败时，renderer 会用 demo 结果填充界面并 toast 说明原因；这在离线演示上有价值，但用户可能把示例差异误读为真实结果。当前没有独立的 `source/status` 结果模型或醒目的 demo 标识（`store.ts:611-629`，E2E 报告已记录）。

**结论**：任何自动化、报告或 CI 方向都必须先解决“结果来源和覆盖状态可辨识”，不能让 demo fallback 进入机器结果。

## 3. 需求挖掘：事实、假设与优先级

### 3.1 证据分层

| 层级 | 本任务可以确认的内容 | 不能从本任务推出的内容 | 证据入口 |
|---|---|---|---|
| 已证实事实 | 当前代码、测试、Docker/CDP/历史报告直接显示的 MySQL 主闭环、只读边界、存储/秘密边界和已记录的环境缺口 | 用户角色、需求频率、付费意愿、留存或真实市场优先级 | [`capability-inventory.md`](research/capability-inventory.md)、[`evidence-and-maturity.md`](research/evidence-and-maturity.md) |
| 高价值假设 | H1–H9 是值得优先验证的问题/方向；分数只表示验证顺序 | “竞品有该功能”不等于 SqlDiff 用户需要；高分不等于应立即开发 | [`user-needs-and-priority-signals.md`](research/user-needs-and-priority-signals.md)、[`candidate-directions-and-validation.md`](research/candidate-directions-and-validation.md) |
| 待验证问题 | 目标角色、频率、隐私边界、规模、非 MySQL 阻塞、secret source、团队责任和发布承诺仍是开放问题 | 在访谈/行为/fixture/环境证据出现前，不得写成产品承诺 | 本路线图第 7 节、各候选方向的最小实验 |

### 3.2 需求假设登记

| ID | 目标用户/问题 | 价值假设 | 当前证据 | 证据强度（非需求概率） | 最小验证 |
|---|---|---|---|---|---|
| H1 迁移审查工作台 | 发布/测试/DBA：差异难形成可交接证据 | 保存输入/覆盖/风险/回滚并导出审查包，会改变发布前工作流 | 当前 `HistoryEntry` 只有摘要；已有 `DiffItem`/risk/export；竞品普遍有任务/报告层 | 中低 | 5–8 名用户完成脱敏“保存→复比→交接”任务 |
| H2 生产 preflight | DBA/后端：不知道 ALTER 的锁、重建、空间、复制影响 | 只读检查比自动迁移更快、更可信 | MySQL Online DDL、Percona、gh-ost 提供检查维度；当前仅关键字风险 | 中 | 用一个生产规模脱敏 fixture 判断发布/阻断/未知 |
| H3 可审计 reconciliation | 数据工程师：需要解释哪些行/表进入计划和为何跳过 | 选择性计划和覆盖率比一键同步更符合信任边界 | 现有 PK/UNIQUE、DML、逐表状态；缺报告/列映射/选择性恢复 | 中低 | 让用户选择差异并解释恢复计划，不执行 |
| H4 基线/漂移 | 平台/DBA：不知道相对上次确认状态的变化 | 版本化基线能发现遗漏/未授权漂移 | Flyway/Liquibase/Atlas 有 snapshot/drift；当前无 baseline | 低中 | 连续两次使用同一 fixture，观察是否保存并复比 |
| H5 CI/PR 只读入口 | 开发/平台：GUI 难以进入流水线 | JSON/退出码/报告能复用 core | Prisma/Atlas/Bytebase/Flyway 有 CLI/CI；当前无 runner | 低中 | 2–3 个团队试用只读 runner，凭据不入 artifact |
| H6 连接配置迁移 | DBeaver/DataGrip 用户：减少重复录入 | 兼容导入降低切换成本 | DBeaver topology-only 已实现；DataGrip 缺 fixture | 中（便利性） | 统计导出后是否真实使用；无重复则延期 |
| H7 多数据库 | PG/SQL Server/Oracle 用户：MySQL-only 阻塞 | adapter 能降低阻塞 | 竞品支持多库，但这不是 SqlDiff 用户证据 | 低 | 收集具体版本、对象、频率和替代工具 |
| H8 团队协作/审批 | 多人发布：评论、审批、审计 | 共享项目与责任链减少风险 | 竞品有治理层；当前无身份/服务/权限 | 低 | 先验证静态 manifest 是否已满足交接需求 |
| H9 AI 解释 | 不熟悉 SQL 的用户：看不懂差异 | 基于本地证据的解释可降低学习成本 | 竞品有 AI 入口；无本产品用户样本，隐私/幻觉风险高 | 低 | 收集“看不懂哪一段”的样本，只做引用式解释 |

来源：[`user-needs-and-priority-signals.md`](research/user-needs-and-priority-signals.md)、[`adjacent-product-landscape.md`](research/adjacent-product-landscape.md)。

### 3.3 候选方向评分

评分权重：问题严重性/频率 25%、战略契合 20%、复用/可行性 20%、差异化 15%、验证速度 10%、风险逆向 10%。高分仍需用户证据；每个方向的事实/假设依据见 [`candidate-directions-and-validation.md`](research/candidate-directions-and-validation.md)。

| 排名 | 方向 | 分数 | 决策 |
|---:|---|---:|---|
| 1 | MySQL 迁移审查工作台 + 可交接报告 | **4.50** | 近期推荐，先验证 |
| 2 | 本地基线、项目文件与漂移 | **4.20** | 纳入方向 A，先验证连续使用 |
| 3 | 大表/生产变更只读 preflight | **4.20** | A 的第二切片或备选重点 |
| 4 | Headless CLI / 项目文件 / CI gate | **4.00** | 中期高价值假设，先有 manifest |
| 5 | 可审计数据 reconciliation 与恢复计划 | **3.65** | 条件推进，先做数据实验 |
| 6 | DBeaver/DataGrip 连接生态 | **3.10** | 低风险便利项；DataGrip 等 fixture |
| 7（并列） | 团队协作、评论、审批、审计 | **2.95** | 仅在报告/CI 被真实交接后触发 |
| 7（并列） | 在线迁移/自动执行/cut-over | **2.95** | 明确不做，违反只读边界 |
| 9 | AI 差异解释/修复建议 | **2.75** | 延后，先收集可解释性问题 |
| 10 | 多数据库方言 | **2.65** | 延后，先取得重复场景 |

评分原始表和门槛见 [`candidate-directions-and-validation.md`](research/candidate-directions-and-validation.md)。B/C 同为 4.20，先后不代表价值差异；G/I 同为 2.95，但 I 因违反只读安全边界不进入路线。

## 4. 推荐产品路线（近期 → 中期 → 远期）

### Phase 0：证据与可信度门槛（近期，0–2 周）

**目标**：确认谁最需要 SqlDiff，以及一次比较后哪一步最耗时。

- 访谈/观察 5–8 名发布、测试、DBA、后端用户；使用脱敏真实任务。
- 统计真实 schema 的表数、行数、宽表/BLOB、无 PK/UNIQUE、权限失败和版本分布。
- 明确 `live-vs-live` 与未来的 `baseline-vs-live` 语义，不把 history 摘要冒充 run。
- 修复或明确 demo/real 结果的可见状态；headless 结果禁止 fallback 到 demo。
- 决定 DataGrip fixture、真实目标库、Windows、SSH、签名/公证/更新的独立任务状态。
- 形成 review manifest 的隐私边界：哪些 alias、DDL、行值、风险和证据可以离开本机。

**退出条件**：目标角色、首个成功指标、报告隐私边界、真实数据规模和优先级有证据；否则不进入跨数据库或服务化。

### Phase 1：安全迁移审查最小闭环（近期，2–6 周）

**目标**：把一次性 SQL 变成可重放、可交接的审查记录。

- 定义 versioned、无秘密的 project/run manifest：工具版本、时间、A→B 方向、scope/options/映射、输入 fingerprint、覆盖状态、DiffItem、风险/回滚提示、报告引用。
- 覆盖状态必须区分：成功、权限失败、无行身份、超阈、取消、错误；不能只保存“有差异”。
- 导出脱敏 Markdown/JSON；允许人工标记“接受/排除/待确认”，但不提供执行按钮。
- 先支持本地文件和现有工单/聊天交接，不建账号、RBAC 或云审计。
- 以 5–8 人实验决定是否继续做 baseline；若用户只要一次性 SQL，则停止报告扩展。

**退出条件**：用户能完成“保存→复比→交接”，能解释 skipped/unknown 含义，且 0 个用户把“自动执行”作为不可替代条件。

### Phase 2：从证据选择一个相邻重点（中期，条件触发）

三者只选一，不在同一个 MVP 同时实现：

1. **生产 preflight v1**：只读检查 MySQL 版本、表规模、主键/索引重建、空间、复制延迟、权限盲区；输出事实/推断/未知，不调用 online migration 工具。
2. **headless CI v1**：从 project manifest 运行只读比较，输出 JSON/SQL/退出码；secret 只从 env/keychain reference 注入；不把行值默认送入 CI。
3. **数据 reconciliation 报告 v1**：列映射、覆盖率、抽样/哈希、无 PK 原因、选择性恢复计划；继续只读，不嵌入 pt-table-sync/gh-ost 执行。

选择判据：哪一项在用户访谈中实际改变发布/排障行为，而不是哪一项最容易写代码。

### Phase 3：平台化边界（远期，条件触发）

只有 Phase 1/2 的使用证据成立后，最多选择一条：

- **基线/漂移**：本地 project history、两次比较的增量变化；仍不做云调度。
- **新数据库**：先验证 MariaDB/兼容版本，再考虑 PostgreSQL；定义独立 `DialectAdapter`、normalized metadata、DDL/data/risk/formatter fixtures。
- **团队协作**：静态 manifest 不够时，才引入评论、审批、身份、RBAC、审计和服务端 secret 边界。
- **持续巡检**：先用外部 scheduler 调 CLI，验证误报、凭据和通知边界，再考虑内建 job store。

### 明确暂缓

- 自动执行/在线 cut-over；
- 云端多租户和完整权限平台；
- 没有真实需求的 PG/SQL Server/Oracle 一次打包支持；
- 默认 AI 生成修复 SQL；
- Tauri/新桌面壳重写；
- 没有重复使用证据的 DataGrip 双向同步或通用连接管理器。

## 5. 技术落地顺序

### 5.1 先抽合同，不先扩数据库

建议按以下顺序建立 seam：

1. `CompareRunContext` 改为依赖 `NodeRepository`、`SecretProvider`、`HistorySink` 等窄接口，而不是直接读取 `loadNodes(ctx.userDataDir)` 和具体 `Vault`。
2. 将 metadata 类型从 `src-main/metadata.ts` 移到跨宿主可用的 contract；纯 core 不再通过类型反向依赖 main 目录。
3. 定义 `ProjectManifest`、`RunManifest`、`ReviewReport`、`CoverageStatus` 和版本迁移规则。
4. 定义 `DialectAdapter` 时分别覆盖 connection/auth、metadata provider、DDL normalizer/diff、row identity、value renderer、risk policy、formatter；不要把 MySQL parser 改名成通用 parser。
5. 在大表实验证明需要前，不引入 worker/utility process；先测量 main heap、IPC clone、renderer heap 和取消延迟。

依据：[`technical-scalability.md`](research/technical-scalability.md)、[`technical-debt-and-reusable-seams.md`](research/technical-debt-and-reusable-seams.md)。

### 5.2 工程护栏优先级

| 优先级 | 护栏 | 原因 |
|---|---|---|
| P0 | 明确 demo/real 结果来源和 coverage | 防止用户把示例差异当真实结果 |
| P0 | report/project 不含 secret、行值默认脱敏 | 后续交接/CI 的前置安全条件 |
| P0 | compare/data 应用服务集成测试 | 当前测试主要覆盖纯函数，cleanup/cancel/partial failure 仍有缺口 |
| P1 | 大表/BLOB/无主键基准 | `fetchAllByPK` 仍整表 materialize，threshold 不是内存上限 |
| P1 | SSH host identity、TLS/CA、secret source 决策 | 进入无人值守/团队前必须明确信任边界 |
| P1 | 签名、公证、自动更新、CI 独立任务 | 是发布工程，不应混入数据库功能 |

### 5.3 独立任务与环境依赖

| 事项 | 当前证据/状态 | 依赖与退出条件 | 与本路线图的关系 |
|---|---|---|---|
| DBeaver | topology-only JSON、SSH 映射、no-secret 和 CDP 下载已验收；真实 DBeaver IDE import 未执行 | 目标 DBeaver 版本 + 一次真实导入 + no-secret 检查 | 生态维护项，不重复建设 exporter |
| DataGrip | [`09-24-datagrip-converter/prd.md`](../09-24-datagrip-converter/prd.md) 仍 blocked；缺真实脱敏 `dataSources.xml`/`dataSources.local.xml`，尤其 SSH fixture | fixture、目标 IDE 版本、真实导入证据和秘密边界 | 独立生态任务；不是 A/B MVP 的隐含前置 |
| 真实目标库 | Docker MySQL fixture 与历史直连/小表证据存在；指定内网库不可达 | 可达环境、权限矩阵、版本/规模记录、脱敏结果 | 作为 preflight/报告实验环境，不宣称私有库已验证 |
| SSH | password 认证有部分证据；目标服务端拒绝 TCP forwarding，私钥/可转发/多跳未闭环 | 真实 jump host/private key/forwarding 和失败矩阵 | 自动化/团队化前置；不阻塞只读本地原型 |
| Windows | macOS 交叉构建和 PE/NSIS 核验；没有 Windows 原生启动证据 | Windows 真机安装、启动、下载/剪贴板/CDP 检查 | 发布工程独立验证，不从 macOS 证据推断 |
| 签名/公证/updater/CI/Linux | 当前 builder 无签名、公证、updater、CI 或 Linux target | 发布渠道、证书、升级策略、CI 和原生 QA 决策 | 不阻塞研究路线；不宣称已支持 |

## 6. 建议的候选任务（不自动创建）

| 优先级 | 候选任务 | 前置/验收重点 |
|---|---|---|
| P0 | `sqldiff-review-manifest` | versioned、无秘密、coverage、JSON/Markdown 导出、5–8 人实验 |
| P0 | `sqldiff-result-source-state` | 真实/demo/部分失败状态显式化，E2E 回归 |
| P0 | `sqldiff-preflight-fixture` | 大表/权限/复制延迟 fixture 与只读检查原型 |
| P1 | `sqldiff-headless-runner` | GUI/CLI 同结果、退出码、secret provider、无 demo fallback |
| P1 | `sqldiff-data-diff-hardening` | 10k/100k/1m 行、BLOB、峰值内存、取消和结果完整性 |
| P1 | `sqldiff-baseline-prototype` | 连续两次比较、baseline 语义、隐私和陈旧策略 |
| P2 | `sqldiff-dialect-adapter-mariadb` | 真实版本、三类对象、权限和差异 fixture |
| P2 | `sqldiff-team-review` | 仅在 manifest/CI 真实交接后启动 |
| blocked | [`09-24-datagrip-converter`](../09-24-datagrip-converter/prd.md) | 等待真实脱敏 XML/SSH fixture |
| ops | `sqldiff-release-governance` | 签名、公证、updater、CI、Windows 原生验证 |

## 7. 最重要的未决问题

代码无法回答，必须通过用户/环境验证：

1. 首要用户是独立开发者、测试/发布、DBA，还是团队审计负责人？
2. 一次比较后最耗时的是发现差异、风险/锁/复制、回滚、交接，还是重复录入？
3. 用户是否需要“上次确认状态”作为基线，还是只在发布前临时比较两个实时库？
4. 哪些 DDL、行值、节点别名和拓扑可以进入本地 manifest、CI artifact、工单或通知？
5. 真实数据规模、宽表/BLOB/无主键比例和可接受延迟是多少？
6. CLI/CI 允许的 secret source 是什么？高危差异、权限失败和部分成功如何映射退出码？
7. 首个非 MySQL 数据库及其版本/对象/权限阻塞是否重复出现？
8. 静态共享 manifest 是否已经满足团队交接，还是确实需要账号/审批/审计？
9. 是否继续把“不执行生成 SQL”作为不可绕过的产品安全边界？（建议：是。）
10. 签名、公证、自动更新和 Linux 支持何时进入正式发布承诺？

## 8. 证据与限制

- 当前代码与测试证据：[`capability-map-and-maturity.md`](research/capability-map-and-maturity.md)、[`desktop-ui-flow.md`](research/desktop-ui-flow.md)、[`data-security-deployment-constraints.md`](research/data-security-deployment-constraints.md)。
- 技术评分与新形态：[`technical-scalability.md`](research/technical-scalability.md)、[`expansion-options-and-roadmap.md`](research/expansion-options-and-roadmap.md)。
- 用户/竞品工作流：[`user-needs-and-priority-signals.md`](research/user-needs-and-priority-signals.md)、[`adjacent-product-landscape.md`](research/adjacent-product-landscape.md)、[`mysql-schema-data-diff-workflows.md`](research/mysql-schema-data-diff-workflows.md)。
- 当前没有 SqlDiff 用户访谈、下载/活跃/留存、付费、CI 使用或非 MySQL fixture 数据；HYPOTHESIS 不能直接转成开发承诺。
- 指定内网真库、SSH 私钥/可转发隧道、Windows 原生运行、DBeaver IDE 导入和 DataGrip fixture 仍是独立环境/生态任务，不应被本路线图的结论掩盖。
- 复核基线：`git rev-parse HEAD` 为 `f51d562`；复核时 `git status --short` 仅显示本任务目录和用户已有的 `apps/desktop/README.md` 文档改动，未修改产品代码、未提交、未归档。质量门禁与文档/JSONL 检查结果见本次 Check Agent 报告。
