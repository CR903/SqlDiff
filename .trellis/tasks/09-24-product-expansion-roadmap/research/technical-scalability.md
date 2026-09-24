# Research: Electron / React / Node / MySQL 技术可扩展性

- **Query**: 服务器重启后重新评估当前 SqlDiff Electron/React/Node/MySQL 架构的扩展性：模块边界、纯 core/main/renderer、数据模型、测试/E2E、连接/安全/资源管理瓶颈、新数据库/工作流/部署形态、实现成本和风险；给出可扩展性评分与分阶段技术路线。
- **Scope**: internal（当前源码、测试、构建配置、Trellis specs、历史任务报告）+ external（Electron、Node.js、mysql2、ssh2、PostgreSQL 官方文档）
- **Date**: 2026-09-24
- **证据标记**: `FACT` = 当前文件/测试/报告直接观察；`INFERENCE` = 从事实推导；`RECOMMENDATION` = 为路线决策提供的条件式建议，不是当前已实现能力；`HYPOTHESIS` = 仍需用户/环境验证的假设。

## Findings

### 结论摘要

- **[FACT·高置信]** 当前产品是一个单包 Electron 桌面应用：`apps/desktop/package.json:2-16` 将 Vite renderer、TypeScript main 编译和 Electron 打包放在同一应用；`.trellis/spec/backend/index.md:1-3` 明确这里没有 HTTP server、ORM 或数据库 migration layer。运行时链路是 `renderer → preload/contextBridge → Electron main → MySQL/SSH → pure core`。
- **[FACT·高置信]** 进程边界已经有清晰起点：renderer 没有直接运行时导入 `electron`、`node:*`、`mysql2` 或 `ssh2`，`SqlDiffApi` 在 `src-main/preload.ts:66-150` 暴露专用方法；main 在 `src-main/main.ts:367-380` 设置 `contextIsolation: true`、`nodeIntegration: false`。
- **[FACT·高置信]** “纯 core”主要是确定性比较/过滤/分类/风险函数，而不是完整数据库抽象。`src-core/compare.ts:104-173`、`diff.ts:46-242`、`data-diff.ts:30-143` 消费 MySQL `SHOW CREATE` 文本或 MySQL 行值；`DatabaseMetadata` 仍由 `src-main/metadata.ts:26-32` 定义，core 通过 `import type` 反向引用 main 目录。
- **[FACT·高置信]** 当前可扩展性的主要硬边界是数据和编排：单次 `CompareResult` 携带完整 `items`，`fetchAllByPK` 将整表放进内存，renderer 持有并映射完整结果；没有 job、增量结果、stream、repository 或可移植的 secret provider 合同。证据：`src-main/data-fetch.ts:105-134`、`src-core/data-diff.ts:89-142`、`src-core/types.ts:202-207`、`src-renderer/store.ts:173-177`、`src-renderer/App.tsx:617-646`。
- **[INFERENCE·高置信]** 在不改变目标数据库的前提下，最有价值的技术路线是先验证 MySQL 纵向工作流和安全/资源门槛，再把同一比较服务从 Electron host 中抽离；跨数据库、团队云服务、持续调度和 Tauri 属于条件式架构扩展，不是一个连接选项或 UI 开关。
- **[RECOMMENDATION]** 路线顺序：证据与契约冻结 → MySQL 迁移审查/大表数据治理 → host-neutral headless runner → 在真实 fixture 和用户证据后选择一个跨方言或平台边界。每一阶段都必须保留 A→B、只读、不执行生成 SQL 的现有产品合同。

### 1. 评估口径与可复核基线

#### 1.1 当前源码规模与测试门禁

| 项目 | 当前事实 | 证据 |
|---|---|---|
| 应用形态 | Electron + Vite + React + TypeScript；main 产物为 CommonJS，renderer 产物为 Vite bundle | `apps/desktop/package.json:5-16`；`apps/desktop/vite.config.ts:3-10`；`apps/desktop/tsconfig.main.json:1-10` |
| 源码层 | `src-main` 为 Node/Electron，`src-core` 为共享逻辑，`src-renderer` 为浏览器 UI | `apps/desktop/README.md:39-66`；`.trellis/spec/backend/directory-structure.md:7-31` |
| 当前自动测试 | 本次从 `apps/desktop` 运行 `npm test -- --reporter=dot`：17 个 test files、167 tests passed；`npm run typecheck` 和 `npm run lint` 也通过 | 运行命令输出（2026-09-24）；测试入口 `apps/desktop/vitest.config.ts:1-5` |
| 构建/发布证据 | 归档 E2E 记录了 `tsc`、lint、159 tests 和双平台包核验；研究采集阶段没有再次运行会写 `dist-*`/`release` 的 build/pack，本次 Check Agent 质检阶段另行运行了 `npm run build`（未运行 pack） | `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:68-76,101-111` |
| 依赖 | package.json 声明 Node `>=20`、Electron 34、React 18、mysql2 3、ssh2、Zustand、Vite、Vitest；lock 当前解析到 Electron 34.5.8、mysql2 3.24.4、ssh2 1.17.0、TypeScript 5.9.3、Vitest 3.2.7 | `apps/desktop/package.json:18-43`；`apps/desktop/package-lock.json:4414-4431,6685-6705,7975-7990,8396-8408,8645-8684` |

#### 1.2 评分定义

本报告同时给出两个分数，避免把“当前 MySQL 产品完成度”和“跨平台平台化能力”混为一谈：

- **当前产品技术分**：当前已交付的单机 MySQL 桌面闭环能否继续加深。
- **平台扩展分**：在不重写大量运行时的情况下，新增数据库、自动化工作流或部署形态的承载能力。
- 评分含义：`1` = 需要重写平台；`2` = 需较大边界重建；`3` = 现有主链路可复用但要新增明确合同；`4` = 已有稳定 seam、主要补适配和验证；`5` = 已有完整抽象且主要是配置/适配。
- 分数是**技术就绪度**，不是用户价值、需求频率、市场规模或实现排期承诺。

### 2. 当前架构与模块边界

#### 2.1 运行链路

```text
React renderer (src-renderer)
  └─ window.sqldiff (src-main/preload.ts, contextBridge)
       └─ Electron main handlers (src-main/main.ts)
            ├─ Vault + nodes.json/history.json
            ├─ connection.ts ── mysql2/promise Pool
            │                  └─ ssh2 one-hop local forward
            ├─ metadata.ts ── information_schema + SHOW CREATE
            ├─ data-fetch.ts ─ COUNT(*) + keyset SELECT *
            ├─ compare-run.ts / data-run.ts ─ orchestration
            └─ src-core ─ deterministic diff/filter/classify/risk/export
```

**FACT**：main 的 composition root 负责生命周期、窗口、IPC、下载、剪贴板和 shutdown；比较/数据比较已分别委托给 `compare-run.ts` 与 `data-run.ts`。证据：`src-main/main.ts:35-39,277-359`；`src-main/compare-run.ts:53-65`；`src-main/data-run.ts:251-321`。

**INFERENCE**：当前边界足以承载“一次桌面交互式比较”，但还不是一个可被多个宿主调用的 application service：`runCompareRequest` 和 `runDataCompare` 都直接从具体 user-data 目录加载节点、从具体 `Vault` 取 secret。证据：`src-main/compare-run.ts:32-35,74-83`；`src-main/data-run.ts:29-32,269-279`。

#### 2.2 各层职责与可复用程度

| 层/模块 | 当前职责 | 已形成的 seam | 扩展性判断与证据 |
|---|---|---|---|
| `src-core/types.ts` | `NodeMeta`、`SecretBundle`、`DiffItem`、`CompareRequest`、`CompareResult`、`HistoryEntry` 等共享类型 | 跨 main/renderer 的单一类型来源 | **中等**。适合共享输出，不足以表达 dialect/version/provenance/job/manifest；见 `src-core/types.ts:41-207`。 |
| `src-core/compare.ts` | metadata → `DiffItem[]`、统计、排序、SQL 文本 | `compareRun` / `sortDiffItems` / `toExportSql` | **MySQL 专用**。输入是 `DatabaseMetadata` 的 DDL 文本 map；见 `src-core/compare.ts:7-11,100-173`。 |
| `src-core/diff.ts` | legacy-compatible 表/例程文本 diff 和 DDL 生成 | 纯函数 `diffTable`、`diffProcedure`、`splitStatements` | **窄而可测**。用 `split/replace/正则` 解析 MySQL `SHOW CREATE`，不是方言无关 AST；见 `src-core/diff.ts:24-44,81-175,177-242`。 |
| `src-core/data-*` | PK/UNIQUE 身份、keyset row diff、INSERT/DELETE/UPDATE、选项归一化 | `decideIdentity`、`diffDataRows`、`fetchPageByPK` 周围的纯函数 | **MySQL 值/标识符语义**。反引号、NUL key、MySQL literal 和 `Buffer.toString('utf8')` 固定在实现中；见 `src-core/data-diff.ts:30-143`、`src-core/data-pk.ts:17-143`。 |
| `src-main/connection.ts` | MySQL pool、SSH config、tunnel cache、连接测试 | `createMysqlPool`、`ensureTunnel`、`testConnection`、`TunnelClient` fake | **局部可注入，平台不可移植**。driver、认证、TLS/SSL 字段和 pool 生命周期均在此具体实现；见 `src-main/connection.ts:55-103,127-147,301-390`。 |
| `src-main/metadata.ts` | MySQL object list + `SHOW CREATE` 快照 | `DbQueryable` 最小 query 接口、`fetchMetadata` | **适合 fake/unit test，不等于 adapter**。SQL 常量和返回 shape 直接写死 MySQL；见 `src-main/metadata.ts:16-39,41-138,170-203`。 |
| `src-main/data-fetch.ts` | COUNT、keyset 分页、阈值、AbortSignal | `fetchPageByPK`、`fetchAllByPK`、`DataThresholdError` | **I/O 形状可测，规模策略固定**。读取结果仍 materialize；见 `src-main/data-fetch.ts:49-135`。 |
| `src-main/compare-run.ts` | A/B pool、metadata、结构/数据 compare、history | `CompareRunContext`、table/fetch hooks | **可作为宿主无关化的起点，但 concrete dependency 仍在**。见 `src-main/compare-run.ts:32-45,61-141`。 |
| `src-main/data-run.ts` | 逐表状态、身份决策、fetch + data diff、取消 | `DataRunContext`、`DataRunOptions`、`onTable`/`onFetchProgress` | **可复用编排意图，但再次直接加载 nodes/Vault**。见 `src-main/data-run.ts:29-53,168-320`。 |
| `src-main/vault.ts` | safeStorage/AES-GCM、per-node secret、加密导入导出 | `Vault`、`SafeStorageLike` | **本机秘密边界清楚，跨机器/服务不可移植**。导出由本机 master key 解密；见 `src-main/vault.ts:183-315`。 |
| `src-main/store-json.ts` | nodes/history 同步 JSON、原子 rename、损坏回空 | `loadNodes/saveNodes/loadHistory/appendHistory` | **单机 repository 事实，不是可迁移 repository 合同**。见 `src-main/store-json.ts:34-115`。 |
| `src-main/preload.ts` | typed renderer bridge、progress subscription | `SqlDiffApi`、`CompareProgressEvent` | **新增能力的同步点**。结果类型通过 `ipcRenderer.invoke` 断言为 Promise，没有运行时 schema；见 `src-main/preload.ts:21-64,66-150`。 |
| `src-renderer/store.ts` | Zustand 单一共享状态、IPC actions、demo fallback | `useDesktopStore` actions | **适合当前三栏，新增工作流会集中化**。interface/action 定义从 `src-renderer/store.ts:138-229` 开始。 |
| `src-renderer/App.tsx` | composition root、所有局部组件、过滤派生、SQL preview、modal | 组件仍是文件内函数 | **维护/渲染边界较集中**。`rows.map` 全量渲染差异，`App` 同时组合所有面板；见 `src-renderer/App.tsx:68-70,617-646,1379-1783`。 |
| Build/packaging | Vite renderer + tsc main + electron-builder | `dist-renderer` / `dist-main` 输出 | **构建边界明确，但测试编译产物和未使用依赖进入发布面**。见 `apps/desktop/tsconfig.main.json:4-10`、`electron-builder.yml:6-9`。 |

#### 2.3 Core 依赖方向的边界事实

- **FACT**：`src-core/compare.ts:7`、`compare-filter.ts:6` 和 `demo.ts:5` 以 `import type` 引用 `src-main/metadata.ts` 的 `DatabaseMetadata`。这在当前 Vite/TypeScript 构建中不会把 Node runtime 拉进 renderer，但 core 的类型所有权仍反向依赖 main 目录。
- **FACT**：`src-core/vault.test.ts:1-17` 是明确的存储测试例外，直接测试 `src-main/vault.ts` 和 `src-main/store-json.ts`；core 并非完全独立 package。
- **INFERENCE**：抽取 headless/CLI 时，纯算法文件可直接复用，但需要先把 metadata 类型/输入合同从 main 目录中分离，或者接受一个明确的 host-adapter import；否则每个新宿主都会复制同一 DDL model。

#### 2.4 React/Node host 边界

- **FACT**：renderer 是 React 18 的单入口 `createRoot` + `StrictMode`，没有 router、页面目录或组件库；所有生产组件仍在 `App.tsx` 文件内。证据：`src-renderer/main.tsx:1-13`、`.trellis/spec/frontend/index.md:1-14`、`src-renderer/App.tsx:68-70`。
- **FACT**：`App` 用 `useMemo` 派生过滤链，并将同一个 `tabItems` 传给差异表和 SQL 预览；这保持了当前“复制=所见”的语义，但过滤结果仍是完整数组。证据：`src-renderer/App.tsx:1475-1559,1726-1759`。
- **FACT**：当前没有 `React.memo`、windowing/virtualization、分页 renderer 或 `react-window` 类依赖；差异行直接 `.map` 到 `<tbody>`。证据：`src-renderer/App.tsx:617-646` 与源码依赖搜索结果。
- **FACT**：Node/Electron runtime 依赖集中在 main：`node:crypto/fs/path/net`、`mysql2/promise`、`ssh2`；当前源码没有 `worker_threads`、`child_process`、Electron `utilityProcess` 或独立 Node worker 入口。证据：`src-main/connection.ts:12-15`、`src-main/vault.ts:14-17`、`src-main/compare-run.ts:9-30` 与源码搜索结果。
- **INFERENCE**：React 当前的规模边界主要来自全量 state/DOM/SQL 文本处理；Node 当前的执行边界主要来自 main event loop 同时承担 DB I/O、diff CPU、IPC 和文件持久化。这个判断不等于已经观察到生产 OOM，只说明代码形状决定了未来大结果的扩展位置。

### 3. 数据模型与数据流扩展性

#### 3.1 当前模型矩阵

| 模型 | 当前形状 | 可直接复用的部分 | 当前没有表达的扩展维度 | 证据 |
|---|---|---|---|---|
| `NodeMeta` | `host/port/user/database`、一个 `SshConfig`、alias/group/tags/star/pinned/useCount | MySQL 直连/单跳 SSH 节点、桌面节点库 | engine/dialect、server version、TLS/SSL、CA、proxy、read-only policy、credential source、schema/project 归属 | `src-core/types.ts:41-70` |
| `SecretBundle` | `password`、`sshPassword`、`privateKey`、`passphrase` 四个可选字符串 | 本机 safeStorage/AES-GCM 保存 | token expiry/refresh、云 IAM、证书链、secret reference、key rotation | `src-core/types.ts:72-85`；`src-main/vault.ts:210-264` |
| `DatabaseMetadata` | `tables/views/procedures/functions` 四张 `name → SHOW CREATE or null` map | MySQL 表/视图/例程快照，null 表示读取失败 | schema/catalog、版本、trigger/event/sequence/type、约束/外键/分区、规范化 AST、provenance | `src-main/metadata.ts:21-32,170-203` |
| `DiffItem` | 单条 `sql` + object/change/aspect/risk/explain/rollback | 过滤、统计、风险展示、SQL 导出 | dialect、source/target version、operation kind、object identity、raw/normalized、policy result、证据 hash | `src-core/types.ts:87-104` |
| `CompareRequest` | 一个 A id、一个 B id、scope/tableFilter、dataTables/options | 一次 A→B 只读比较 | 多目标、baseline id、project/run id、异步 job、优先级、重试、预算、secret provider | `src-core/types.ts:139-184` |
| `CompareResult` | 完整 `items[]`、stats、可选 dataTables | 当前 renderer 的同步结果 | 分页/流式 chunk、结果引用、输入 fingerprint、部分失败状态机、报告 manifest | `src-core/types.ts:192-207` |
| `HistoryEntry` | 20 条摘要：时间、A/B alias/id、diffCount | 桌面最近运行列表 | scopes、options、filters、policy、结果、baseline、review/approval、失败记录 | `src-core/types.ts:118-128`；`src-main/store-json.ts:12-13,98-115` |
| 本地文件 | `nodes.json`、`history.json`、per-node encrypted secret | 单机持久化/秘密隔离 | schema migration、并发 repository、锁、事务、租户、共享/冲突解决 | `src-main/store-json.ts:1-7,34-50,84-115`；`src-main/vault.ts:150-223` |

#### 3.2 结构与数据语义的事实边界

- **FACT**：结构 diff 是 legacy text-compatible，而不是完整 MySQL schema parser。`filterTable` 忽略若干表选项，`diffTableField` 逐行识别 column、`PRIMARY KEY` 和以 ``KEY ` `` 开头的索引；见 `src-core/diff.ts:24-44,81-175`。源码没有独立的 foreign key/check/partition/generated/trigger/event/sequence 模型；grep 结果只在注释中出现 `CONSTRAINT` 字样。
- **FACT**：视图/过程/函数保持一个原子 `DiffItem`，只有表输出会按 `;\n` 拆成多条；见 `src-core/diff.ts:65-79`、`src-core/compare.ts:51-61`。
- **FACT**：数据身份优先 PK，再接受两侧相同的全列显式 `NOT NULL` UNIQUE；无可用身份时跳过行级 diff，身份列集不一致时返回 `pk-mismatch`。见 `src-main/data-run.ts:121-166,185-210`；测试 `src-main/data-run-identity.test.ts:52-125`。
- **FACT**：行 diff 的 INSERT 使用第一行的 `Object.keys(rows[0])` 生成 values 顺序，不写显式 column list；UPDATE 按 A 行对象键比较。证据：`src-core/data-diff.ts:75-81,126-135`。
- **FACT**：Buffer 走 `toString('utf8')`，没有二进制 literal、hash、长度上限或截断字段；见 `src-core/data-diff.ts:48-68`。数据 diff 测试覆盖了字符串/NULL/数字，但没有 BLOB 或跨驱动类型矩阵；见 `src-core/data-diff.test.ts:44-101`。
- **INFERENCE**：当前 `DatabaseMetadata → raw DDL → DiffItem.sql` 链路可以作为 MySQL 兼容实现，但不能被当作 PostgreSQL/SQL Server/Oracle 的 normalized schema model；新数据库需要在 metadata、DDL semantics、identity、literal、formatter 和测试 fixture 层同时有明确边界。

#### 3.3 持久化与结果生命周期

- **FACT**：`store-json.ts` 使用同步 `readFileSync/writeFileSync`，通过临时文件 + rename 原子替换；JSON 损坏时读为空 fallback，而不是迁移/提示。证据：`src-main/store-json.ts:34-50,84-115`。
- **FACT**：`runCompareRequest` 成功后 best-effort 写一条 `HistoryEntry`，不保存完整结果、scope 或 options；见 `src-main/compare-run.ts:121-134`。
- **FACT**：renderer 只把最后 A/B id 写入 `sqldiff.lastCombo`；不把 nodes/history/results 写入 localStorage。见 `src-renderer/store.ts:54,106-126`。
- **INFERENCE**：本地文件模型适合“一个用户、一个窗口、一次运行”的桌面形态；项目/基线/报告交接需要额外的 versioned manifest 或独立 repository，但当前没有该对象。

### 4. 连接、并发与资源管理

#### 4.1 连接层

- **FACT**：MySQL 直连和 SSH 隧道最终都返回 `mysql2/promise` `Pool`；`createMysqlPool` 固定 `connectionLimit: 5`、`waitForConnections: true`、`queueLimit: 0`。见 `src-main/connection.ts:301-318`。
- **FACT**：SSH 支持 password 或 privateKey+passphrase，隧道按 `nodeId` 缓存，并用 `inflight` Map 合并并发 `ensureTunnel`；端口为 32000–35000，`EADDRINUSE` 最多重试 10 次。见 `src-main/connection.ts:17-25,55-85,140-142,228-291`。
- **FACT**：连接配置没有 `ssl`/TLS、CA、server name、socket path、proxy、字符集、server version 或 pool policy 字段；`NodeMeta` 和 `buildMysqlConfig` 也没有这些字段。见 `src-core/types.ts:41-70`、`src-main/connection.ts:88-103`。
- **FACT**：`buildSshConnectConfig` 设置 host/port/user/auth/readyTimeout/keepalive，但没有设置 `hostVerifier` 或 known-host 状态。ssh2 官方配置文档说明未设置 `hostVerifier` 时 host key 会 auto-accept；因此当前代码没有应用层 SSH host identity verification。证据：代码 `src-main/connection.ts:60-85`；官方文档 <https://github.com/mscdex/ssh2/blob/master/README.md>（`hostVerifier` 条目）。
- **INFERENCE**：单跳、密码/私钥、MySQL 直连的节点模型对当前桌面场景足够；多跳、TLS、云 IAM、代理、证书轮换或无人值守任务会改变 `NodeMeta`、`SecretBundle`、连接缓存和错误合同，不能只新增 UI 字段。

#### 4.2 Metadata 并发模型

- **FACT**：`fetchMetadata` 先并行取 tables/views/routines，再对四类对象分别调用 `mapWithLimit`；`MAX_CONCURRENCY=10` 是每个 object-category map 的 worker 数。见 `src-main/metadata.ts:13-14,140-203`。
- **FACT**：A/B metadata fetch 也并行；每个 pool 最多 5 个 active connection，而四类 map 各自最多 10 个等待 worker，pool `queueLimit=0` 不设队列上限。见 `src-main/compare-run.ts:83-89`、`src-main/metadata.ts:191-196`、`src-main/connection.ts:306-318`。
- **INFERENCE**：两库合计最多约 10 个 active MySQL connection（每库 pool limit 5），但每个库可能同时排队大量 `SHOW CREATE` 请求；`MAX_CONCURRENCY` 不是全局数据库负载预算。增加多目标、后台任务或服务器端 job 时，不能直接复用该常量解释全局并发。
- **FACT**：单个 `SHOW CREATE` 失败被转换为 `null`，`compareRun` 跳过该对象，避免把权限失败误报为 CREATE/DROP；见 `src-main/metadata.ts:190-201`、`src-core/compare.ts:63-69,111-138`，测试 `src-main/metadata.test.ts:148-180`。

#### 4.3 数据读取、CPU 与内存

- **FACT**：`fetchAllByPK` 先 `COUNT(*)`，再循环 keyset page；每页 push 到同一个 `out: DataRow[]`，完成后返回整表。见 `src-main/data-fetch.ts:105-134`。
- **FACT**：`runSingleTable` 同时持有 `rowsA` 与 `rowsB`，随后 `diffDataRows` 为两侧建立 Map 和 key 数组；见 `src-main/data-run.ts:213-233`、`src-core/data-diff.ts:89-142`。
- **FACT**：表与表之间串行，单表 A/B 读取并行；这限制了跨表同时 materialize 的数量，但不限制单表峰值。证据：`src-main/data-run.ts:286-313`。
- **FACT**：默认 `batchRows=1000`、`insertBatch=500`、`threshold=100000`，范围分别在 `data-options.ts:7-23` 固定；threshold 只控制“超过后二次确认”，不是内存上限或磁盘 spill。
- **FACT**：`insertBatch` 只把 INSERT rows 分成多条 SQL；不会降低 `fetchAllByPK` 的整表数组。见 `src-core/data-diff.ts:75-81,138-142` 与 `src-core/data-options.ts:57-77`。
- **INFERENCE**：单表峰值内存是 `O(A rows + B rows + SQL strings + DiffItems)`；宽表、BLOB、百万行和多次过滤/导出会造成 main heap、IPC structured clone、renderer heap 一起增长。现有 threshold 不能被解释为任意大表安全保证。

#### 4.4 结果传输与 renderer 规模

- **FACT**：`compare.run` 通过一次 `ipcRenderer.invoke` 返回完整 `CompareResult`；renderer 将 `result.items` 直接放入 Zustand `items`。见 `src-main/preload.ts:91-96,131-138`、`src-renderer/store.ts:173-177,555-590`。
- **FACT**：`DiffTable` 对 `rows` 直接 `.map` 全量渲染，没有 virtualization、windowing 或分页组件；见 `src-renderer/App.tsx:617-646`。
- **FACT**：`SqlPreview` 对当前 `tabItems` 一次性 `buildExportText`，再对完整 export text 做 `highlightSql`；见 `src-renderer/App.tsx:896-907`、`src-renderer/sql.ts:29-65`。
- **INFERENCE**：随着数据 diff 增大，瓶颈不只在 SQL 查询，还在 main→IPC→renderer 的复制、Zustand 更新、全量 DOM、字符串格式化和高亮；这解释了为什么“分页已存在”不等于端到端可扩展。

#### 4.5 取消、并发 job 与 cleanup

- **FACT**：main 只有一个全局 `dataAbort` controller；每次 `compare.run` 覆盖它，`compare.cancel` 只 abort 当前 controller。证据：`src-main/main.ts:280-287,316-338`。
- **FACT**：`AbortSignal` 只在 `fetchAllByPK` 每页循环顶部检查；metadata/结构阶段没有对应取消路径，且 SQL query 没有接收 signal。证据：`src-main/data-fetch.ts:97-103,125-132`；UI 文案 `src-renderer/App.tsx:480-487`。
- **FACT**：正常路径在 `finally` 中 `Promise.allSettled` 关闭已赋值的 pools；但 `Promise.all` 的结果要等两边 settle 后才赋给解构变量，若一边已创建 pool、另一边失败，当前代码没有可关闭的引用。证据：`src-main/compare-run.ts:80-89,139-141`、`src-main/data-run.ts:275-279,314-316`；项目 spec 也将其记录为 cleanup gap：`.trellis/spec/backend/database-guidelines.md:27-31`。
- **FACT**：`before-quit` 启动 `closeAll()` 但不等待；`closeTunnel` 按 nodeId 关闭，而 main 的节点 update/delete 路径没有调用 `closeTunnel`。证据：`src-main/main.ts:162-189,408-411`、`src-main/connection.ts:392-427`。
- **INFERENCE**：交互式单次运行可以接受“一个当前 controller”；无人值守调度、并行 job、凭据轮换和重试需要 run-scoped cancellation、显式 session ownership 和可恢复状态，否则全局 controller 与 tunnel cache 会把生命周期耦合到窗口。

### 5. 安全、隐私与发布边界

#### 5.1 已有的信任边界

- **FACT**：renderer 无 Node runtime import，专用 preload API 是唯一 bridge；见 `src-main/preload.ts:1-14,108-150` 与 `.trellis/spec/backend/quality-guidelines.md:18-25`。
- **FACT**：`nodes.json`/`history.json` 只存 metadata；secret 进入 `Vault`，优先 safeStorage，不可用时 AES-256-GCM，文件权限尝试设为 0600。见 `src-main/store-json.ts:1-7`、`src-main/vault.ts:39-106,150-223`。
- **FACT**：DBeaver exporter 只接收 `NodeMeta`，不调用 Vault、不接收 `SecretBundle`；输出 `save-password:false`，私钥只给 warning。证据：`src-main/main.ts:218-222`、`src-main/converters/dbeaver.ts:137-194`、测试 `src-main/converters/dbeaver.test.ts:50-143`。
- **FACT**：应用内没有执行 `DiffItem.sql`/`DataDiffResult` 的 pool 调用；只读 SQL 集中在 connection/metadata/data-fetch。证据：`src-core/data-diff.ts:1-4`、`src-main/data-run.ts:7-8`、`.trellis/spec/backend/database-guidelines.md:15-23`。
- **FACT**：没有持久化 logger；诊断是 typed result、IPC error、toast、status 和任务证据。生成 SQL、行值、DDL、secret 不写 runtime log。证据：`.trellis/spec/backend/logging-guidelines.md:3-33`。

#### 5.2 Electron 边界事实与新增宿主风险

- **FACT**：`createWindow` 显式设置 `contextIsolation:true`、`nodeIntegration:false`，但没有显式 `sandbox:true`、CSP、sender allowlist、`will-navigate` 或 `setWindowOpenHandler`；`index.html:1-12` 没有 CSP meta。见 `src-main/main.ts:367-387`、`apps/desktop/index.html:1-12`。
- **FACT**：生产默认加载本地 `dist-renderer/index.html`；开发环境可由 `VITE_DEV_SERVER_URL` 加载 URL。见 `src-main/main.ts:363-387`。
- **FACT**：preload 只暴露专用方法，不暴露 raw `ipcRenderer`；这符合 Electron contextBridge 的最小 API 模式，见 `src-main/preload.ts:108-150`。
- **INFERENCE**：当前“只加载本地 renderer + 不显示远程内容”的产品边界降低了上述缺口的现实暴露面；一旦加入远程帮助页、插件 UI、团队 web view 或外部链接，Electron 官方安全清单中的 CSP、sender validation、navigation/new-window 限制会成为新的 host contract。官方参考：<https://www.electronjs.org/docs/latest/tutorial/security>。
- **FACT**：主进程 `conn.test` 接受 renderer 传入的 `{node, secret}`，新节点保存也经同一 IPC；main 做部分字段校验，但 TypeScript 类型在运行时不存在。见 `src-main/main.ts:86-118,200-207`、`src-main/preload.ts:21-49`、`.trellis/spec/frontend/type-safety.md:17-31`。

#### 5.3 数据库与输出安全

- **FACT**：执行到数据库的 schema/value 使用参数化，执行标识符使用 `escapeIdent`；生成 DML 另用 `escapeDataIdent`/`sqlLiteral`。见 `src-main/metadata.ts:45-55`、`src-main/data-fetch.ts:33-42,78-82`、`src-core/data-diff.ts:36-68`。
- **FACT**：legacy structural DDL builder 仍直接把对象名放入反引号；项目 spec 将其标为独立输出安全边界，不把它描述成已完成的 hardening。见 `src-core/diff.ts:59-60,141-170`、`.trellis/spec/backend/database-guidelines.md:7-13`。
- **FACT**：SQLite/其他 DB、cloud IAM、certificate、token refresh 和 DB session read-only 设置没有出现在 `NodeMeta`/`SecretBundle`/connection config；当前只读是应用查询集合和权限约定的结果，不是应用主动设置的事务只读状态。
- **FACT**：SQL、JSON、DBeaver topology 和 history 都可能包含数据库名、对象名、DDL 或行值；当前没有报告脱敏字段或按角色的 redaction policy。证据：`src-core/compare.ts:156-173`、`src-renderer/sql.ts:101-125`、`.trellis/spec/backend/logging-guidelines.md:21-29`。
- **INFERENCE**：本地 Vault 能保护 secret 文件，但不能自动解决报告、CI artifact、通知、团队共享中的敏感数据边界；任何自动化/协作路线都必须先定义哪些字段可离开 user-data。

#### 5.4 发布与分发

- **FACT**：builder 只配置 Windows x64 NSIS、macOS x64/arm64 DMG；没有 Linux target、签名、公证或 updater 配置。见 `apps/desktop/electron-builder.yml:1-27`、`.trellis/spec/backend/quality-guidelines.md:56-65`。
- **FACT**：最新包核验记录 macOS arm64/x64 与 Windows NSIS 产物，Windows 只做 PE/资源核验，没有 Windows 原生启动；包未签名。见 `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:101-111`。
- **FACT**：`tsconfig.main.json` 的 include 覆盖 `src-main` 与 `src-core`，没有排除 `*.test.ts`；当前 `dist-main` 可见 15 个 `*.test.js`，而 `electron-builder.yml` 包含 `dist-main/**/*`。见 `apps/desktop/tsconfig.main.json:4-10`、`apps/desktop/electron-builder.yml:6-9`、2026-09-24 对 `apps/desktop/dist-main` 的文件清单检查。
- **FACT**：`monaco-editor` 是 production dependency，但 renderer 实际使用 `<pre>` 高亮；工作树中已有的 Windows `app.asar` 检查可见 `node_modules/monaco-editor` 条目和已生成的 test JS 条目。证据：`apps/desktop/package.json:18-23`、`src-renderer/sql.ts:1-3`、2026-09-24 对 `release/win-unpacked/resources/app.asar` 的 asar 清单检查。该 release artifact 可能是历史构建，不等同于本次重新 build；事实只说明发布输入与运行时使用面不完全相同。
- **INFERENCE**：发布体积、测试代码和未使用依赖不是当前 diff 正确性的主问题，但会成为签名、下载、更新和 CI 成本；是否清理应作为发布工程决策，不应与数据库扩展混成一个任务。

### 6. 测试与 E2E 扩展性

#### 6.1 当前自动化覆盖

- **FACT**：Vitest 收集 core/main/renderer 三层的 `*.test.ts`；本次 17 files/167 tests 全绿。见 `apps/desktop/vitest.config.ts:1-5` 与本次命令输出。
- **FACT**：结构/过滤/风险/数据值有较密集纯函数测试：`src-core/diff.test.ts`、`ddl-dml-index.test.ts`、`verb-search.test.ts`、`data-diff.test.ts`、`data-unique.test.ts`。
- **FACT**：连接测试明确只覆盖纯配置和 tunnel cache，建连路径交给手工 smoke；见 `src-main/connection.test.ts:1-2,137-158`。
- **FACT**：`data-fetch.test.ts` 只断言单页/联合主键 SQL 和 `nextKey`，没有 `fetchAllByPK` 多页循环、threshold、AbortSignal、内存或真实 mysql2 行为；见 `src-main/data-fetch.test.ts:1-39`。
- **FACT**：`data-run-identity.test.ts` 只测 `decideIdentity` 纯函数；没有 `runDataCompare` 的逐表异常、pool cleanup、progress 或取消测试；见 `src-main/data-run-identity.test.ts:1-125`。
- **FACT**：没有 `main.ts`、`preload.ts`、`compare-run.ts`、`store.ts`、`App.tsx` 的同名自动化测试；renderer 规范明确没有 React Testing Library/jsdom/snapshot/a11y automation。见 `.trellis/spec/frontend/quality-guidelines.md:12-20` 与当前测试文件清单。
- **FACT**：项目没有发现 coverage 配置、CI workflow 或持久化 E2E harness；CDP harness 被记录为临时目录。最新报告写明原始 clipboard/Downloads/temp user-data 日志未入库。见 `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:51-58`。

#### 6.2 真实环境证据与缺口

- **FACT**：最新 CDP E2E 记录 22 个动作，覆盖节点 CRUD、demo、Docker MySQL 8 结构/数据、过滤、复制/导出、secret 文件和快捷键；见 `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:22-49`。
- **FACT**：同一报告明确指定内网真库未完成、Windows 真机未启动、T1 空库冷启动没有独立证据；见 `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:14-20,49-58`。
- **FACT**：历史 smoke 证明 515/516 表的 MySQL 直连和 521 项结构 diff；行级 `buildings` 表有 1/27 行真实只读证据，但没有大表内存基准。见 `.trellis/tasks/archive/2026-09/09-21-desktop-m7-smoke/smoke-report.md:14-24`、`.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md:15-26`。
- **FACT**：SSH 密码认证与 22 端口有部分真机证据，但转发被服务端拒绝，私钥通道未闭环；见 `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md:5-13,28-33`。
- **INFERENCE**：当前测试足以保护已实现的 MySQL 纯逻辑和小型 fixture 闭环，不足以证明任意 schema 方言、百万行数据、后台任务、CI 退出码、Windows 原生包或多用户安全边界。

#### 6.3 扩展前需要的验证资产（RECOMMENDATION，不是当前事实）

以下是路线阶段的验证门槛，不是对现有代码的修改建议：

1. 每个拟支持数据库至少有结构/数据/routine/权限/错误 fixture，并记录 server version。
2. 每个工作流至少有同一输入在 GUI、headless runner、导出报告之间的结果一致性断言。
3. 性能实验记录表数、行数、宽列/BLOB 比例、峰值 RSS、SQL 数、取消延迟和 DB 端压力，而不是只记录“比较成功”。
4. 安全实验覆盖 secret 不进 renderer/localStorage/report/log、SSH host identity、TLS/证书失败、renderer 输入校验、drop 风险确认和生成 SQL 不执行。
5. 失败、部分成功、取消、重试、job 恢复必须有独立状态和测试，而不只由 demo fallback 或 toast 表示。

### 7. 扩展方向的成本与风险矩阵

> 成本是相对工程量级，不是排期承诺：S≈小型独立切片，M≈1 个边界清晰的迭代，L≈多个适配器/状态模型，XL≈平台级拆分。是否值得做仍需用户证据。

| 方向 | 可复用基础 | 新增/不可直接复用的边界 | 成本 | 风险 | 技术就绪度 |
|---|---|---|---:|---|---:|
| MySQL 基线/迁移审查包 | `DiffItem`、risk/rollback、SQL export、history | versioned project/run manifest、输入 fingerprint、review status、结果引用、隐私字段 | M | 快照陈旧、DDL/行值泄露、报告被误当执行证明 | **4.0/5** |
| MySQL 大表/BLOB/无主键治理 | keyset、threshold、cancel、PK/UNIQUE identity | 流式/分块/spill、列选择、二进制策略、重采样/解释、资源预算 | M–L | 内存、DB 压力、结果完整性、敏感值 | **3.2/5** |
| 本机 headless CLI / CI | pure core、compare/data orchestration、SQL/JSON 输出 | host-neutral application service、secret provider、退出码、project schema、无 demo fallback | M | CI 凭据/日志、Node/Electron 版本差异、部分成功语义 | **2.8/5** |
| MariaDB / MySQL-compatible | mysql2/SSH/UI/四类对象概念 | 版本化 DDL、权限、routine、类型、结果 fixture | M | “协议兼容”被误当“语义兼容” | **3.0/5** |
| PostgreSQL | UI、filter、report 外壳、slot/history 概念 | pg_catalog/information_schema、schema、sequence/type/function、quoted identifier、DDL diff、literal/upsert、pagination | L–XL | 语义差异大、fixture 不足、错误报告误导 | **1.6/5** |
| SQL Server / Oracle | 少量 UI/编排 | catalog/schema/DCL/routine/package/types/quoting/data pagination | XL | 目标用户与预算不确定，不能与 PG 打包承诺 | **1.3/5** |
| 团队协作 / 云审计 | 本地 manifest/报告可作为输入 | 服务、身份、角色、租户、审计事件、冲突、备份、secret server | XL | 凭据集中泄露、报告泄露、责任边界 | **1.2/5** |
| 持续巡检 / 通知 | compare 与 history 的初始语义 | scheduler、job store、retry、凭据刷新、通知、漂移基线 | L–XL | 长期凭据、误报、任务风暴、payload 泄露 | **1.8/5** |
| Linux 桌面包 | Electron 壳、构建脚本、图标 | builder target、桌面集成、原生测试、支持矩阵 | S–M（工程） | 需求/支持成本未知，不能从旧 CLI 推断 | **3.0/5** |
| Tauri / 新桌面壳 | renderer 视觉层和部分纯 core | Node main、连接、Vault、IPC、更新/打包重新设计 | XL | 用户价值/安全收益未证实 | **1.0/5** |

#### 7.1 新数据库：为什么不是“加一个 driver”

以 PostgreSQL 为例，官方文档同时说明 information schema 是 SQL 标准视图，而 PostgreSQL 特有信息需要 system catalogs；可见性还受 `search_path`/OID 影响。参考：<https://www.postgresql.org/docs/18/information-schema.html>、<https://www.postgresql.org/docs/18/functions-info.html>。这与当前 `SHOW CREATE` map 的差异是外部事实与项目事实的对照，不是对 PostgreSQL 实现的承诺。

当前新增一个数据库至少会同时触及：

1. **Node/connection/auth**：`NodeMeta`/表单使用 3306 作为默认，`buildMysqlConfig` 和 `mysql2/promise` 固定 MySQL 连接形状；见 `src-core/types.ts:50-70`、`src-main/main.ts:98-103`、`src-main/connection.ts:88-103`。
2. **metadata**：当前 SQL 常量是 `information_schema.tables/parameters` + `SHOW CREATE`；见 `src-main/metadata.ts:41-50,115-138`。
3. **DDL semantics**：当前是 MySQL text/legacy parser；见 `src-core/diff.ts:24-44,81-242`。
4. **data identity/literal/pagination**：当前是 PK/UNIQUE regex、NUL key、反引号、MySQL tuple keyset；见 `src-core/data-pk.ts:17-143`、`src-core/data-diff.ts:30-80`、`src-main/data-fetch.ts:33-85`。
5. **formatter/preview**：renderer 和 main 都固定 `language:'mysql'`；见 `src-renderer/sql.ts:18-26`、`src-main/main.ts:340-350`。
6. **fixtures/E2E**：现有测试只提供 MySQL 形态；见 `src-main/metadata.test.ts:41-180`、`src-core/diff.test.ts:104-194`。

**INFERENCE**：因此 MariaDB/兼容层可以是较低成本的候选验证对象；PostgreSQL/SQL Server/Oracle 需要独立 adapter、normalized model 和测试矩阵，不应被描述为“同一个 connection option”。

#### 7.2 新工作流

- **基线/审查包**：当前 `HistoryEntry` 只有摘要，`DiffItem` 没有 provenance/policy 字段；因此可复用 SQL/risk/export，但不能直接把最近历史当成可恢复 run。证据：`src-core/types.ts:87-128`、`src-main/store-json.ts:98-115`。
- **持续巡检**：当前只有一次交互式 `compare.run`、一个全局 abort controller 和本地 20 条 history；没有 scheduler/job/retry/credential refresh。证据：`src-main/main.ts:280-338`、`src-core/types.ts:118-128`。
- **团队协作**：当前没有用户身份、角色、租户、共享 repository 或审计事件；Vault/JSON 只表达本机秘密和 metadata。证据：`src-main/vault.ts:183-315`、`src-main/store-json.ts:1-115`。
- **AI/自动执行**：当前代码和规范都维持“只生成、不执行”，没有执行器、审批、审计或回滚闭环；证据：`src-core/data-diff.ts:1-4`、`.trellis/spec/backend/index.md:1-3`。因此它们不是当前架构的自然增量，而是新的信任边界。

#### 7.3 新部署形态

| 形态 | 当前事实 | 需要重新定义的技术边界 | 技术分 |
|---|---|---|---:|
| 当前 Electron Windows/mac | 已有 main/preload/core/renderer 和 package targets | 维持现有本地 secret/download 模型 | **4.2/5** |
| Linux desktop | builder 未声明 target | build target、图标/桌面集成、原生 QA、支持承诺 | **3.0/5** |
| 本机 headless CLI | 没有 bin/CLI/project/exit-code 入口 | application service、secret provider、manifest、退出码、诊断 | **2.8/5** |
| 本地 Web/局域网服务 | 没有 HTTP/auth/multi-user 层 | server API、session/job、repository、权限、网络边界 | **1.5/5** |
| 云端团队服务 | 没有服务端、租户或审计 | identity/RBAC/tenant/audit/secret service/backup/ops | **1.2/5** |
| Tauri/其他壳 | 只有 renderer 可部分复用 | Node runtime、Vault、连接、IPC、更新和打包 | **1.0/5** |

Electron 官方 `utilityProcess` 文档说明可用 Node child + Message ports 运行独立 Node 工作；Node 官方 `worker_threads` 文档说明 worker 更适合 CPU-intensive JS、内置 async I/O 通常不需要 worker。两者是未来把“大结果/重 CPU diff”移出 main event loop 的候选机制，不是当前已存在的实现。参考：<https://www.electronjs.org/docs/latest/api/utility-process>、<https://nodejs.org/docs/latest-v22.x/api/worker_threads.html>。

### 8. 可扩展性评分

#### 8.1 分维度评分

| 维度 | 分数 | 依据 |
|---|---:|---|
| 进程/模块边界 | **4.0/5** | main/preload/renderer 分层明确，core 大部分纯函数；但 main composition root 和 concrete fs/Vault 依赖仍在。见 `main.ts`、`preload.ts`、`compare-run.ts`。 |
| MySQL 结构/数据核心复用 | **4.2/5** | diff、classify、risk、filter、PK/UNIQUE、SQL export 有 167 个当前测试；但语义是 legacy text/MySQL，不是 normalized model。见 `src-core/*`、`src-core/*.test.ts`。 |
| 连接与资源生命周期 | **2.8/5** | pool/tunnel/timeout/cleanup 有基本实现和 fake；存在 partial construction、cache invalidation、全局 abort、未 await shutdown 等边界。见 `connection.ts`、`compare-run.ts`、`data-run.ts`。 |
| 大数据/结果规模 | **2.4/5** | keyset 和 threshold 改善单次 query，但整表 materialize、完整 IPC、无 renderer virtualization/stream。见 `data-fetch.ts`、`data-diff.ts`、`App.tsx`。 |
| 契约/持久化扩展 | **2.7/5** | `types.ts` 有共享 contract，JSON/Vault 可测试；缺 dialect/version/job/manifest/schema migration/repository interface。见 `types.ts`、`store-json.ts`、`vault.ts`。 |
| 安全与发布 | **2.9/5** | context isolation、node integration off、secret 隔离、只读查询面已存在；CSP/sender/nav、SSH host verification、TLS、签名/update 未闭环。见 `main.ts`、`preload.ts`、`connection.ts`、`electron-builder.yml`。 |
| 测试/E2E 扩展 | **3.0/5** | 纯函数和 injected fake 覆盖较好，CDP 有真实 fixture；无 React DOM/CI/持久化 harness/大表/多数据库矩阵。见测试文件、E2E report。 |
| 新数据库承载 | **1.6/5** | MySQL 查询、DDL parser、literal、formatter、identity 多层耦合。见 `metadata.ts`、`diff.ts`、`data-diff.ts`、`sql.ts`。 |
| 新工作流/服务承载 | **1.9/5** | 一次性 A/B 请求有基础；无 job、baseline、manifest、身份、审计、scheduler。见 `types.ts`、`main.ts`、`store-json.ts`。 |

#### 8.2 两个 headline 分数

- **当前 MySQL 桌面产品技术分：4.0/5**。它已经有可运行的本地闭环、可复用 core、连接/Vault/导出和真实 MySQL 小规模证据；继续做 MySQL 纵向功能的技术风险相对可控。
- **作为“新增数据库 + 自动化 + 团队/服务”平台的技术分：2.2/5**。纯 core 能降低一部分成本，但数据模型、资源生命周期、结果传输、身份/审计和部署边界仍需要新增合同；跨方言/云化不应被当作当前架构的默认延伸。

这两个分数都不是产品需求结论。是否进入某条路线仍需用户访谈、真实 fixture、性能实验和隐私决策。本报告的分维度分数与 headline 分数属于同一技术承载力 rubric；它们不替代 [`candidate-directions-and-validation.md`](candidate-directions-and-validation.md) 的产品验证优先级，也不能直接与另一份技术成本表横向相加。

### 9. 分阶段技术路线（条件式建议，不是当前实现）

#### Phase 0 — 证据、基线与契约冻结（建议 0–2 周）

**目标**：先回答“哪个问题值得扩展”，并把当前可验证基线固定下来。

- 收集 3–5 个脱敏真实 workflow：实时 A/B、baseline、CI、报告交接、DBA review；现有 PRD 明确这些仍是开放问题。见 `.trellis/tasks/09-24-product-expansion-roadmap/prd.md:70-76`。
- 对真实 schema 统计表数、行数、宽表/BLOB、无 PK/UNIQUE、慢查询和权限失败；现有代码只提供 threshold/identity 规则，没有规模分布证据。
- 选择一个近端实验：优先验证“安全迁移审查/基线包”，备选“headless 只读入口”；DataGrip 继续等待真实 fixture，因为任务明确阻塞。见 `.trellis/tasks/09-24-datagrip-converter/prd.md:1-28`。
- 形成版本化的 run/project manifest 需求清单，先决定是否保存 DDL/行值、保留多久、如何脱敏；不把完整 `SecretBundle` 放进共享文件。

**退出条件**：目标用户、首个成功指标、报告隐私边界、真实 schema 分布和 baseline/自动化优先级有证据；否则不进入跨数据库或服务化。

#### Phase 1 — MySQL 纵向扩展与工程护栏（建议 2–6 周）

**目标**：让当前主链路在“可恢复 run、明确真实结果、可控资源、可审计导出”方面具备验证基础。

- 为 `compare.run`/`runDataCompare` 补应用服务级集成测试：单侧 pool 失败、cleanup、threshold、cancel、progress、partial table status；现有测试只覆盖其中纯函数片段。见 `connection.test.ts`、`data-fetch.test.ts`、`data-run-identity.test.ts`。
- 量化并记录大表/BLOB/无主键实验：峰值 RSS、耗时、SQL 数、取消延迟、结果完整性；`fetchAllByPK` 当前整表 materialize 的事实见 `data-fetch.ts:105-134`。
- 定义 run/project/report 的最小 versioned contract：输入 fingerprint、A→B 方向、scope/options、结果 hash/统计、允许共享的 risk/SQL 字段；不复用只有摘要的 `HistoryEntry` 作为 run record。
- 明确 renderer 中 demo/real result 的来源状态；当前失败会填 demo items，见 `store.ts:611-629`，E2E 报告也记录可能被误读，见 `e2e-report.md:51-56`。
- 对连接安全做决策记录：SSH host identity、TLS/CA、只读账号/权限、secret source、报告 redaction；这些是进入自动化/团队化的前置门槛，不是默认新增功能。

**退出条件**：一个真实用户 workflow 能完成“保存→复比→交接”或“CLI/CI 复现”；资源/隐私/失败语义通过预先定义的实验门槛；现有 MySQL A→B 只读结果无回归。

#### Phase 2 — Host-neutral application service / headless 入口（条件触发，建议 6–10 周）

**目标**：让同一比较核心被 Electron 以外的本地宿主调用，而不复制 diff 语义。

- 让编排依赖 repository、secret provider、transport、history sink 等窄接口，而不是直接依赖 `loadNodes(ctx.userDataDir)`、具体 `Vault` 和 renderer fallback；当前 concrete 依赖见 `compare-run.ts:32-35,74-83`、`data-run.ts:29-32,269-279`。
- 提供不含秘密的 project/run manifest、机器可读 JSON/SQL、明确退出码、partial failure 语义和脱敏诊断；CLI 不得调用 renderer 的 demo fallback。
- 复用 `src-core` 的 compare/filter/risk/export，不复制 MySQL diff；Node worker/utility process 只在 CPU/大结果实验证明必要时引入。官方参考：<https://nodejs.org/docs/latest-v22.x/api/worker_threads.html>、<https://www.electronjs.org/docs/latest/api/utility-process>。
- 先让外部 scheduler 调用只读入口；把 retry、凭据刷新、通知和长期驻留作为独立决策。

**退出条件**：目标用户能在本地/CI 用同一 fixture 得到与桌面一致的结果；失败、部分成功、取消、退出码不会由 demo 数据或 toast 掩盖；secret 不进入 project/artifact/log。

#### Phase 3 — 条件选择一个边界扩展

在以下方向中最多选择一个，避免同时引入不可逆的边界：

1. **转换生态**：DataGrip fixture 到位并有迁移频次证据；当前 `NodeConverter` registry 为空，DBeaver exporter 是独立方向。见 `converters/index.ts:1-32`、`converters/dbeaver.ts:1-7`。
2. **新数据库**：优先用真实 MariaDB/兼容版本验证“transport 可复用不等于 diff 语义可复用”；只有在用户、版本、对象类型和 fixture 都明确后再定义 PostgreSQL adapter。现有 PostgreSQL 信息架构差异可参考官方 catalog 文档。
3. **团队协作**：只有静态 manifest 已被证明不足，且确有身份、角色、评论、审批或审计责任需求，才进入服务设计。
4. **持续巡检**：只有 headless 入口在真实频率下被使用，且误报/凭据/通知敏感性可控，才内建 scheduler/job store。

**退出条件**：该方向有独立 fixture、用户证据、失败矩阵和资源预算；未满足时保持当前 MySQL 桌面边界，不以“技术可行”替代需求证据。

#### Phase 4 — 平台化与发布治理（仅在 Phase 3 证据成立后）

- 团队/云服务才引入 job、tenant、auth/RBAC、audit、secret service、备份和运维；当前没有这些对象，不能从 JSON/Vault 推断已有能力。
- 签名、公证、自动更新、Linux target 独立作为发布工程任务；当前 builder 和报告只证明未签名产物，见 `electron-builder.yml`、E2E report `:101-111`。
- Tauri 或其他桌面壳只有在包体、启动时间、内存或安全收益被量化后才评估；它会重新设计 Node main、Vault、连接、IPC 和更新，不是 renderer 的简单替换。

### 10. 关键决策门槛

以下是代码无法回答、必须由产品/用户/环境验证的 **HYPOTHESIS**：

1. 首要用户是独立开发者、测试/发布人员、DBA，还是需要审计交付的团队？现有 PRD 将此列为开放问题：`.trellis/tasks/09-24-product-expansion-roadmap/prd.md:70-76`。
2. 高频任务是实时 A/B、baseline→当前、CI 漂移，还是报告交接？当前 `HistoryEntry` 不能回答。
3. 哪些 DDL/行值/节点别名可以进入本地项目、CI artifact、工单或通知？当前没有 redaction policy。
4. 用户真实数据规模、宽表/BLOB/无主键比例和可接受延迟是多少？现有 threshold 只是默认选项。
5. 首个非 MySQL 数据库及版本、必须覆盖的对象/类型/权限是什么？没有 fixture 时不能给出 adapter 承诺。
6. CLI/CI 允许的 secret source 是环境变量、系统 keychain、secret reference 还是外部 broker？
7. 是否接受后台长期凭据、远程通知和服务运维？若不接受，scheduler/team 方向不成立。
8. 是否继续把“不执行生成 SQL”作为不可绕过的产品安全边界？当前代码和规范均维持该边界。

### 11. 外部参考

以下资料只用于解释框架能力与外部差异；项目现状仍以源码/测试为准。资料访问日期为 2026-09-24；部分链接是当前 latest 文档，落地前需针对锁定的 Electron 34.5.8 / Node >=20 做兼容性复核。

- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security) — context isolation、sandbox、CSP、sender validation、navigation/new-window、依赖更新清单。
- [Electron context isolation / contextBridge](https://www.electronjs.org/docs/latest/tutorial/context-isolation) — 只暴露专用方法，不暴露 raw IPC。
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) — Node child、Message ports、生命周期和 stdout/stderr；可作为 main 外 CPU/长任务候选。
- [Node.js worker_threads](https://nodejs.org/docs/latest-v22.x/api/worker_threads.html) — worker 适合 CPU-intensive JavaScript，内置 async I/O 通常不需要 worker；消息使用 structured clone/transfer list。
- [mysql2 quickstart / pool](https://sidorares.github.io/node-mysql2/docs) 与 [createPool](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-pool) — pool lazy connection、connectionLimit、waitForConnections、queueLimit、release/end、SSL 配置面。
- [ssh2 configuration / hostVerifier](https://github.com/mscdex/ssh2/blob/master/README.md) — `hostVerifier` 用于 host key verification；未设置时的行为需按锁定版本复核。
- [PostgreSQL information_schema](https://www.postgresql.org/docs/18/information-schema.html)、[system views](https://www.postgresql.org/docs/18/views.html)、[visibility functions](https://www.postgresql.org/docs/18/functions-info.html) — 标准 information schema 与 PostgreSQL-specific catalog/visibility 的差异。

### Related Specs

- `.trellis/spec/backend/index.md` — backend 定义为 Electron main + shared core，不是 HTTP 服务。
- `.trellis/spec/backend/directory-structure.md` — main/preload/core/renderer ownership。
- `.trellis/spec/backend/database-guidelines.md` — MySQL 只读、并发、pool/tunnel cleanup、A→B 方向。
- `.trellis/spec/backend/error-handling.md` — IPC rejection、typed result、partial failure、demo fallback。
- `.trellis/spec/backend/quality-guidelines.md` — Electron 安全、测试、E2E、打包门禁。
- `.trellis/spec/backend/logging-guidelines.md` — 当前无应用 logger，敏感数据不写 runtime log。
- `.trellis/spec/frontend/state-management.md` — Zustand 状态和 demo fallback。
- `.trellis/spec/frontend/quality-guidelines.md` — renderer 测试、CDP E2E、可访问性和环境限制。
- `.trellis/spec/guides/cross-layer-thinking-guide.md` — IPC、JSON、数据库和版本字段的跨层契约检查。
- `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md` — 22 个 CDP 动作、Docker MySQL fixture、发布和环境限制。
- `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md` — 直连/行级真实证据与 SSH 缺口。
- `.trellis/tasks/09-24-datagrip-converter/prd.md` — DataGrip fixture 阻塞，不应猜测 XML 格式。

## Caveats / Not Found

- `python3 ./.trellis/scripts/task.py current --source` 在本子会话返回 `(none)`；本文件按用户明确指定的 `.trellis/tasks/09-24-product-expansion-roadmap/research/` 写入，没有猜测其他任务目录。
- 研究采集阶段只运行了 `npm test`、`npm run typecheck`、`npm run lint` 和只读文件/包清单检查，没有再次运行会写 `dist-*`/`release` 的 build/pack；本次 Check Agent 质检阶段另行运行了 `npm run build`（未运行 pack）。构建/发布事实仍引用已有归档证据，并明确标注其代码基线。
- 没有发现仓库内 CI 配置、coverage 配置、持久化 CDP/Electron E2E harness、HTTP server、ORM、migration framework、scheduler、telemetry 或云服务实现。
- 没有真实客户访谈、付费/使用频率、生产 schema 分布或大规模内存/延迟基线；所有用户价值和优先级结论仍是 HYPOTHESIS。
- 没有 PostgreSQL、SQL Server、Oracle、MariaDB、TiDB 的真实 schema/data fixture；本文件不承诺这些数据库兼容性。
- SSH 私钥、允许 TCP forwarding 的真实跳板、Windows 原生启动、DBeaver IDE 导入和签名/公证仍未形成当前自动化门禁；分别见历史 smoke、E2E、DBeaver report 与 `electron-builder.yml`。
- 外部 latest 文档可能比项目锁定的 Electron 34.5.8 更新；它们用于架构事实和安全清单参考，具体 API 采用前必须在锁定版本上验证。
