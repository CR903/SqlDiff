# Research: SqlDiff 技术接缝、架构债务与扩展边界

- **Query**: 从当前源码识别已经存在且可复用的 seam、尚未形成的抽象边界、正确性/资源/安全/交付技术债，并说明每个判断的证据与置信度。
- **Scope**: internal（`apps/desktop/src-core`、`src-main`、`src-renderer`、构建配置、单测、Trellis specs/归档报告）
- **Date**: 2026-09-24
- **证据标记**: **FACT** = 直接观察；**INFERENCE** = 由事实推导的边界含义；**HYPOTHESIS** = 尚待需求或环境验证的判断。
- **路径约定**：表格和段落中的 `src-core/*`、`src-main/*`、`src-renderer/*`、`App.tsx` 等短引用均相对于 `apps/desktop/`；任务和 spec 使用仓库实际路径。

## Findings

### 1. 当前依赖和数据流

- **FACT**：运行时依赖方向是 `renderer → preload/contextBridge → main handlers → main services → shared core`。`createWindow` 开启 `contextIsolation`、关闭 `nodeIntegration`，renderer 没有直接 `node:*`/`electron`/`mysql2`/`ssh2` runtime import。证据：`apps/desktop/src-main/main.ts:367-380`; `apps/desktop/src-main/preload.ts:66-150`; `apps/desktop/src-renderer/App.tsx:7`; `apps/desktop/src-renderer/store.ts:31-36`; `apps/desktop/src-renderer/sql.ts:7`; `.trellis/spec/frontend/directory-structure.md:34-38`。
- **FACT**：比较数据流是 A/B NodeMeta → pools/tunnels → metadata snapshots → shared core compare → optional data compare → CompareResult/IPC → renderer filter → SQL output。证据：`apps/desktop/src-main/compare-run.ts:53-135`; `apps/desktop/src-core/compare.ts:100-173`; `apps/desktop/src-main/data-run.ts:255-321`; `apps/desktop/src-renderer/store.ts:519-639`。
- **FACT**：`DatabaseMetadata` 虽然是 core compare 的输入，但其 interface 当前定义在 main 的 `metadata.ts`，core/renderer 通过 `import type` 反向引用；这是编译期依赖事实。证据：`apps/desktop/src-main/metadata.ts:26-32`; `apps/desktop/src-core/compare.ts:6-8`; `apps/desktop/src-core/compare-filter.ts:6-8`; `apps/desktop/src-renderer/demo.ts:5-6`; `.trellis/spec/backend/directory-structure.md:39-41`。
- **INFERENCE**：core 可以在 TypeScript 层继续复用，但把 core 独立成 CLI/package 时，`DatabaseMetadata` 的 ownership 和 main→core 的反向 type import 会成为编译边界；这不是当前已有 CLI 的证据。

### 2. 已存在的可复用 seam

| Seam | 现有符号/合同 | 当前使用者与证据 | 复用状态（事实/推断） |
|---|---|---|---|
| 领域契约 | `NodeMeta`、`SecretBundle`、`DiffItem`、`CompareRequest`、`CompareResult`、`DataTableStatus` | `types.ts:41-207`；main/preload/renderer 均引用 | **FACT**：跨层单一类型源。**INFERENCE**：可作为其他宿主共享的输入/输出合同，但当前没有第二宿主。 |
| 纯结构比较 | `compareRun`、`diffTable`、`diffTableField`、`diffProcedure`、`filterTable/Field/Procedure` | `diff.ts:24-242`; `compare.ts:104-150`; `diff.test.ts:76-292` | **FACT**：无 DB 依赖且有单测。**INFERENCE**：可复用于 fixture、批处理或报告生成；语义仍是 MySQL legacy text model。 |
| 纯行 DML | `diffDataRows`、`sqlLiteral`、`escapeDataIdent`、`getDataPKV` | `data-diff.ts:30-143`; `data-diff.test.ts:44-101` | **FACT**：消费 `DataRow[]`、不发 SQL。**INFERENCE**：可复用到离线 fixture/headless runner，但不能独立提供读取、身份和分页。 |
| 行身份策略 | `parseTablePK`、`parseUniqueKeys`、`qualifyIdentity`、`decideIdentity` | `data-pk.ts:17-143`; `data-run.ts:113-166`; identity tests | **FACT**：纯函数、typed decision。**INFERENCE**：策略与读取编排已有分离；当前策略固定为 PK/全非空 UNIQUE。 |
| 过滤/分类 | `normalizeScopes`、`hasDataScope`、`postFilterResult`、`classify`、`aspectOf`、`verbOf` | `compare-filter.ts:19-118`; `classify.ts:18-94`; filter tests | **FACT**：main/renderer 可共享，renderer 不需 Node 依赖。**INFERENCE**：可作为其他输出 UI 的稳定过滤层。 |
| 统计/排序 | `sortDiffItems`、`recountStats`、`toExportSql` | `compare.ts:77-173`; `compare-filter.ts:46-60`; DDL/DML/verb tests | **FACT**：纯函数且复制=所见测试覆盖。**INFERENCE**：可支撑其他结果消费者，但当前文本 header 固定为 A/B/时间。 |
| 数据查询最小接口 | `DbQueryable { query(sql, params) }` | `metadata.ts:16-19`; `data-fetch.ts:11`; `metadata.test.ts:24-39` | **FACT**：可用 fake DB 注入。**INFERENCE**：为不同 transport/测试提供窄边界；不包含 dialect/capabilities/transaction 语义。 |
| 配置生成 | `buildMysqlConfig`、`buildSshConnectConfig`、`resolveMysqlEndpoint` | `connection.ts:55-112`; `connection.test.ts:73-135` | **FACT**：纯函数且可单测。**INFERENCE**：可复用到连接诊断或 adapter；当前只生成 MySQL/ssh2 配置。 |
| 连接生命周期 | `createMysqlPool`、`ensureTunnel`、`closeTunnel`、`closeAll`、`TunnelClient/Server` | `connection.ts:127-142,228-427`; `connection.test.ts:137-158` | **FACT**：pool/隧道拥有明确 owner，测试有 cache/close 后门。**INFERENCE**：可包装到另一种宿主；当前 cache 无 session/project 维度。 |
| Vault 适配 | `SafeStorageLike`、`VaultOptions`、`Vault` | `vault.ts:19-22,183-315`; `vault.test.ts:51-99` | **FACT**：Electron safeStorage 被注入，纯 AES fallback 可独立测试。**INFERENCE**：可作为其他本地 secret provider 的起点；当前导出 key 仍绑定本机 master key。 |
| 进度/取消 | `CompareRunHooks`、`DataRunOptions.onTable/onFetchProgress/signal` | `compare-run.ts:37-42`; `data-run.ts:34-47,281-292`; `main.ts:315-339` | **FACT**：数据阶段有 typed progress/cancel。**INFERENCE**：可嵌入 job runner；当前 controller 是单例交互式 AbortController。 |
| 本地存储函数 | `loadNodes/saveNodes/loadHistory/appendHistory/clearHistory` | `store-json.ts:82-115`; `vault.test.ts:180-205` | **FACT**：目录可注入、原子写、运行时 guard。**INFERENCE**：可替换具体文件实现；当前没有 repository interface 或 schema migration。 |
| 加密导出合同 | `ExportJSON`、`SecretsEnc`、`Vault.exportEncrypted/importDecrypted` | `types.ts:80-116`; `vault.ts:274-315`; `vault.test.ts:101-140` | **FACT**：v1 版本、加密段和错误边界明确。**INFERENCE**：可作为本机备份格式；不是跨机器/团队 secret package。 |
| IPC bridge | `SqlDiffApi`、各 `ipcMain.handle` | `preload.ts:66-150`; `main.ts:139-357` | **FACT**：renderer→main 的唯一 typed bridge。**INFERENCE**：新增宿主需要另一个 adapter，不能直接把 renderer action 当 service。 |
| 输出/下载 | `buildExportText`、`downloadTextFile/downloadJsonFile`、`registerWillDownload` | `sql.ts:29-35,101-125`; `download.ts:17-39` | **FACT**：SQL/JSON 复用 renderer Blob + main save path。**INFERENCE**：可复用到更多报告格式；当前没有完成回调或报告 manifest。 |
| 转换器注册 seam | `NodeConverter`、`converters`、`registerConverter` | `converters/index.ts:9-32` | **FACT**：反向第三方配置导入接口存在但为空。**INFERENCE**：未来 importer 有注册点；当前 DBeaver exporter 是另一方向且已完成。 |
| UI workflow 边界 | `NodeLibrary`、`CompareSlots`、`DataSection`、`DiffTable`、`SqlPreview`、两个 Modal | `App.tsx:72-975,982-1373`; `frontend/directory-structure.md:22-31` | **FACT**：组件按 workflow 划分但仍在单文件。**INFERENCE**：可作为 UI 复用/拆分边界；没有独立页面、路由或组件测试 harness。 |
| 测试 fake seam | `fakeDb`、`fakeSafeStorage`、`fakeTunnel`、`fakeDownloadSession` | `metadata.test.ts:24-39`; `vault.test.ts:51-60`; `connection.test.ts:36-47`; `download.test.ts:11-13` | **FACT**：核心服务可在无 live infra 下测。**INFERENCE**：可复用于新服务的 contract tests；当前没有真实 main IPC 集成 fake。 |

### 3. 尚未形成的 seam（事实，不是建议）

- **FACT**：没有 `engine`/`dialect` 字段，也没有 metadata/diff/literal adapter registry；MySQL 语义分布在 `connection.ts`、`metadata.ts`、`data-fetch.ts`、`diff.ts`、`data-diff.ts`。证据：`types.ts:50-70`; `connection.ts:88-103`; `metadata.ts:41-138`; `data-fetch.ts:33-85`; `data-diff.ts:36-68`。
- **FACT**：没有 repository/storage interface；orchestrators 直接依赖 `userDataDir`、`loadNodes` 和 `Vault`。证据：`compare-run.ts:32-35,74-78`; `data-run.ts:29-32,269-273`。
- **FACT**：没有 job/manifest/project/report contract；一次 `compare.run` 返回完整结果，`HistoryEntry` 只有摘要。证据：`preload.ts:91-97`; `types.ts:118-128,139-207`。
- **FACT**：没有 secret provider contract 供 CLI/CI/服务使用；`Vault` 是具体 local class，Node/SecretBundle 固定为数据库密码和 SSH 密钥。证据：`vault.ts:183-315`; `types.ts:72-78`; `preload.ts:66-106`。
- **FACT**：没有 risk policy 配置或 report exporter；风险函数和 SQL text export 都是固定实现。证据：`risk.ts:12-116`; `compare.ts:156-173`。
- **FACT**：没有 scheduler、notification、retry、job persistence 或并发运行模型；main 只有同步 `ipcMain.handle` 和一次性 progress event。证据：`main.ts:277-359`; `types.ts:139-207`。
- **INFERENCE**：因此当前最稳定的“扩展单位”是已有 MySQL compare workflow 的局部能力；跨数据库、服务化和团队化尚不是已存在的 seam-backed product capability。

### 4. 技术债清单

#### 4.1 正确性与兼容性债

- **FACT — legacy 文本归一会隐藏部分结构变化**：`filterTable` 删除 `DEFAULT`，`filterField` 删除 COMMENT，`filterTableField` 依赖行文本解析。证据：`diff.ts:24-43,81-175`; `diff.test.ts:76-102`。
- **INFERENCE — 默认值变更可能被判无差异**：由于 `DEFAULT` 在表级过滤阶段全局删除，任何只改变默认值的表定义会先被归一为相同文本；这属于当前兼容语义的直接结果，不是已做过的用户验证结论。
- **FACT — index 覆盖范围未被完整证明**：结构生成器只把行首 `KEY \`` 当作 index，`aspectOf` 的正则虽覆盖 `UNIQUE/FULLTEXT/SPATIAL` 展示分类；当前结构测试主要断言普通 `KEY`。证据：`diff.ts:96-129`; `classify.ts:29-52`; `diff.test.ts:139-147`; `ddl-dml-index.test.ts:60-85`。
- **FACT — routine 清单来源单一**：`information_schema.parameters` distinct query 是 procedure/function 的唯一列表来源。证据：`metadata.ts:42-44,100-112`。
- **HYPOTHESIS — 无参数 routine 可能漏列**：若具体 MySQL 版本的 `PARAMETERS` 表不返回无参数 routine，当前 `listRoutines` 会漏掉它；仓库无真实 fixture 证明或排除，需实验验证。
- **FACT — DDL 生成不是完整 parser**：对象/列/索引/例程逻辑由正则和字符串分割组成，未见 AST、foreign key、trigger、generated column 等专门模型。证据：`diff.ts:81-242`; `types.ts:87-104`。
- **FACT — routine 原子块的 verb 过滤有限**：`verbOf` 对以 `DELIMITER` 开头的例程重建块返回 `OTHER`，测试明确如此。证据：`classify.ts:80-94`; `verb-search.test.ts:95-103`。
- **FACT — 单对象 SHOW CREATE 错误被压成 null**：`fetchMetadata` 捕获异常并返回 null，renderer 只能看到对象被跳过而没有原始权限/网络原因。证据：`metadata.ts:115-125,190-201`; `compare.ts:63-69`。
- **FACT — 结构 DDL 的对象名插值是独立安全边界**：生成 SQL 使用模板字符串直接插入 `name`，与执行查询的 `escapeIdent`/`escapeDataIdent` 不同。证据：`diff.ts:59-60,141-170`; `database-guidelines.md:7-12`。

#### 4.2 数据正确性、规模与资源债

- **FACT — 全表 materialize**：`fetchAllByPK` 将整表 row 放入 `out` 数组，再由 `diffDataRows` 建立两张 Map。证据：`data-fetch.ts:105-134`; `data-diff.ts:97-109`。
- **FACT — 表间串行而非流式**：`runDataCompare` 逐表 `for...of`，注释明确目的是控制内存峰值。证据：`data-run.ts:286-313`。
- **FACT — A/B pool/数据读取并发是有限的**：pool limit 5；metadata 每类 map worker 10，A/B metadata 四个类别并行；这些是局部上限而非全局任务上限。证据：`connection.ts:301-318`; `metadata.ts:140-167,191-196`; `database-guidelines.md:25-31`。
- **FACT — INSERT 依赖首行列顺序**：没有显式 column list，列集合来自 `Object.keys(rows[0])`。证据：`data-diff.ts:75-81`。
- **FACT — UPDATE 只遍历 A 行列集合**：代码对 `Object.keys(d1)` 比较宽松 `==`，没有独立的 B 列存在性、类型、generated column、trigger 或 collation 检查。证据：`data-diff.ts:126-135`。
- **FACT — row key 是字符串化拼接**：`getDataPKV` 用 `String(row[col])` 加 NUL 分隔；当前测试覆盖数字/字符串和联合键，没有完整驱动类型碰撞矩阵。证据：`data-diff.ts:41-45`; `data-diff.test.ts:68-86`。
- **INFERENCE — 不同列形状/顺序的 A 行可能生成不符合预期的 INSERT**：该结论来自 `rows[0]` 唯一决定列集合；没有真实异形表 fixture，不能把它写成已复现 bug。
- **FACT — BLOB/二进制按 UTF-8 文本处理**：没有 hex/base64、采样、截断或 warning contract。证据：`data-diff.ts:10-15,64-67`; `09-21-data-diff-v2/prd.md:29-32`。
- **FACT — 数据阈值确认是全局布尔值**：一次超阈会记 `confirm-needed`；UI 确认后整个 `runCompare` 重跑。证据：`types.ts:175-184`; `data-run.ts:291-302`; `App.tsx:1716-1720`。
- **FACT — 结构阶段没有细粒度取消**：AbortSignal 在数据分页循环中检查，UI 明确说明结构不可中断。证据：`data-fetch.ts:97-103,125-132`; `App.tsx:480-487`。

#### 4.3 生命周期与并发债

- **FACT — 双 pool 部分构造清理缺口**：`Promise.all` 完成后才赋值；一侧重试成功、另一侧失败时没有 pool 引用可关闭。证据：`compare-run.ts:80-89`; `data-run.ts:275-279`; `database-guidelines.md:27-31`。
- **FACT — 全局单一 AbortController**：`main.ts` 的 `dataAbort` 会被下一次 compare 覆盖；renderer store 只用 `comparing` 防止自身重复提交。证据：`main.ts:280-288,315-338`; `store.ts:519-523`。
- **FACT — 退出清理不等待**：`before-quit` 启动 `closeAll` 后立即返回。证据：`main.ts:408-411`。
- **FACT — tunnel cache 没有配置失效钩子**：node update/delete 只改 nodes/vault，正常流程没有调用 `closeTunnel`。证据：`main.ts:162-189`; `connection.ts:392-427`。
- **INFERENCE — 更新连接参数后可能继续命中旧 tunnel**：`ensureTunnel` 以 nodeId 查缓存，update 路径没有关闭/重建调用；如果用户在应用生命周期内修改 host/user/secret，旧 entry 仍可能被复用。依据：`connection.ts:232-240`; `main.ts:162-177`; `connection.ts:392-427`。
- **FACT — 进度事件没有 job/run id**：`CompareProgressEvent` 只有 table/status 或 table/side/fetched/total，消息来自单一 current compare。证据：`preload.ts:61-64`; `main.ts:319-335`。

#### 4.4 安全、隐私和诊断债

- **FACT — 本地 secrets 边界清楚但导出 key 绑定本机**：safeStorage/AES-GCM secret 文件不写明文；自定义 v1 导入用当前 master key，跨机器失败。证据：`vault.ts:1-12,61-147,274-315`; `vault.test.ts:118-140`。
- **FACT — JSON 持久化读损坏时返回空数组**：`readJsonFile` 对缺失/解析错误回退 fallback，`loadNodes/loadHistory` 过滤非法条目而不做迁移/修复提示。证据：`store-json.ts:34-50,84-103`。
- **FACT — 导入按 node id upsert**：相同 id 的 metadata/secret 会覆盖当前节点；导入没有冲突确认或版本迁移层。证据：`main.ts:224-235`; `vault.ts:292-315`。
- **FACT — DBeaver 路径严格 topology-only**：main handler 不读 Vault，builder 只从 NodeMeta allow-list 生成字段。证据：`main.ts:218-222`; `dbeaver.ts:137-217`; `dbeaver-export.md:48-68`。
- **FACT — demo fallback 没有独立 result source 字段**：失败后 items 是 demo compare 结果，只有 toast/lastCombo 文案说明。证据：`store.ts:611-629`; `types.ts:202-207`; `e2e-report.md:51-57`。
- **FACT — 没有应用级 logger/日志文件/审计事件**：当前诊断通道是 typed result、IPC rejection、toast、表单错误和任务证据。证据：`logging-guidelines.md:1-31`。
- **FACT — renderer HTML 高亮使用 `dangerouslySetInnerHTML`，但当前高亮函数先 escape**：`sql.ts:38-65`; `App.tsx:954-958`; `sql.test.ts:12-34`。
- **FACT — 没有 CSP、窗口导航/外链拦截配置**：`index.html` 只有 charset/viewport/title/script；`main.ts` 没有 `setWindowOpenHandler`/`will-navigate`/CSP。证据：`index.html:1-11`; `main.ts:367-387`。
- **FACT — 没有 read-only DB role/permission enforcement**：连接只验证 SELECT 可达，NodeMeta/SecretBundle 没有权限策略字段。证据：`connection.ts:321-390`; `types.ts:50-78`。
- **INFERENCE**：本地“只读”是应用执行 SQL 的约束，不是对用户凭据权限、外部手工执行或导出文件去向的审计保证。

#### 4.5 UI、状态和产品表面债

- **FACT — seed 与真实节点共用 fallback**：`refreshNodes` 忽略空数组/失败，保留 seed；无 IPC preview 也使用 seed/demo。证据：`store.ts:76-104,409-433`; `demo.ts:1-4,51-114`。
- **INFERENCE — 重启后真实 user-data 为空时，用户可能看到 seed 节点并把 demo 状态当作真实库；是否构成实际用户误读需 E2E/用户验证，但代码路径确实存在。
- **FACT — history clear 只有后端接口**：没有 renderer action/UI。证据：`main.ts:257-275`; `preload.ts:122-126`; `store.ts` 无 `clearHistory`。
- **FACT — pinned/notes 只有部分模型或历史要求**：pinned 有模型/过滤无控件，notes 在旧 PRD 但不在当前类型/表单。证据：`types.ts:50-70`; `node-filter.ts:13-18`; `App.tsx:1289-1292`; `09-21-sqldiff-desktop/prd.md:22-25`。
- **FACT — 数据结果合并主 DiffTable**：当前没有历史设计中的独立 DML 三 Tab。证据：`App.tsx:34-39,595-615`; `09-22-ui-fix-batch/design.md:8-23`。
- **FACT — 下载成功 toast 是 optimistic**：UI 在 Blob click 后显示成功，main 侧没有完成事件；实际文件证据依赖 `will-download`/CDP。证据：`App.tsx:924-935`; `download.ts:23-39`; `quality-guidelines.md:36-39`。
- **FACT — 交互可访问性有明确已知缺口**：卡片/slot/diff row 无键盘 handler，tabs/chips 无 pressed state，modal 无 focus trap，无 a11y suite。证据：`component-guidelines.md:34-38`; `frontend/quality-guidelines.md:36-38`。
- **FACT — 单文件组织限制扩展**：`App.tsx` 1,783 行、`store.ts` 651 行；组件、async actions、过滤派生和 modal state 没有独立目录/测试层。证据：文件行数与 `App.tsx:72-1783`; `store.ts:138-651`; `frontend/directory-structure.md:22-31`。
- **FACT — 结果列表和跨进程结果没有虚拟化/分页 contract**：`DiffTable` 直接 map `tabItems`，`compare.run` 一次返回完整 `CompareResult`；当前没有 result page/cursor。证据：`App.tsx:617-647`; `preload.ts:91-97`; `types.ts:202-207`。
- **FACT — renderer 重新实现了一条过滤链**：core 有 `postFilterResult`，App 又以 `useMemo` 重做 keyword→object→aspect→verb/Tab 链；两处依赖相同 item 字段保持语义。证据：`compare-filter.ts:79-118`; `App.tsx:1475-1553`; `frontend/state-management.md:39-43`。

#### 4.6 构建、测试与交付债

- **FACT — 当前测试层没有 main/preload/orchestrator/UI integration coverage**：Vitest 配置只收集 `*.test.ts`；没有对应 `main.ts`、`preload.ts`、`compare-run.ts`、`data-run.ts`、`store.ts`、`App.tsx` 测试。证据：`vitest.config.ts:3-5`; 文件清单。
- **FACT — `connection.test.ts` 的真实网络路径未自动化**：文件头注明“无需真实 DB/SSH，建连路径由手工冒烟覆盖”。证据：`connection.test.ts:1-2`。
- **FACT — `data-fetch.test.ts` 只覆盖 keyset SQL/nextKey**：没有覆盖 `fetchAllByPK` 循环、阈值、取消、异常或大数据峰值。证据：`data-fetch.test.ts:1-39`。
- **FACT — 测试编译产物会进入 main build**：`tsconfig.main.json` include 未排除 test；当前 `dist-main` 有 15 个 `*.test.js`，生成 app.asar 列表也包含它们。证据：`tsconfig.main.json:1-10`; `apps/desktop/.gitignore:1-5`; 生成目录/包内列表。
- **FACT — 未使用 Monaco 是当前依赖/实现错位**：`monaco-editor` 在 production dependencies，renderer 没有 import，生产使用 `<pre>`。证据：`package.json:18-23`; `sql.ts:1-3,42-65`; `App.tsx:954-958`。
- **FACT — 无 CI/E2E harness 提交**：最新 CDP harness 在 `$TMPDIR`，仓库只保留报告和 evidence。证据：`e2e-report.md:1-5,60-64`; `09-24-e2e-icon-release/design.md:3-10`。
- **FACT — 发布闭环仍有缺口**：包 unsigned、无 auto updater、Windows 无真机启动、目标内网库未验证。证据：`e2e-report.md:49-58,101-111`; `09-24-e2e-icon-release/prd.md:61-64`。

### 5. 扩展方向的边界归类（只描述现状，不作路线建议）

| 候选方向 | 当前已有可复用部分 | 当前缺失的边界/证据 | 分类 |
|---|---|---|---|
| MySQL 结构/数据工作流深化 | core compare、风险、filter、Vault、history、SQL export、测试 | baseline/manifest、报告/审查状态、策略合同、规模化验证 | **FACT** 已有主链路；**HYPOTHESIS** 需求价值待验证 |
| Headless/CLI/CI | 纯 core、`DbQueryable`、`CompareRunHooks` | 独立 application service、secret provider、project input、exit code、第二入口 | **INFERENCE** 技术上可围绕现有 seam；**FACT** 入口不存在 |
| DBeaver/DataGrip 转换生态 | `NodeConverter` seam、DBeaver exporter、NodeMeta allow-list、确定性测试 | DataGrip fixture/SSH 标签、DBeaver 真机导入、reverse importer | **FACT** DBeaver exporter 已实现；**FACT** DataGrip blocked |
| 多数据库 | 纯 core 的部分分类/filter/risk 逻辑 | engine/dialect、metadata provider、DDL/literal/pagination adapter、fixture | **FACT** 当前 MySQL 专用；**HYPOTHESIS** 目标数据库和频率未知 |
| 团队/云审计/审批 | NodeMeta、DiffItem、HistoryEntry、加密导出 | identity/ACL/project/report/event store/service | **FACT** 当前无 server/auth；**HYPOTHESIS** 需求未证实 |
| 持续巡检/通知 | compare orchestration、history 摘要、progress/cancel | scheduler/job store/retry/notification/credential rotation | **FACT** 当前无调度；**HYPOTHESIS** 漂移痛点未验证 |
| AI/自动修复/执行 | SQL/DiffItem/risk 文本 | privacy policy、evidence grounding、correctness/audit、executor | **FACT** 只有本地规则；**FACT** 明确不做自动执行；**HYPOTHESIS** 价值未知 |
| Tauri/新桌面壳 | React UI 和部分 core | main/Node connection/Vault/IPC/package 重做 | **FACT** 没有包体/性能用户证据；**HYPOTHESIS** 不应从技术可能性推导需求 |

### 6. 证据覆盖和未找到项

- **FACT**：本次 17/167 自动化测试只证明列出的纯函数/fake boundary；它不等价于 live DB/SSH、Electron IPC 或真实下载的全覆盖。证据：本次命令输出；`vitest.config.ts`; `connection.test.ts:1-2`。
- **FACT**：最新 E2E 的强证据在 Docker fixture/demo；报告主动标注了目标内网库和 Windows 限制。证据：`e2e-report.md:7-20,49-58`。
- **FACT**：没有发现 CI 配置、Playwright 测试、HTTP server、ORM、migration framework、scheduler、telemetry、auto-updater 或账号/权限模型。证据：仓库文件扫描；`main.ts:277-359`; `package.json:6-15`。
- **HYPOTHESIS**：审查包、CI、团队协作、跨数据库、AI 等方向是否有用户价值，当前仓库没有访谈、频率、留存、付费或替代工具成本数据；不能以代码可复用性替代需求证据。

## Files Found

| File Path | Description |
|---|---|
| `apps/desktop/src-core/types.ts` | 领域合同和当前模型边界 |
| `apps/desktop/src-core/diff.ts` | legacy MySQL DDL diff |
| `apps/desktop/src-core/data-diff.ts` | DML 生成和 literal |
| `apps/desktop/src-core/compare-filter.ts` | browser-safe shared filter seam |
| `apps/desktop/src-main/connection.ts` | transport/tunnel/pool seam 与生命周期债 |
| `apps/desktop/src-main/metadata.ts` | MySQL metadata provider 事实与查询 seam |
| `apps/desktop/src-main/data-fetch.ts` | row reader、分页和 threshold seam |
| `apps/desktop/src-main/data-run.ts` | identity/partial status/cancel orchestration |
| `apps/desktop/src-main/compare-run.ts` | 当前唯一应用级比较编排 |
| `apps/desktop/src-main/vault.ts` | local secret provider 和 export format |
| `apps/desktop/src-main/store-json.ts` | 当前 persistence implementation |
| `apps/desktop/src-main/converters/index.ts` | 未注册 reverse converter seam |
| `apps/desktop/src-main/converters/dbeaver.ts` | 已实现独立 exporter |
| `apps/desktop/src-main/preload.ts` | renderer→main API contract |
| `apps/desktop/src-renderer/store.ts` | state/action boundary 和 demo fallback |
| `apps/desktop/src-renderer/App.tsx` | UI composition boundary |
| `apps/desktop/src-renderer/sql.ts` | output/highlight/download boundary |
| `apps/desktop/vitest.config.ts` | 当前自动化收集范围 |
| `apps/desktop/tsconfig.main.json` | main/test 编译边界 |
| `.trellis/spec/backend/*.md` | 已记录的 runtime/security/quality contracts |
| `.trellis/spec/frontend/*.md` | 已记录的 renderer/state/CDP/a11y contracts |
| `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md` | 交付/环境证据 |
| `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md` | live connection/row evidence |

## Code Patterns

### 现有 application-service 形状（仍是 concrete）

```ts
runCompareRequest(req, { userDataDir, vault }, hooks)
  -> loadNodes(userDataDir)
  -> vault.getNodeSecret(...)
  -> createMysqlPool(...)
  -> fetchMetadata(...)
  -> compareRun(...)
  -> runDataCompare(...)
  -> appendHistory(...)
```

这是当前唯一完整比较编排，证据：`compare-run.ts:61-141`。它可被测试 fake 依赖，但 repository、secret provider、dialect 和 job 仍是 concrete context。

### 当前错误/部分结果模式

```text
SHOW CREATE error -> null -> skip object
table read error   -> DataTableStatus.error -> continue next table
threshold exceeded -> confirm-needed -> user reruns
user cancel       -> ABORTED/AbortError -> stop data run
history write err -> ignore -> return compare result
```

证据：`metadata.ts:190-201`; `data-run.ts:286-313`; `compare-run.ts:121-134`; `.trellis/spec/backend/error-handling.md:7-15,30-39`。

## External References

- 本文件没有新增外部资料；DBeaver/DataGrip 外部格式事实沿用归档研究：[DBeaver 格式研究](../../archive/2026-09/09-22-converters/research/dbeaver-connection-import.md) 与 [DataGrip/DataSpell 格式研究](../../archive/2026-09/09-22-converters/research/datagrip-dataspell-connection-import.md)。

## Related Specs

- `.trellis/spec/backend/directory-structure.md`
- `.trellis/spec/backend/database-guidelines.md`
- `.trellis/spec/backend/error-handling.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/backend/logging-guidelines.md`
- `.trellis/spec/backend/dbeaver-export.md`
- `.trellis/spec/frontend/directory-structure.md`
- `.trellis/spec/frontend/state-management.md`
- `.trellis/spec/frontend/component-guidelines.md`
- `.trellis/spec/frontend/quality-guidelines.md`
- `.trellis/spec/guides/cross-layer-thinking-guide.md`
- `.trellis/spec/guides/code-reuse-thinking-guide.md`

## Caveats / Not Found

- 这是接缝/债务盘点，不是实现建议或路线图；没有把“可以重构/添加”写成当前能力。
- 生成目录和 release 文件是 gitignored 的构建产物；关于 test files/包内文件的观察来自当前工作树，不是 tracked source。
- `mysqldiff/` 被根 `.gitignore` 忽略，只用于解释 legacy 兼容，不纳入当前桌面发布源。
- 没有外部客户、CI、真实异构数据库、DataGrip fixture 或生产性能数据；因此涉及扩展价值的内容均标为 INFERENCE/HYPOTHESIS。
