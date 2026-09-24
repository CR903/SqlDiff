# Research: 技术债、已知边界与可复用 seam

- **Query**: 识别当前 SqlDiff 实现中的技术债、明确限制、测试/文档漂移和可复用模块边界；只描述现状，不提出代码修改方案。
- **Scope**: internal
- **Date**: 2026-09-24
- **证据标记**: `FACT` = 源码/测试/任务直接观察；`INFERENCE` = 从事实推导；`HYPOTHESIS` = 需要产品/用户验证的未知。

## Findings

### 1. 比较引擎的技术边界

#### 1.1 结构解析是 legacy-compatible 的行/正则解析

- `filterTable` 通过正则忽略 `AUTO_INCREMENT`、`CHECKSUM`、`DELAY_KEY_WRITE`、`ROW_FORMAT`、`DEFAULT` 和 COMMENT；`diffTableField` 逐行识别列、`PRIMARY KEY` 和以 `KEY \`` 开头的普通索引。证据：`apps/desktop/src-core/diff.ts:24-44,81-175`。
- **FACT**：代码没有独立的 AST、MySQL parser 或 foreign key/check/constraint/partition 等结构对象模型；它是 `SHOW CREATE` 文本比较器。证据：整个 `apps/desktop/src-core/diff.ts` 的实现只使用 `split`、`replace`、正则和 `Record<string,string>`。
- **INFERENCE（高置信）**：对超出 legacy 测试样本的 MySQL DDL 形态，行为是“沿用文本规则/可能未识别”，不是完整语义 diff。现有测试覆盖列、主键、`KEY` 索引、procedure/function/view，但没有 FK/CHECK/复杂约束 fixture。证据：`apps/desktop/src-core/diff.test.ts:104-148,150-194`。
- `changeProcedure` 用 DEFINER 正则处理新建/变更例程；无目标 DEFINER 时保留原文或降级，而不是完整解析例程依赖。证据：`apps/desktop/src-core/diff.ts:177-210`。
- 视图/过程/函数条目保持原子，表条目才会按分号换行拆分；这是明确的模型边界。证据：`apps/desktop/src-core/diff.ts:65-79`、`apps/desktop/src-core/compare.ts:55-61`。

#### 1.2 分类、风险和过滤是确定性规则而非外部分析

- `classify` 只按 DROP/CREATE/OR REPLACE/其他文本规则分 CREATE/DROP/CHANGE；`aspectOf` 用正则区分 table/primary/index/column/routine；`verbOf` 取跳过注释后的首关键字。证据：`apps/desktop/src-core/classify.ts:1-94`。
- `assessRisk` 是本地三档规则，rollback 是建议文本/占位模板；没有数据库统计、锁分析、依赖图或执行计划。证据：`apps/desktop/src-core/risk.ts:1-117`。
- **FACT**：ALTER/DROP 的风险解释不能反映实际表规模、锁时长、外键依赖或业务语义；代码没有收集这些信息。证据：`apps/desktop/src-core/risk.ts:37-116`、`apps/desktop/src-main/compare-run.ts:86-119`。
- 表/数据过滤和 verb 过滤是共享纯函数；`postFilterResult` 会重算 stats，保证结果列表和计数同源。证据：`apps/desktop/src-core/compare-filter.ts:46-60,79-118`；测试 `apps/desktop/src-core/ddl-dml-index.test.ts:131-214`、`apps/desktop/src-core/verb-search.test.ts:106-241`。

#### 1.3 生成文本不执行，但对外部执行者没有闭环

- **FACT**：DiffItem/DML 是输出模型；main 只在 metadata/data-fetch/connection 中执行读取 SQL。证据：`apps/desktop/src-core/types.ts:87-104`、`apps/desktop/src-main/compare-run.ts:61-141`、`apps/desktop/src-main/data-run.ts:255-320`。
- **FACT**：结构 DDL 的对象名仍有 legacy 反引号插值；数据 DML 做了值/标识符转义。证据：`apps/desktop/src-core/diff.ts:59-60,141-169`、`apps/desktop/src-core/data-diff.ts:36-68`。
- **INFERENCE**：应用内只读边界清晰，但用户手工把导出 SQL 交给其他执行器时，SqlDiff 不提供执行前 schema recheck、事务包装、失败恢复或审计记录。仓库中没有相应 API/字段。

### 2. 数据比较的已知规模与形状限制

- `fetchAllByPK` 逐页读取后把整表放入 `DataRow[]`，再在 `diffDataRows` 建 A/B Map；不是 cursor/stream/外部排序合并。证据：`apps/desktop/src-main/data-fetch.ts:105-134`、`apps/desktop/src-core/data-diff.ts:89-142`。
- 表与表串行能限制同时处理的表数，但单表行数据仍在内存中；代码没有按行流式输出 DiffItem。证据：`apps/desktop/src-main/data-run.ts:286-313`、`apps/desktop/src-main/data-fetch.ts:122-134`。
- `COUNT(*)` 阈值默认 100,000，超阈需要二次确认；这保护了明显大表，但不是资源配额、流控或磁盘 spill。证据：`apps/desktop/src-main/data-fetch.ts:114-121`、`apps/desktop/src-core/data-options.ts:13-23`。
- BLOB/Buffer 当前以 `Buffer.toString('utf8')` 进入 SQL literal；没有二进制编码、hash、长度上限或截断提示。证据：`apps/desktop/src-core/data-diff.ts:64-68`；data-diff PRD 将 BLOB 大字段优化列为 out of scope：`.trellis/tasks/archive/2026-09/09-21-data-diff-v2/prd.md:29-32`。
- INSERT 没有显式列名，依赖 `Object.keys(rows[0])` 的 values 顺序；没有独立的 A/B 列集合/类型/顺序兼容检查。证据：`apps/desktop/src-core/data-diff.ts:75-81,126-135`。
- UPDATE 使用 A 行的列集合，列值以宽松 `==` 比较；没有显式的 B 列存在性、类型、generated column、trigger 或 collation 检查。证据：`apps/desktop/src-core/data-diff.ts:126-135`。
- `getDataPKV` 用 `String(row[col])` 和 NUL 拼接 key；身份资格在 DDL 层保证非空，但不同驱动值类型的字符串化边界没有额外碰撞测试。证据：`apps/desktop/src-core/data-diff.ts:41-45`；现有数据测试覆盖数字/字符串和联合键，但没有类型碰撞矩阵：`apps/desktop/src-core/data-diff.test.ts:68-86`。
- **INFERENCE（中等置信）**：这些限制使数据对比更适合“小表/明确 schema/可验证身份”的迁移检查，而不是通用 CDC、同步或异构数据治理；该判断是能力边界推论，不是对用户需求的判断。

### 3. 连接与资源生命周期的已知边界

- Pool 构造使用 `Promise.all` 后再解构赋值；若一端成功、一端失败，可能无法持有已创建 pool 引用。项目规范把它明确记录为 partial pool-construction gap。证据：`apps/desktop/src-main/compare-run.ts:80-85,139-141`、`apps/desktop/src-main/data-run.ts:275-279,314-316`、`.trellis/spec/backend/database-guidelines.md:27-31`。
- 正常退出启动 `closeAll()` 但不 await；单节点 `closeTunnel` 存在，却没有在 node update/delete 路径显式调用。证据：`apps/desktop/src-main/main.ts:408-411`、`apps/desktop/src-main/main.ts:162-189`、`apps/desktop/src-main/connection.ts:392-427`。
- 隧道缓存 key 是 nodeId；如果节点连接参数在缓存存在期间被更新，当前 `ensureTunnel` 命中缓存后不会根据新 host/credential 重建。证据：`apps/desktop/src-main/connection.ts:232-240`、`apps/desktop/src-renderer/store.ts:446-456`、main update `apps/desktop/src-main/main.ts:162-177`。这是静态调用关系推导，标记为 INFERENCE。
- 单个 `dataAbort` controller 存在 main 进程全局；`compare.cancel` 会 abort 当前 controller。renderer 正常用 `comparing` 防止重复点击，但直接 IPC 调用的并发语义未单独测试。证据：`apps/desktop/src-main/main.ts:280-287,316-338`、`apps/desktop/src-renderer/store.ts:519-521`。
- 连接配置没有 TLS/SSL、代理、socket path、server name、charset、连接池参数 UI；`buildMysqlConfig` 只填 host/port/user/password/database/connectTimeout。证据：`apps/desktop/src-main/connection.ts:88-102`、`apps/desktop/src-core/types.ts:41-69`。
- SSH 是单跳；没有 jump host、多跳、agent auth、host-key 配置 UI。代码和 PRD 都只描述单跳 password/privateKey。证据：`apps/desktop/src-main/connection.ts:55-85`、`.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md:67-69`。

### 4. 存储、秘密与导入的边界

- `nodes.json`/`history.json` 读取损坏时返回空数组，而不是迁移/修复/提示；只有类型过滤。证据：`apps/desktop/src-main/store-json.ts:34-50,84-103`。
- 导入按 node id upsert 到当前 nodes；相同 id 会覆盖 metadata/secret。证据：`apps/desktop/src-main/main.ts:224-235`。
- 自定义 JSON v1 依赖本机 master key；跨机器导入明确失败。证据：`apps/desktop/src-main/vault.ts:127-147,292-315`、`apps/desktop/src-core/vault.test.ts:130-140`。
- NodeMeta 包含 `pinned/useCount/tags/group`，但 UI 只提供 star、group、tags 输入；手动 pinned 和 notes 没有完整编辑流。证据：`apps/desktop/src-core/types.ts:50-70`、`apps/desktop/src-renderer/App.tsx:1120-1182,1282-1292`。
- `history.clear` 已在 main/preload 存在，但 renderer store 没有对应 action；这是“后端能力已写、UI 未接线”的接口漂移。证据：`apps/desktop/src-main/main.ts:257-275`、`apps/desktop/src-main/preload.ts:82-86`、`apps/desktop/src-renderer/store.ts:138-229`。
- DBeaver exporter 与未来反向 `NodeConverter` registry 方向相反且明确分离；当前 registry 为空。证据：`apps/desktop/src-main/converters/index.ts:1-32`、`apps/desktop/src-main/converters/dbeaver.ts:1-7`。

### 5. Renderer/主进程耦合和维护性边界

- `App.tsx` 1783 行、`store.ts` 651 行；NodeLibrary、CompareSlots、DiffTable、DataSection、SqlPreview、两个 modal 都在同一文件。证据：源码行数（`wc -l`）和 `apps/desktop/src-renderer/App.tsx:1-18,68-70,1375-1783`。
- **FACT**：没有项目自定义 hooks 目录；hooks 就地放在组件/store 中。证据：`.trellis/spec/frontend/hook-guidelines.md:3-14`。
- **FACT**：没有 React Testing Library/jsdom/accessibility 自动化；交互质量靠 pure Vitest + CDP。证据：`.trellis/spec/frontend/quality-guidelines.md:12-20,40-60`。
- `SqlPreview` 仍保留 `extraItems` 兼容参数，但当前 App 将结构/数据 items 合并后只传 `tabItems`；这是历史数据分区重构后的兼容 seam。证据：`apps/desktop/src-renderer/App.tsx:880-900,1753-1759`、`.trellis/tasks/archive/2026-09/09-22-ui-fix-batch/design.md:8-23`。
- renderer 的过滤链在 `App.tsx` 重新实现一遍，而 core 另有 `postFilterResult`；两处通过 item 字段保持语义，但这是跨层重复维护面。证据：`apps/desktop/src-core/compare-filter.ts:79-118`、`apps/desktop/src-renderer/App.tsx:1475-1553`、`.trellis/spec/frontend/state-management.md:39-43`。
- `formatSqlSafe` 在 renderer 与 main `sql.format` 都有 sql-formatter fallback；当前 App 主要使用 renderer helper，IPC formatter 仍保留。证据：`apps/desktop/src-renderer/sql.ts:18-26`、`apps/desktop/src-main/main.ts:340-350`、`apps/desktop/src-renderer/App.tsx:902-907`。
- 当前源码注释仍有历史漂移：`apps/desktop/src-main/metadata.ts:8` 仍称数据比较 deferred，`apps/desktop/src-main/preload.ts:73` 仍称 `nodes.test` 是 NOT_IMPLEMENTED；实际 `data-run.ts`、`connection.ts` 已实现相应路径。`apps/desktop/README.md:53` 当前已反映 DBeaver topology export/DataGrip fixture pending，与源码方向一致。证据：这些行与当前实现形成对照；注释漂移本身是 FACT。

### 6. 可观测性、错误和测试边界

- 应用无持久化 logger；错误通过 rejected IPC、typed status、toast 和任务报告观察。证据：`.trellis/spec/backend/logging-guidelines.md:3-31`。
- 单对象 SHOW CREATE 失败是容错 null；表数据失败是单表 error 继续；这些策略有测试或任务证据，但 `runCompareRequest` 的完整 A/B 失败/部分 pool 场景没有独立 orchestration test 文件。证据：`apps/desktop/src-main/metadata.ts:190-201`、`apps/desktop/src-main/data-run.ts:286-313`、测试文件清单中无 `compare-run.test.ts`。
- 当前 Vitest 17 files/167 tests 已在 2026-09-24 全绿；但测试主要是 pure/injected fake，真实 DB/SSH 依赖 E2E 报告和手工 smoke。证据：本次 `npm test` 输出、`apps/desktop/vitest.config.ts:3-5`、`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:1-12`。
- E2E 报告保留断言和部分截图，但原始 clipboard/Downloads/temp user-data 原始日志未持久化；审计级复现需要重跑。证据：`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:51-58`。
- 目标内网真库、SSH 私钥/隧道、Windows 真机和 DBeaver IDE import 仍不是自动化门禁覆盖的事实。证据：`.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md:5-18,28-33`、`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:14-20,49-58`、`.trellis/tasks/archive/2026-09/09-22-converters/dbeaver-report.md:50-54`。

### 7. 可复用 seam 清单

| Seam | 当前接口/符号 | 可复用范围（事实描述） | 证据 |
|---|---|---|---|
| 领域契约 | `NodeMeta`, `SecretBundle`, `CompareRequest`, `CompareResult`, `DiffItem`, `DataTableStatus` | 主进程、core、renderer 共享的跨层数据形状 | `apps/desktop/src-core/types.ts:41-207` |
| Bridge | `SqlDiffApi`, `NodeCreateInput`, `DataTableLists`, `CompareProgressEvent` | 唯一 renderer→main API；新增能力需在这里扩展 | `apps/desktop/src-main/preload.ts:21-156` |
| 纯比较 core | `compareRun`, `diffTable`, `diffProcedure`, `classify`, `aspectOf`, `riskFor`, `postFilterResult` | 不依赖 Node API 的确定性比较/分类/风险/过滤逻辑 | `apps/desktop/src-core/compare.ts:104-154`、`apps/desktop/src-core/classify.ts:18-94`、`apps/desktop/src-core/risk.ts:23-117`、`apps/desktop/src-core/compare-filter.ts:85-118` |
| 结构快照 | `DatabaseMetadata`, `fetchMetadata`, `listTables/listViews/listRoutines` | 以 `DbQueryable` 最小 query 接口拉取元数据，可注入 fake | `apps/desktop/src-main/metadata.ts:16-39,170-203` |
| 比较编排 | `runCompareRequest({req,ctx,hooks})` | 接收 `CompareRunContext` 与 table/fetch hooks，调用连接、core、history | `apps/desktop/src-main/compare-run.ts:32-65` |
| 数据编排 | `runDataCompare`, `decideIdentity`, `DataRunOptions` | 表映射、身份、状态、进度、取消、阈值的独立入口 | `apps/desktop/src-main/data-run.ts:29-53,113-166,255-321` |
| 连接 transport | `createMysqlPool`, `ensureTunnel`, `testConnection`, `DbQueryable` | 直连/SSH pool 与可注入 tunnel fake；调用者拥有 pool 生命周期 | `apps/desktop/src-main/connection.ts:127-138,301-390`、`apps/desktop/src-main/metadata.ts:16-19` |
| 秘密/存储 | `Vault`, `SafeStorageLike`, `loadNodes/saveNodes`, `appendHistory` | 本地 secret 与 metadata/history 的独立边界；支持 `SQLDIFF_USER_DATA_DIR` | `apps/desktop/src-main/vault.ts:19-24,183-316`、`apps/desktop/src-main/store-json.ts:15-28,84-115` |
| 转换器 | `NodeConverter`, `ConvertedNode`, `converters` | 反向第三方配置→SqlDiff 的注册入口，目前空；DBeaver topology export 是独立方向 | `apps/desktop/src-main/converters/index.ts:6-32`、`apps/desktop/src-main/converters/dbeaver.ts:1-7` |
| 文件策略 | `buildDownloadSavePath`, `handleWillDownload`, `downloadTextFile` | renderer Blob 与 main save path 配对 | `apps/desktop/src-main/download.ts:7-39`、`apps/desktop/src-renderer/sql.ts:101-125` |
| UI store | `useDesktopStore` actions | 把 durable main state、跨组件 workflow、派生过滤集中；组件本地表单仍局部 | `.trellis/spec/frontend/state-management.md:3-25`、`apps/desktop/src-renderer/store.ts:138-229` |
| 测试替身 | `DbQueryable`, `SafeStorageLike`, `TunnelClient`, `DownloadSessionLike` | 让纯逻辑/存储/下载路径无需 Electron 或 live DB | `apps/desktop/src-main/metadata.ts:16-19`、`apps/desktop/src-main/vault.ts:19-24`、`apps/desktop/src-main/connection.ts:127-138`、`apps/desktop/src-main/download.ts:7-15` |

### 8. 技术债分类（事实化记录）

| 类别 | 观察到的状态 | 证据/置信度 |
|---|---|---|
| 语义覆盖 | legacy text diff 未覆盖完整 MySQL schema 对象；例程拆分保持原子 | FACT：`apps/desktop/src-core/diff.ts:81-242`；INFERENCE：未列对象行为未验证 |
| 规模 | keyset 分页替代 5000 全量，但单表仍 materialize；无 stream/spill | FACT：`apps/desktop/src-main/data-fetch.ts:105-134` |
| 数据类型 | BLOB 转 UTF-8；无二进制策略 | FACT：`apps/desktop/src-core/data-diff.ts:64-68` |
| 资源 | pool partial construction gap；before-quit 不 await；tunnel 无显式 node invalidation | FACT：源码与 `.trellis/spec/backend/database-guidelines.md:27-31` |
| 连接覆盖 | 单跳 SSH password/privateKey；无多跳/TLS/agent UI | FACT：`apps/desktop/src-main/connection.ts:55-102`、PRD |
| UI 语义 | demo fallback 与真实 result 共用 items；history clear/pinned/notes 等接口存在但无完整 UI | FACT：`apps/desktop/src-renderer/store.ts:611-629`、调用点搜索 |
| 可观测性 | 无应用 logger；交互依赖 CDP/任务报告 | FACT：`.trellis/spec/backend/logging-guidelines.md:3-15` |
| 质量门禁 | pure Vitest 绿，真实 DB/SSH/IDE/Windows 依赖环境证据 | FACT：本次测试输出、`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md` |
| 发布 | unsigned、无 updater、无 CI、builder 无 Linux | FACT：`apps/desktop/electron-builder.yml`、E2E report |
| 互操作 | DBeaver 结构化导出已实现但真 IDE 未验；DataGrip blocked；reverse registry 空 | FACT：converter PRD/report、`converters/index.ts` |
| 文档 | 旧注释/README 与当前实现漂移 | FACT：metadata/preload/README 行与当前符号对照 |

### 9. 由技术边界导出的产品含义（仅作能力解释）

- **INFERENCE**：SqlDiff 当前最适合被描述为“本地、只读、MySQL 定向的迁移差异检查器”，而不是数据库管理平台、执行器或协作平台。依据是 transport、metadata、core、UI 和部署矩阵均围绕单机 MySQL 读取。
- **INFERENCE**：技术复用面最清晰的是 `src-core` + `runCompareRequest`/`runDataCompare` 的纯 core/编排边界；任何新产品方向是否值得做，仍取决于用户问题是否真实，而不是 seam 数量。
- **HYPOTHESIS**：大表/BLOB/无主键是否构成用户主要阻塞，当前没有使用频率或数据规模分布证据；它们是已知能力边界，不应直接升级为需求优先级。

## Related Specs

- `.trellis/spec/backend/directory-structure.md`
- `.trellis/spec/backend/database-guidelines.md`
- `.trellis/spec/backend/error-handling.md`
- `.trellis/spec/backend/logging-guidelines.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/frontend/directory-structure.md`
- `.trellis/spec/frontend/state-management.md`
- `.trellis/spec/frontend/quality-guidelines.md`
- `.trellis/spec/guides/cross-layer-thinking-guide.md`
- `.trellis/spec/guides/code-reuse-thinking-guide.md`

## Caveats / Not Found

- 本文件没有对代码提出修改、重构或功能建议；只记录当前 seam、限制和证据。
- “未实现”不等于“代码中完全没有相关字符串”：例如 `history.clear`、pinned、DML type 仍存在，但当前 UI/执行路径不完整，已在 capability inventory 中区分。
- 旧 CLI `mysqldiff/` 的存在不改变当前发布能力；它被根 `.gitignore` 忽略，源码仅用于行为对照。
