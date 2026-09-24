# Research: 当前 Electron / React / Node / MySQL 技术扩展性基线

- **Query**: 评估当前 Electron/React/Node/MySQL 代码的模块边界、纯核心/主进程/renderer 边界、数据模型、测试与 E2E、连接/安全/资源管理瓶颈，以及可扩展性。
- **Scope**: internal（当前源码、测试、构建配置、Trellis 规范与历史验收材料）
- **Date**: 2026-09-24

## Findings

### 结论摘要

- **[事实·高置信]** 当前形态是一个边界清晰但仍高度 **MySQL 专用** 的 Electron 单机应用，不是 HTTP 服务、插件宿主或多租户平台。
- **[事实·高置信]** 纯比较逻辑已有较好的确定性测试基础：2026-09-24 本次复核为 **17 个测试文件、167 个测试通过**；`npm run typecheck`、`npm run lint` 通过。归档报告记录了此前的 build/package 核验；研究采集阶段没有重新运行会写入产物的 `npm run build`/`npm run pack`，本次 Check Agent 质检阶段另行运行了 `npm run build`（未运行 `npm run pack`）。
- **[事实·高置信]** 可扩展性最大的约束不在 React，而在数据/方言边界：没有数据库 engine/dialect 字段，`DatabaseMetadata` 固定为 MySQL 四类对象快照，结构 diff 直接解析 MySQL `SHOW CREATE` 文本，数据 diff 生成 MySQL 字面量与反引号 SQL。
- **[架构建议·中高置信]** 近期最稳妥的扩展顺序是：先补编排层/存储层的接口边界和回归测试，再做 MySQL 工作流深化；headless/CLI 可在同一边界下验证；跨数据库、团队云协作和 Tauri 重写应后置。
- **[产品决策]** 是否支持异构数据库、保存 schema/row 快照、团队共享、自动调度、签名更新，必须先由目标用户和隐私边界决定，不能由当前技术可行性代替需求验证。

### Files Found

| File Path | Description |
|---|---|
| `apps/desktop/src-main/main.ts` | Electron composition root、窗口、全部 IPC handlers、剪贴板/下载注册、退出清理 |
| `apps/desktop/src-main/preload.ts` | `contextBridge` 暴露的 typed `SqlDiffApi`；唯一 renderer→main 通道 |
| `apps/desktop/src-core/types.ts` | 跨层领域契约：`NodeMeta`、`SecretBundle`、`DiffItem`、`CompareResult`、请求/状态类型 |
| `apps/desktop/src-core/diff.ts` | MySQL `SHOW CREATE` 文本结构 diff 与 DDL 生成 |
| `apps/desktop/src-core/compare.ts` | 元数据快照→`DiffItem[]`、统计、排序、SQL 文本导出 |
| `apps/desktop/src-core/data-diff.ts` | MySQL 行级 DML 生成；值与标识符输出转义 |
| `apps/desktop/src-main/connection.ts` | `mysql2/promise` pool、单跳 `ssh2` 隧道、连接测试与资源生命周期 |
| `apps/desktop/src-main/metadata.ts` | `information_schema`、`SHOW CREATE` 拉取与并发限流 |
| `apps/desktop/src-main/data-fetch.ts` | `COUNT(*)` + keyset pagination 的 MySQL 行读取 |
| `apps/desktop/src-main/data-run.ts` | 逐表数据对比编排、行身份选择、状态与取消 |
| `apps/desktop/src-main/compare-run.ts` | A/B pool、快照、结构/数据对比和历史落盘的总编排 |
| `apps/desktop/src-main/vault.ts` | safeStorage / AES-GCM、秘密文件、加密导出、旧连接串导入 |
| `apps/desktop/src-main/store-json.ts` | `nodes.json` / `history.json` 同步文件存储 |
| `apps/desktop/src-renderer/store.ts` | 单个 Zustand store，状态、IPC actions、demo fallback、对比流程 |
| `apps/desktop/src-renderer/App.tsx` | 1,783 行三栏 UI、节点 CRUD、过滤、进度、SQL 预览、两个 Modal |
| `apps/desktop/electron-builder.yml` | Windows x64 NSIS、macOS x64/arm64 DMG；无签名/更新配置 |
| `apps/desktop/tsconfig.main.json` | 主进程 CommonJS 编译；当前 include 未排除 `*.test.ts` |
| `apps/desktop/vitest.config.ts` | 收集 core/main/renderer 三层 `*.test.ts` |

### 当前运行链路与边界

#### 1. Renderer → Preload → Main

- **[事实]** `createWindow` 设置 `contextIsolation: true`、`nodeIntegration: false` 并加载显式 preload：`apps/desktop/src-main/main.ts:367-380`。
- **[事实]** renderer 只通过 `window.sqldiff`；`SqlDiffApi` 定义在 `src-main/preload.ts:66-106`，实现只做 `ipcRenderer.invoke`/事件订阅：`src-main/preload.ts:108-150`。
- **[事实]** renderer 直接 import 的 main 侧内容均为 `import type`（`App.tsx:7`、`store.ts:31-36`、`sql.ts:7`），运行时没有 `electron/mysql2/ssh2` 依赖进入 renderer。
- **[事实]** `index.html` 没有 CSP meta，`main.ts` 搜索也没有 `session.webRequest`、`setWindowOpenHandler`、`will-navigate` 或显式 CSP 设置；这是扩展为加载远程内容、外部链接或插件 UI 时的边界事实。

#### 2. Main / Node 边界

- **[事实]** `main.ts` 同时承担 Electron 生命周期、节点/历史/连接/数据/格式/复制等 IPC 路由（`registerIpc`，`main.ts:277-359`）。比较工作已委托给 `compare-run.ts`，但连接、数据和持久化仍由 handler 直接组装。
- **[事实]** Node-only 依赖集中在 main：`connection.ts:12-15` 引入 `mysql2/promise`、`node:net`、`ssh2`；`vault.ts:14-17` 引入 `node:crypto/fs/path`。
- **[事实]** `tsconfig.main.json:4-10` 编译整个 `src-main` 与 `src-core`；本次 build 后 `dist-main` 中存在 **15 个 `*.test.js`**。`electron-builder.yml:6-9` 打包 `dist-main/**/*`，因此按当前配置重建时测试编译产物也进入包。
- **[事实]** `monaco-editor` 是 production dependency（`package.json:18-23`），但 renderer 实际使用 `<pre>` 正则高亮（`sql.ts:1-3`）。本地依赖目录中 `monaco-editor` 约 98 MB；现有 `app.asar` 为 99 MB，asar 内可见 1,926 个 Monaco 条目。这里记录的是当前构建形态，不把包大小直接等同于用户问题。

#### 3. Core 边界

- **[事实]** core 大部分函数是确定性的：`diff.ts` 不连 DB；`compare.ts` 只消费快照；`data-diff.ts` 只消费行；`classify.ts`/`risk.ts` 是本地规则。
- **[事实]** core 测试重点覆盖结构语义、过滤、风险、行身份、值转义和导出顺序，基础较扎实：`src-core/diff.test.ts`、`ddl-dml-index.test.ts`、`verb-search.test.ts`、`data-diff.test.ts`、`data-unique.test.ts`。
- **[边界倒置·事实]** `DatabaseMetadata` 定义在 main 的 `metadata.ts:27-32`，但 `src-core/compare.ts:7`、`compare-filter.ts:6` 和 renderer 的 `demo.ts:5` 都从 main 路径 type-import。当前因为是 `import type` 而能通过构建；这仍是 core 对 main 目录的编译期反向依赖，独立提取 core/CLI 时需要处理。
- **[事实]** 真正数据库无关的共享层主要是 `types.ts` 的输出契约、filter/classify/risk/sort；结构语义本身并非数据库无关。

### 数据模型扩展性

| 当前模型 | 当前事实 | 扩展含义 |
|---|---|---|
| `NodeMeta` (`types.ts:50-70`) | 固定 MySQL 风格 `host/port/user/database` + 单个 `ssh`；默认端口 3306；无 `engine`/`dialect`/TLS/proxy | 增加数据库类型不是 UI 多一个选项；需版本化节点模型与 transport/credential 合同 |
| `SecretBundle` (`types.ts:72-78`) | 固定 DB password、SSH password、privateKey、passphrase | 新数据库/云身份会扩展秘密种类；本机 safeStorage 不自动成为 CI/服务凭据方案 |
| `DatabaseMetadata` (`metadata.ts:27-32`) | 固定 `tables/views/procedures/functions` 四张 `name→SHOW CREATE or null` map | PostgreSQL schema/sequence/type、SQL Server schema/routine 等无法无损装入当前形状 |
| `DiffItem` (`types.ts:87-104`) | 固定 table/view/procedure/function/data，SQL 文本、risk、rollback、explain | 可承载展示，但缺少 dialect/version/provenance/operation-level constraints 等审计信息 |
| `CompareRequest/Result` (`types.ts:139-207`) | 单次 A/B、固定 scopes、同步返回完整 items | 不表达多目标、基线版本、策略、报告 manifest、异步 job 或增量结果 |
| `HistoryEntry` (`types.ts:118-128`) | 20 条摘要，只保存别名/节点 id/差异数 | 不能恢复 scopes、filters、options、policy、结果或审查结论 |
| 本地持久化 (`store-json.ts`) | 同步原子写 `nodes.json`/`history.json`；损坏读为空 | 单机可用；并发写、迁移、schema version、锁与团队共享不在当前模型内 |

### 测试与 E2E 能力

#### 当前自动化事实

- **[事实]** 本次在 `apps/desktop` 运行：`npm test -- --run` → 17 files / 167 tests passed；`npm run typecheck`、`npm run lint` 通过。归档 E2E 报告记录了此前的 build/package 核验；研究采集阶段没有重新运行 `npm run build`/`npm run pack`，本次 Check Agent 质检阶段另行运行了 `npm run build`（未运行 `npm run pack`）。
- **[事实]** Vitest 收集三层测试（`vitest.config.ts:3-5`），但没有 coverage 配置、React Testing Library、jsdom、snapshot、a11y automation 或 CI 配置。
- **[事实]** 以下关键编排文件没有同名测试文件：`main.ts`、`preload.ts`、`compare-run.ts`、`data-run.ts`、`store.ts`、`App.tsx`。其中大部分行为只能由组合测试或人工/CDP 覆盖。
- **[事实]** `connection.test.ts:1-2` 明确真实建连路径依赖手工冒烟；`data-fetch.test.ts` 只测 SQL/nextKey，不测 `fetchAllByPK` 循环、阈值、取消或内存行为。
- **[事实]** `metadata.test.ts` 使用 fake DB 验证查询与并发上限；`data-run-identity.test.ts` 只测 `decideIdentity` 纯函数，不测逐表异常、pool/tunnel cleanup 或 IPC progress。

#### 历史 E2E 证据

- **[事实]** `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:22-49` 记录 22 个动作，覆盖节点 CRUD、demo、Docker MySQL 8 fixture、结构/数据 diff、过滤/复制/导出、安全文件和快捷键。
- **[事实]** 同一报告明确：指定内网真库未闭环、Windows 真机未启动、CDP harness 与原始命令日志未入库（`:9-12`, `:49-58`）。仓库内没有可重复的 E2E harness 或 Playwright 配置。
- **[事实]** `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md:5-13` 证明 SSH 密码认证本身连通，但服务端拒绝 TCP forwarding；私钥通道未验证。
- **[事实]** 同一报告 `:15-26` 记录两套真实 MySQL 直连（458 表/516 表）及 `buildings` 表真实行级只读 diff；`09-21-desktop-m7-smoke/smoke-report.md:19-24` 记录 521 项结构 diff。
- **[推论·高置信]** 现有证据足以证明 MySQL 直连/结构/小表数据主链路，不足以宣称所有 MySQL 版本、所有 SSH 环境、Windows 原生运行或大数据规模都已闭环。

### 连接、安全与资源管理边界

#### 已建立的约束

- **[事实]** 执行到数据库的只读 SQL 集中在 `metadata.ts` 与 `data-fetch.ts`：`SELECT 1`、`COUNT(*)`、keyset `SELECT *`、`information_schema`、`SHOW CREATE`；未发现把 `DiffItem.sql` 送入 pool 的代码。
- **[事实]** schema/value 使用参数化，执行的表/列标识符经 `escapeIdent`；生成 DML 的标识符和值由 `escapeDataIdent`/`sqlLiteral` 处理。
- **[事实]** safeStorage 不可用时回退 AES-256-GCM；每个 node secret 单独文件；`nodes.json` 不存秘密（`vault.ts:1-12`, `:189-315`）。DBeaver 导出只读 `NodeMeta`，不接触 Vault（`main.ts:218-222`）。
- **[事实]** 结构/数据对象逐表失败有部分结果语义；超阈是 `confirm-needed`；取消通过 `AbortSignal` 传播到分页循环。

#### 当前边界事实与后果

| 边界 | 代码证据 | 对扩展的事实影响 |
|---|---|---|
| 元数据并发 | `MAX_CONCURRENCY=10` 是每个 object-category map 的 worker 数（`metadata.ts:13-14`, `:191-196`）；两库、四类 map 并发；pool limit=5（`connection.ts:301-318`） | 大 schema 的实际 DB 并发受 pool 排队；该常量不是全局总并发。未来多库/多租户不能直接复用为全局限流 |
| 数据内存 | `fetchAllByPK` 把整表放入 `out: DataRow[]`（`data-fetch.ts:105-134`）；随后 `diffDataRows` 再建两张 Map（`data-diff.ts:89-142`） | keyset 分页降低单次 query 压力，但没有降低整表峰值内存；BLOB/宽表/百万行会放大 renderer→main result 与本地 heap |
| 取消粒度 | `main.ts:280-288` 只有一个 `dataAbort`；signal 只在 `fetchAllByPK` 循环顶部检查 | 结构元数据阶段不可取消；并发 compare 会覆盖 controller；DB query 本身没有 AbortSignal 传入 |
| Pool 部分构造 | `runCompareRequest`/`runDataCompare` 用 `const [poolA,poolB] = await Promise.all(...)`（`compare-run.ts:80-89`, `data-run.ts:275-279`） | 若一侧先创建、另一侧拒绝，赋值前已创建的 pool 没有句柄可关闭；规范也把它记录为 cleanup gap |
| 隧道生命周期 | tunnel 按 nodeId 永久缓存到 app quit；`closeTunnel` 等待最多 2 秒（`connection.ts:392-427`） | 节点配置/秘密更新不会主动失效旧 tunnel；后台调度、多项目并行与频繁凭据轮换需要更明确的 session scope |
| Secret portability | 自定义导出用本机 master key AES-GCM；换目录/机器解密失败（`vault.ts:274-315`；`vault.test.ts:130-134`） | 适合本机备份，不等于可迁移团队凭据包；CI/服务需独立 secret provider |
| Generated DDL | `diff.ts` 生成结构 SQL 时直接把对象名包在反引号中（`diff.ts:59-60`, `:141-170`） | 执行到 DB 的标识符已转义，但输出 DDL 的对象名转义是独立安全边界；接入更多 dialect 前必须统一处理 |
| Demo fallback | `store.ts:611-629` 真实比较失败后填充 demo 数据 | 离线可演示，但“结果是否来自真实库”不是独立强类型状态；自动化/CI 形态不能直接复用该 renderer action |
| 错误可见性 | 当前无应用 logger/日志文件/严重级别；只有 typed result、IPC Error、toast 与任务证据（`.trellis/spec/backend/logging-guidelines.md:3-15`） | 定时任务、团队服务和 CI 缺少可关联 job/节点/阶段的诊断记录 |
| 更新分发 | builder 只有 Win x64、mac x64/arm64；无签名、公证、autoUpdater（`electron-builder.yml:10-27`） | 团队/长期分发仍需独立发布治理决策；不是 core diff 的扩展问题 |

### 扩展方向所需架构接缝（建议，不是当前事实）

以下是从上述事实推导的**最小接缝判断**；这不是要求立即重构：

1. **方言接缝**：当前 `connection.createMysqlPool`、`metadata.fetchMetadata`、`data-fetch`、`diff.ts` 和 `data-diff.ts` 共同编码 MySQL。只有在至少一个非 MySQL 场景通过验证后，才值得引入 `engine/dialect`、metadata provider、DDL normalizer/diff provider、row reader/literal renderer；否则会把假设固化成平台。
2. **应用服务接缝**：`runCompareRequest` 仍直接依赖具体 `loadNodes`、文件目录和 `Vault`。headless/服务化复用需要一个应用服务合同，接收 node/secret/repository/connection provider，而不是 renderer action 或 Electron IPC。
3. **报告/项目接缝**：当前 `HistoryEntry` 是摘要，不是可恢复 run。保存 baseline/审查包需要版本化 manifest、输入 fingerprint、scope/options、risk policy 与结果引用；不能只把完整 DiffItem 塞进 history JSON。
4. **任务接缝**：现有 compare 是单次同步 `invoke`。调度、CI、取消/重试/进度恢复需要 job id、状态机和持久化进度；Electron `AbortController` 只够当前交互式调用。
5. **存储接缝**：`store-json.ts` 是可测试的本地实现，但不是 repository 接口。团队同步、只读项目文件、SQLite 或服务数据库会改变并发、迁移和秘密边界。

### 可扩展性评分（技术就绪度，不等于产品需求分数）

评分：1 = 需要重写平台；3 = 有可复用主链路但需新增合同；5 = 已有稳定抽象且主要补适配。

| 维度 | 分数 | 依据 |
|---|---:|---|
| MySQL 桌面工作流纵向扩展 | **4.4/5** | core、main、renderer、Vault、历史、导出和测试主链路齐全 |
| 新 MySQL 工作流（基线/策略/报告/大表治理） | **3.8/5** | 可复用 DiffItem/risk/export；缺项目 manifest、策略合同、持久化大结果与任务模型 |
| Headless CLI / 本地 CI | **3.0/5** | 纯 core 可复用，但编排依赖 Electron/文件/Vault  concretes，renderer fallback 不能复用 |
| 转换器生态（DBeaver/DataGrip） | **3.7/5** | 有 `NodeConverter` seam 与 DBeaver 实现；DataGrip 真实 fixture 阻塞，格式随 IDE 版本变化 |
| MariaDB / MySQL-compatible 扩展 | **3.4/5** | transport/UI 可复用较多，但兼容性必须以真实版本 fixture 证明；不能等同 MySQL |
| PostgreSQL / SQL Server / Oracle 等异构数据库 | **1.8/5** | metadata、DDL diff、routine、identifier、literal、分页与权限模型均需方言实现 |
| 团队协作 / 云审计 | **1.5/5** | 本机 Vault + JSON 无身份、权限、共享存储、审计事件和服务运维 |
| 持续调度 / 通知 | **1.9/5** | 有 compare 编排基础，但无 scheduler、job store、凭据轮换、通知与重试语义 |
| 新桌面壳（Tauri） | **1.3/5** | UI 可迁，主进程连接/Vault/IPC/打包需重做；当前无包体或性能痛点证据 |
| **加权总体技术就绪度** | **3.6/5** | 适合继续深化 MySQL 桌面产品；跨数据库和服务化属于架构级扩展，不应伪装成配置开关 |

### 架构建议（与事实分开）

- **[建议]** 把“是否值得支持某数据库”与“如何实现 adapter”分开：先取得目标用户、版本、对象类型、迁移频率和真实 fixture，再决定 adapter 合同。
- **[建议]** 任何新工作流先回答三个问题：是否仍为 A→B 只读比较；输入是实时库还是版本化 baseline；输出是一次性 SQL、审查包还是可追踪 job。
- **[建议]** 继续保留 renderer 无 Node 权限和 secrets 不持久化到 renderer/localStorage 的现有安全边界。
- **[建议]** 把完整结果 IPC、data fallback、全局 compare cancellation、pool partial construction 和打包测试产物列为进入自动化/团队化前的验证门槛。

### 产品决策（不能由代码回答）

- 首要用户是独立开发者、测试/发布人员、DBA，还是需要审计交付的团队？
- 用户要比较实时 A/B，还是“已确认 baseline → 当前环境”的发布前审查？
- 报告是否允许包含 DDL、SQL 字面量、表/列名、节点别名与行数？可否进入工单/CI？
- 是否允许保存行数据或 schema 快照？保存多久、加密密钥在哪里、离职/换机如何处理？
- 首要非 MySQL 数据库及版本是什么？必须支持 routine、trigger、sequence、collation、generated column、partition 等哪些对象？
- CLI/CI 是否允许读取环境变量/系统 keychain 凭据，还是只能接 secret reference？
- 是否接受定时后台连接、通知外发和长期凭据驻留？
- 是否继续坚持“不执行生成 SQL”？这应是产品安全边界，不应被自动化方向隐式改变。

### External References

- 本报告没有新增外部资料；数据库/转换器格式事实以仓库内官方资料研究和当前代码为主。
- 已有外部研究：[DBeaver 格式研究](../../archive/2026-09/09-22-converters/research/dbeaver-connection-import.md) 与 [DataGrip/DataSpell 格式研究](../../archive/2026-09/09-22-converters/research/datagrip-dataspell-connection-import.md)。

### Related Specs

- `.trellis/spec/backend/directory-structure.md` — runtime ownership、main/preload/core 边界。
- `.trellis/spec/backend/database-guidelines.md` — MySQL 只读合同、并发、cleanup、快照方向。
- `.trellis/spec/backend/error-handling.md` — IPC/typed result/partial failure/demo fallback。
- `.trellis/spec/backend/quality-guidelines.md` — Electron 安全、测试与打包门禁。
- `.trellis/spec/backend/logging-guidelines.md` — 当前无 logger 的事实与敏感信息边界。
- `.trellis/spec/backend/dbeaver-export.md` — topology-only 导出合同。
- `.trellis/spec/frontend/state-management.md` — Zustand 状态边界和 demo fallback。
- `.trellis/spec/frontend/quality-guidelines.md` — CDP E2E 能力与限制。

## Caveats / Not Found

- `task.py current --source` 在子会话中返回 `(none)`；任务目录由主会话明确指定为 `.trellis/tasks/09-24-product-expansion-roadmap`，本报告仅写入该目录的 `research/`。
- 没有发现 CI 配置、coverage 配置、可提交 E2E harness、server/API、ORM、migration framework 或 telemetry。
- 没有真实客户访谈、付费/使用数据、生产 schema 分布或性能基线；评分只代表技术就绪度。
- 没有在本报告中启动真实数据库/SSH；环境事实来自已有任务报告。