# Research: 扩展方向、可支持形态与分阶段技术路线

- **Query**: 当前代码可支持哪些新数据库、工作流和部署形态；每个方向的实现成本、风险、验证门槛，以及可扩展性评分和分阶段路线。
- **Scope**: mixed（内部代码/任务证据 + 已有官方格式研究；本文件不新增未经核验的外部产品事实）
- **Date**: 2026-09-24

## Findings

### 评估口径

- **当前事实**只来自源码、测试、构建产物和历史报告。
- **架构建议**是从当前耦合点推导的可行接缝，不代表需求已证实。
- **产品决策**必须由目标用户、隐私、部署和兼容要求回答。
- 分数只表示“技术验证就绪度”，不是用户价值/市场规模。技术就绪度维度：复用 30%、实现成本（反向）20%、安全/运维风险（反向）20%、验证速度 15%、平台化贡献 15%。1=低，5=高。
- 本文件的技术分与 [`candidate-directions-and-validation.md`](candidate-directions-and-validation.md) 的六维产品验证优先级、以及 [`technical-scalability.md`](technical-scalability.md) 的 headline 技术分不是同一指标；它们分别回答“技术承载力如何”和“下一步验证价值如何”，不能直接横向比较。路线排序以 candidate scorecard 为准，本文件提供成本、依赖和边界证据。

### 方向总表

| 方向 | 当前复用基础 | 相对成本 | 主要风险 | 技术分 | 证据门槛 |
|---|---|---:|---|---:|---|
| MySQL 基线/迁移审查包 | `DiffItem`、risk、rollback、export、history | M（1–3 小任务） | 快照含敏感 schema/行值；版本与陈旧策略 | **4.4** | 3–5 个目标用户完成一次“保存→复审→交接”任务 |
| 数据对比大表/BLOB/无主键治理 | keyset、threshold、cancel、UNIQUE identity | M–L | 内存、隐私、结果可解释性、DB 负载 | **3.8** | 目标表规模分布 + 真实性能/内存实验 |
| Headless CLI / 项目文件 / CI | 纯 core、compare orchestration | M | 凭据、退出码、结果 fallback、依赖 concrete fs/Vault | **3.5** | 目标用户在脚本/CI 中完成可复现只读比较 |
| DBeaver/DataGrip 转换生态 | `NodeConverter` seam、DBeaver exporter/UI | S–M（DataGrip fixture 后） | 私有格式漂移、IDE 版本、仅属迁移便利 | **3.4** | DataGrip 脱敏 fixture + 目标 IDE 真导入 |
| MariaDB / MySQL-compatible 验证 | MySQL 传输与大部分 UI/core | M | 实际版本 DDL/routine/权限差异 | **3.4** | 至少一个真实版本和三类 schema fixture |
| PostgreSQL 扩展 | UI/filter/report 可复用 | L–XL | catalog/schema/identifier/routine/DDL/data literal 全方言化 | **2.4** | 明确用户阻塞 + 可复现 schema/data fixture |
| 持续巡检 / 通知 | compare 与 history | L–XL | 长期凭据、调度、误报、通知数据泄露 | **2.4** | 明确“持续”用例、频率和责任人 |
| 多跳 SSH / proxy / TLS | 单跳 ssh2 与连接抽象雏形 | M | 服务器策略、凭据链、诊断与清理 | **2.4** | 真实跳板/代理/TLS 环境和失败矩阵 |
| SQL Server / Oracle | 几乎无方言复用 | XL | catalog、DCL、routine、DDL、数据类型差异 | **1.9** | 强产品需求 + 专项预算；不能作为通用 adapter 一次性承诺 |
| 团队协作 / 云审计 | 报告/风险模型可作为输入 | XL | 本地 Vault→服务端身份/权限/租户/审计/备份 | **1.9** | 明确团队角色、权限与共享数据边界 |
| Tauri / 新桌面壳重写 | 仅 renderer 视觉层 | XL | Node 连接/Vault/IPC/打包重做，用户价值未证实 | **1.7** | 先有安装包/内存/安全用户痛点数据 |
| 签名、公证、自动更新 | 现有 Win/mac builder | M（发布工程） | 证书运维、升级信任、迁移回滚 | **3.2** | 明确发布频率与目标渠道；不是产品差异化 |

成本仅表示相对工程量：S≈≤3 个工程日，M≈1–2 周，L≈3–6 周，XL=>6 周或需平台级拆分；不是排期承诺。

### 1. MySQL 基线 / 迁移审查工作台

#### 当前事实

- `DiffItem` 已含 SQL、risk、explain、rollback（`src-core/types.ts:87-104`）；`toExportSql` 可生成有序 SQL（`compare.ts:156-173`）。
- `HistoryEntry` 只保存时间、A/B id/alias、diffCount，最多 20 条（`types.ts:118-128`; `store-json.ts:12-13,98-115`），不能恢复 scopes/options/filters/policy/result。
- 当前没有 project、baseline、run id、输入 fingerprint、review status、manifest version 或审批字段。
- 风险规则是本地正则（`risk.ts`），没有可版本化 policy 输入。

#### 可支持的工作流（架构建议）

最小可验证形态不是“云审批”，而是本地、无秘密的 review manifest：记录 node alias/可选脱敏标识、数据库产品与版本、时间、A→B 方向、scope/options、结果 hash/统计、逐项风险和导出文件引用。它可先支持“保存一次比较→重新比较→交接审查”，是否保存完整 DDL/DML 由隐私决策决定。

#### 成本与风险

- **实现成本**：M。核心 diff/risk/export 可复用；新增 project/baseline/manifest 合同、文件迁移、版本兼容、UI 状态和 E2E。
- **主要风险**：schema 与 DDL 仍可能包含业务信息；baseline 陈旧；不同 MySQL 版本的 `SHOW CREATE` 差异；报告被误当作可执行迁移成功证明。
- **安全边界**：继续只读；manifest 默认不引用 `SecretBundle`、master key、safeStorage ciphertext 或完整 vault export。

#### 最小验证

1. 选 3–5 个测试/发布/DBA 用户。
2. 给一个脱敏真实样例，提供“保存基线/复比/生成可交接包”的可点击原型或小实验。
3. 记录用户是否能在无口头指导下完成闭环，以及他们愿意共享哪些字段。
4. 成功门槛：≥3/5 完成；至少一半明确愿意把产物放入现有工单/评审；0 个用户要求自动执行 SQL 才可进入实现验证。

### 2. 数据对比深化

#### 当前事实

- keyset 分页替代旧 `LIMIT 5000`，默认 1000 行；阈值默认 100,000（`data-options.ts:8-23`; `data-fetch.ts:105-134`）。
- 整表仍被积累到 `DataRow[]`，然后 `diffDataRows` 为 A/B 各建 Map；BLOB 明确按 UTF-8 文本处理（`data-diff.ts:64-67`）。
- 无 PK/无可用非空 UNIQUE 的表跳过；两侧身份列不一致记 `pk-mismatch`；逐表串行以控内存（`data-run.ts:168-320`）。
- 真实小表链路已有 1/27 行 `buildings` 只读验证（`09-22-verify-closeout/smoke-report2.md:20-26`），但没有大表内存/延迟基准。

#### 可支持的工作流（架构建议）

先收集行数分布、宽表/BLOB 比例、慢查询和无主键表比例，再决定是否需要流式 merge、排序归并、抽样/分块结果、列选择、敏感列脱敏和更细的取消粒度。不能用“已有分页”推断“任意大表可用”。

#### 成本与风险

- **实现成本**：M–L。
- **主要风险**：全量行值驻留；双 Map 峰值；大对象/二进制编码；并发 COUNT/SELECT 对生产库压力；输出 DML 含敏感值。
- **产品决策**：是否允许比较全部列；是否允许存行值；采样是否只用于预览还是可作为最终 diff；每表/全局资源上限。

#### 最小验证

用合成 10 万/100 万行、宽表和 BLOB fixture 记录峰值 RSS、耗时、SQL 数和取消延迟；再用 3 个真实 schema（脱敏）核对结果。并行定义可接受阈值，而不是先选实现方案。

### 3. Headless CLI / 项目文件 / CI

#### 当前事实

- `src-core` 基本无 Node/Electron 运行时依赖，可独立编译复用。
- `runCompareRequest` 仍直接 `loadNodes(ctx.userDataDir)` 并使用具体 `Vault`（`compare-run.ts:32-35,61-83`）；`runDataCompare` 再做一次 load/pool。
- 没有 CLI bin、JSON report schema、退出码合同、环境变量 secret provider、project file 或 CI。
- renderer `runCompare` 的 demo fallback 是 UI 行为（`store.ts:611-629`），不能被解释为 headless 成功。

#### 可支持的部署形态（架构建议）

最小形态是本机 Node CLI：读取不含秘密的 project/run manifest，秘密只通过 env/keychain reference 注入，返回机器可读 JSON/SQL、明确退出码和脱敏诊断。它与 Electron 共用 core，不需要先云化。

#### 成本与风险

- **实现成本**：M。
- **主要风险**：凭据进入 CI 日志；project 文件被提交时泄漏 topology；退出码/部分失败语义不清；依赖 Node 版本的发布与 Electron 不同。
- **产品决策**：是否允许 topology 入库；允许哪些环境变量/secret store；高危差异是 warning 还是非零退出；是否允许网络出口。

#### 最小验证

给 3 个已有 shell/发布流程的用户一个只读 JSON+退出码试用入口；成功门槛是他们在本地/CI 复现同一 fixture，且能明确说出比打开桌面 UI 节省的步骤。

### 4. DBeaver / DataGrip 转换生态

#### 当前事实

- DBeaver topology-only 导出已完成，输出确定、只含 `NodeMeta`、不读 Vault；focused tests 覆盖直连、密码 SSH、私钥警告和秘密污染输入（`dbeaver.ts`; `dbeaver.test.ts`）。
- `NodeConverter` 预留第三方配置→SqlDiff 接口，但当前注册表为空（`converters/index.ts:14-31`）。
- DataGrip 任务明确阻塞：缺真实脱敏 `dataSources.xml`/`dataSources.local.xml`，尤其 SSH fixture；禁止猜标签（`.trellis/tasks/09-24-datagrip-converter/prd.md:3-28`）。

#### 成本与风险

- **实现成本**：DBeaver 增量 S；DataGrip 在 fixture 到位后 S–M；反向导入另算 M。
- **主要风险**：JetBrains/DBeaver 私有格式版本漂移；用户把“结构校验”当真实 IDE 导入；凭据迁移边界。
- **定位**：这是迁移便利性，不足以单独成为核心差异化；不应阻塞 MySQL 主链路线。

#### 最小验证

DataGrip 只需真实 fixture、目标版本和一次 IDE 导入证据即可解除阻塞；如果用户没有该需求，应延期而不是扩大成通用连接管理器。

### 5. 多数据库支持

#### 5.1 数据库扩展矩阵

| 数据库/类别 | 当前可复用 | 不可直接复用 | 相对成本 | 当前判断 |
|---|---|---|---:|---|
| MariaDB / MySQL-compatible | mysql2/SSH/UI/四类对象概念/DBeaver 部分 | `SHOW CREATE` 文本、版本特性、权限/类型/routine 需 fixture | M | 最适合作为第一候选，但仍需真实版本验证 |
| TiDB / 其他兼容层 | 协议与部分 catalog 可能相似 | 兼容范围、DDL 输出、限制/版本/元数据权限未知 | M–L | 先收集明确阻塞和版本，不先写 adapter |
| PostgreSQL | UI、节点/槽、历史、过滤、报告框架 | pg_catalog、schema、sequence/type/function、quoted identifiers、DDL diff、literal/upsert 语义 | L–XL | 有强需求才进入；不是“加一个 driver” |
| SQL Server | 少量 UI/运行编排 | catalog/schema/DCL/routine/identifier/types/data pagination | XL | 产品级新方向 |
| Oracle | 少量 UI/运行编排 | schema/PLSQL/package/types/quoting/DDL semantics | XL | 产品级新方向 |
| SQLite | 节点模型可勉强映射 host=file，但当前连接/SSH/用户/database 不适用 | 本地文件权限、无 server/SSH、不同 introspection/routine | L | 需先决定是否仍属于同一产品场景 |
| MongoDB 等 NoSQL | 几乎无 schema diff 复用 | 数据模型、查询/变更语义完全不同 | XL/新产品 | 不应归入同一 dialect adapter |

#### 5.2 推荐的技术顺序（条件式）

1. 先以 MariaDB 或用户指定的一个 MySQL-compatible 场景验证“连接层可复用不等于 diff 语义可复用”。
2. 再评估 PostgreSQL；只有 schema/routine/data fixture 与试用用户都存在时才设计跨方言 normalized model。
3. SQL Server/Oracle 不与 PostgreSQL 打包成“一次多数据库支持”，成本与测试矩阵独立。

#### 跨方言最小合同（架构建议，非当前事实）

需要分别定义：connection/auth、metadata provider、object kind、DDL normalizer/diff、row identity、row reader、value renderer、risk policy、formatter。共享的是 `DiffItem`/filter/report 外观和 A→B 语义，不是 MySQL 文本解析函数。

### 6. 团队协作 / 审计

#### 当前事实

- 本地 Vault 和 JSON 没有用户身份、角色、权限、租户、共享存储、事件日志或冲突解决。
- `HistoryEntry` 是个人本机最近 20 条摘要，不能作为合规审计记录。
- 项目 PRD 把桌面本地存储与团队项目/权限/审计列为需要研究的问题，而非已实现能力。

#### 成本与风险

- **实现成本**：XL；需要服务、身份、权限、加密、审计、租户隔离、备份、通知、客户端离线/冲突模型。
- **主要风险**：把本地信任边界搬到云端后出现凭据集中泄露；报告/DDL 本身泄密；审批责任不清。
- **产品决策**：评论/审批是否只是异步文件交接，还是需要系统权限；谁是审计主体；数据驻留与合规要求。

#### 最小验证

在建设服务前，先验证“共享静态 review manifest + 现有工单审批”是否已经满足需求。若满足，服务协作不是近期必要条件。

### 7. 持续巡检 / 通知

#### 当前事实

- 没有 scheduler、job store、retry、通知 channel 或凭据刷新。
- 现有 history 不记录失败、scope、options、结果或输入版本，无法作为漂移基线。
- tunnel 缓存和本地 Vault 适合当前交互会话，不等于长期无人值守凭据治理。

#### 成本与风险

- **实现成本**：L–XL。
- **主要风险**：长期保存生产凭据；网络可达性变化；误报/漏报；通知 payload 泄露 schema/diff；任务风暴。
- **产品决策**：触发频率、责任人、通知渠道、允许存多久的凭据、失败重试与静默期。

#### 最小验证

先用外部 scheduler 定时调用一个只读 CLI 原型，测量误报、连接稳定性和通知内容敏感性；验证通过后再决定是否内建调度。

### 8. 新连接形态

- **多跳 SSH / Proxy / TLS**：当前 `SshConfig` 只支持一跳且 `authType` 只有 password/privateKey（`types.ts:41-48`）。实现成本 M，真实环境矩阵比代码成本更重要。
- **云数据库 IAM / 短期 token**：当前 secret bundle 是长期字符串字段，没有 token expiry/refresh/credential source。高安全价值，也改变 Vault 与 CI 模型。
- **代理/自定义 CA/只读账号模板**：可作为 MySQL 节点 preset，成本 S–M；产品价值需访谈。

### 9. 部署形态

| 形态 | 当前支持度 | 需要的边界变化 | 成本 | 判断 |
|---|---:|---|---:|---|
| 当前 Electron Win/mac 桌面 | **5/5** | 已存在 | 已投入 | 继续深化 |
| Linux 桌面包 | 3/5 | builder target、图标/桌面集成、真实平台测试 | S–M | 技术成本低；需求/支持成本未知 |
| 本机 headless CLI | 2/5 | application service、secret provider、manifest/退出码 | M | 自动化最有价值的下一形态 |
| 本地 Web/局域网服务 | 1/5 | HTTP/auth/multi-user/job/storage/secret server | L–XL | 只有明确多人/远程场景才考虑 |
| 云端团队服务 | 1/5 | 上述全部 + 租户/权限/审计/运维 | XL | 不应作为近期默认路线 |
| Tauri 桌面壳 | 1/5 | 重写 Node 主进程、连接、Vault、IPC、更新 | XL | 仅在包体/性能/安全阻塞被量化后考虑 |
| 移动/Web | 1/5 | 秘密与远端连接模型、响应式 UI、服务端代理 | XL | 与当前“本机持有 DB 凭据”信任模型不同 |

### 分阶段技术路线（建议）

#### Phase 0 — 决策与证据闭环（0–2 周）

1. 明确首要用户和一次比较后的最高成本人工步骤。
2. 收集 3–5 个脱敏 workflow：实时 A/B、baseline、CI、报告交接、DBA review。
3. 对真实 schema 做行数/宽表/BLOB/无主键分布统计。
4. 补 DataGrip fixture，或明确延期；不编造格式。
5. 选择 **一个** 近期实验：推荐“迁移审查包”，备选“headless automation”。

**退出条件**：目标用户、报告隐私、输入模型、首个成功指标明确；否则不进入大规模平台建设。

#### Phase 1 — MySQL 纵向扩展与工程护栏（2–6 周）

1. 为 `compare.run` 补应用服务级集成测试，覆盖 pool 成功/单侧失败/cleanup、data threshold/cancel、IPC progress。
2. 建立版本化 run/project manifest 的最小 schema，只保存允许共享的字段。
3. 用同一 MySQL core 支持“保存 baseline→复比→静态审查包”的小切片。
4. 用性能 fixture 量化整表内存、BLOB、取消延迟和 COUNT/SELECT 压力。
5. 修正/明确 demo 与真实结果的状态合同（`CompareResult` 增加明确 source/status，而不是 UI 文案推断）。

**退出条件**：审查实验被目标用户验证；性能阈值和报告隐私通过；MySQL A→B 只读语义无回归。

#### Phase 2 — 可重复自动化（6–10 周，条件触发）

1. 提取不依赖 Electron IPC 的 application service。
2. 提供无秘密 project manifest、机器可读 JSON/SQL、退出码和脱敏诊断。
3. secret 只从环境变量/系统 keychain reference 读取，不写入 project/report。
4. 外部 scheduler 先做试验；内建调度另行决策。

**退出条件**：目标用户能在本地/CI 重复得到与桌面一致的结果；失败不会被 demo 数据或部分成功掩盖。

#### Phase 3 — 条件选择一个边界扩展

在以下方向中最多选一个：

- **转换生态**：DataGrip fixture 到位且目标用户有迁移频次；
- **新数据库**：MariaDB/TiDB/PostgreSQL 中有明确版本、阻塞和试用者；
- **团队协作**：静态共享 manifest 已不够，需要评论/审批/权限；
- **持续巡检**：外部 CLI 调度已被真实使用且噪声可控。

**原则**：一个方向完成真实验证和回归矩阵后，再进入下一方向。

#### Phase 4 — 平台化（仅在 Phase 3 证据成立后）

- 服务端 job/tenant/auth/audit；
- 多数据库 adapter 产品线；
- 签名更新、Linux/企业分发；
- Tauri 或其他运行时替换。

这些不是默认承诺，而是由已观测瓶颈触发的独立任务。

### 需要立即形成的产品决策

1. **主用户**：测试/发布、DBA、独立开发者、团队审计负责人，谁排第一？
2. **比较对象**：实时 A/B，还是 baseline→当前环境？是否需要多目标/多版本？
3. **输出敏感度**：哪些字段可写入 manifest、CI artifact、工单或通知？
4. **存储**：是否保存 schema/行快照；保留期、加密、换机和删除策略是什么？
5. **自动化**：允许哪些 secret source；失败/高危/无权限的退出码语义是什么？
6. **新数据库优先级**：MariaDB、TiDB、PostgreSQL、SQL Server、Oracle 中哪个有可量化阻塞？
7. **团队形态**：静态文件交接是否足够，还是必须账号/权限/评论/审批？
8. **持续运行**：是否允许后台长期凭据与网络连接；通知 payload 可包含什么？
9. **只读边界**：是否继续明确禁止自动执行生成 SQL（建议保持为不可被功能便利性绕过的产品约束）。
10. **发布治理**：签名、公证、自动更新和 Linux 支持何时成为正式承诺？

### External References

- DBeaver 官方格式研究：`.trellis/tasks/archive/2026-09/09-22-converters/research/dbeaver-connection-import.md`。
- DataGrip/DataSpell 官方格式研究及未证实项：`.trellis/tasks/archive/2026-09/09-22-converters/research/datagrip-dataspell-connection-import.md`。
- 本文件没有把社区/竞品信息当作用户需求事实。

### Related Specs

- `.trellis/spec/backend/database-guidelines.md` — 当前 MySQL 只读、快照、连接与资源合同。
- `.trellis/spec/backend/error-handling.md` — 失败、partial result、取消和 demo fallback 边界。
- `.trellis/spec/backend/directory-structure.md` — main/preload/core/renderer ownership。
- `.trellis/spec/backend/quality-guidelines.md` — 安全、测试、打包门禁。
- `.trellis/spec/frontend/state-management.md` — 当前状态与 fallback 行为。
- `.trellis/spec/guides/cross-layer-thinking-guide.md` — 跨层契约一致性检查。

## Caveats / Not Found

- 所有方向分数都是技术验证优先级；没有客户访谈、付费、留存或使用频率数据，不能当作产品价值结论。
- 没有 CI、容器化、远端服务、数据库 migration、身份/权限系统或 telemetry 的当前实现。
- 没有真实 PostgreSQL/SQL Server/Oracle/MariaDB/TiDB fixture，因此本文件只给相对成本，不承诺兼容性。
- DataGrip 仍受真实 fixture 阻塞；DBeaver 当前只有结构化/CDP 证据，没有真实 IDE 导入证据。
- Windows 原生、SSH 私钥和可转发 SSH 环境未完整验证；详见基线报告。