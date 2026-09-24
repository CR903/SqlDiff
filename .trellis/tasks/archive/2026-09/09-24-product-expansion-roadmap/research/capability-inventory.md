# Research: SqlDiff 产品能力盘点

- **Query**: 对当前 SqlDiff 仓库做 very thorough 的产品能力盘点，覆盖用户核心任务、现有功能边界、已实现/明确未实现能力，并为每条结论提供真实文件、符号、任务或测试证据。
- **Scope**: internal（当前源码、测试、项目规范、任务 PRD/设计/报告、Git 状态）
- **Date**: 2026-09-24
- **证据标记**: `FACT` = 直接由文件/测试/报告观察；`INFERENCE` = 从多个事实推导；`HYPOTHESIS` = 尚未被用户/市场证据验证的产品假设。本文不把任务文档中的计划或评论当作当前实现。

## Findings

### 1. 产品定位与核心用户任务

| 结论 | 证据 | 类型 |
|---|---|---|
| 产品当前是单机 Electron 桌面应用，核心价值是把 MySQL A/B 两个数据库的只读结构/数据差异转成可筛选、可复制、可导出的 SQL；应用不执行生成的 SQL。 | `README.md:1-2`；`apps/desktop/package.json:5`；`apps/desktop/src-main/compare-run.ts:61-65`；`.trellis/spec/backend/index.md:1-3`；`.trellis/tasks/09-24-product-expansion-roadmap/prd.md:11-15` | FACT |
| 用户的主闭环是：建立/选择节点 → 选择 A(Source) 与 B(Target) → 选范围和表过滤 → 运行只读对比 → 查看差异/风险/回滚 → 复制或导出 SQL。 | `apps/desktop/src-renderer/App.tsx:1637-1760`；`apps/desktop/src-renderer/store.ts:519-639`；`apps/desktop/src-main/compare-run.ts:53-135` | FACT |
| A 是来源/期望，B 是目标/待升级；输出方向是“把 B 对齐到 A”，不是反向同步。UI 将 A/B 明确标成 `SOURCE`/`TARGET`，并提供交换按钮。 | `apps/desktop/src-core/compare.ts:100-117`；`apps/desktop/src-renderer/App.tsx:373-380,450-455`；`apps/desktop/src-renderer/store.ts:283-287` | FACT |
| 当前应用没有账号、项目、云同步、审批或服务端 API；所谓“后端”在本项目中专指 Electron main process，不是 HTTP 后端。 | `.trellis/spec/backend/index.md:1-3`；`.trellis/spec/backend/directory-structure.md:3-6`；`apps/desktop/src-main/main.ts:1-39` | FACT |
| “离线可用”在运行时成立：应用不需要外部 AI/云服务即可完成本地存储、MySQL 读取、比较、复制和文件导出；但要实际读取数据库仍需可达的 MySQL/SSH 网络路径。 | `apps/desktop/src-main/main.ts:3-39`；`apps/desktop/src-renderer/store.ts:96-104`；`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/prd.md:61-64` | FACT；后半句为网络边界的 INFERENCE |

### 2. 端到端用户流程证据

1. **启动/预览**：`npm run dev` 只启动 Vite renderer；`getIpc()` 在没有 `window.sqldiff` 时返回 `null`，store 保留三条 seed 节点并可运行内置 demo。对应 `apps/desktop/package.json:8-9`、`apps/desktop/src-renderer/store.ts:76-104,231-259`、`apps/desktop/src-renderer/demo.ts:1-4,51-114`。
2. **节点发现与管理**：Electron 启动后 `refreshNodes()`/`refreshHistory()` 读取主进程；节点卡支持搜索、星标、测试、编辑、删除。见 `apps/desktop/src-renderer/App.tsx:72-162,194-339`、`apps/desktop/src-renderer/store.ts:409-485`。
3. **A/B 选择**：节点卡可拖拽或点击自动填入槽位，槽位也有下拉选择；支持交换、清空、恢复 localStorage 中的上次组合。见 `apps/desktop/src-renderer/App.tsx:346-400`、`apps/desktop/src-renderer/store.ts:263-290,106-126`。
4. **确定比较范围**：表/视图/过程/函数为结构范围；数据为独立开关；结构表过滤是大小写不敏感的表名子串过滤。见 `apps/desktop/src-renderer/App.tsx:403-499`、`apps/desktop/src-core/compare-filter.ts:79-117`。
5. **建立连接与取快照**：主进程并发建立 A/B pool，分别拉 `information_schema` 与 `SHOW CREATE`；元数据 `SHOW CREATE` 每类 map 有 10 worker 的保序限流。见 `apps/desktop/src-main/compare-run.ts:80-94`、`apps/desktop/src-main/metadata.ts:140-203`。
6. **生成结果**：表 ALTER 被拆成单语句条目；视图/过程/函数保持原子条目；每条带 change type、statement aspect、risk、explain、rollback。见 `apps/desktop/src-core/compare.ts:51-61,104-150`。
7. **查看与筛选**：中间差异表按 ALL/CREATE/DROP/CHANGE、对象、INDEX/切面、动词和表/数据关键字过滤；右侧展示当前过滤结果的 SQL、风险和回滚。见 `apps/desktop/src-renderer/App.tsx:506-649,1475-1559`、`apps/desktop/src-renderer/App.tsx:880-975`。
8. **复制/导出**：复制当前过滤列表或选中单条；含 DROP 时先 `window.confirm`；`.sql` 通过 renderer Blob 下载，主进程 `will-download` 指定 Downloads 路径。见 `apps/desktop/src-renderer/App.tsx:896-935`、`apps/desktop/src-renderer/sql.ts:101-125`、`apps/desktop/src-main/download.ts:17-39`。
9. **数据对比（可选）**：加载 A/B 表清单并同名配对，可手动改 B 表；设置分页批量、行数阈值、INSERT 分批；逐表串行处理，A/B 行读取并行。见 `apps/desktop/src-renderer/App.tsx:734-874`、`apps/desktop/src-main/compare-run.ts:96-119`、`apps/desktop/src-main/data-run.ts:255-321`。
10. **迁移辅助**：自定义加密 JSON 导入导出、老 CLI 连接串导入、DBeaver topology-only 导出均有 renderer/main/preload 路径。见 `apps/desktop/src-main/main.ts:210-253`、`apps/desktop/src-renderer/App.tsx:982-1098`、`apps/desktop/src-main/converters/dbeaver.ts:97-217`。

### 3. 当前能力矩阵

| 能力域 | 当前状态 | 已存在的具体能力 | 证据 |
|---|---|---|---|
| 节点库 | **已实现（有边界）** | 新增、编辑、删除、测试、搜索、全部/历史/我的/常用、星标、useCount、分组/标签字段 | `apps/desktop/src-main/main.ts:139-199`；`apps/desktop/src-renderer/App.tsx:72-339,1104-1373`；`apps/desktop/src-renderer/node-filter.ts:8-20` |
| 连接配置 | **已实现** | MySQL 直连；单跳 SSH；SSH 密码/私钥+passphrase；连接延迟返回 | `apps/desktop/src-main/connection.ts:55-103,301-390`；`apps/desktop/src-main/connection.test.ts:73-135` |
| 元数据读取 | **已实现（MySQL 语义）** | BASE TABLE、VIEW、PROCEDURE/FUNCTION 的列表和 `SHOW CREATE`；单对象失败转 null 并跳过 | `apps/desktop/src-main/metadata.ts:41-125,170-203`；`apps/desktop/src-main/metadata.test.ts:41-105,148-180` |
| 结构比较 | **已实现** | 表新增/删除、列/主键/索引变更、视图/过程/函数新增/删除/变更；表级语句拆分；DEFINER 归一 | `apps/desktop/src-core/diff.ts:24-242`；`apps/desktop/src-core/compare.ts:104-150`；`apps/desktop/src-core/diff.test.ts:104-292` |
| 数据比较 | **已实现但范围明确** | PK 优先；全列非空 UNIQUE 作为身份；联合主键；keyset 分页；COUNT 阈值；INSERT/DELETE/UPDATE；逐表状态、进度、取消 | `apps/desktop/src-core/data-pk.ts:17-143`；`apps/desktop/src-main/data-fetch.ts:33-135`；`apps/desktop/src-main/data-run.ts:121-321` |
| 结果过滤 | **已实现** | 结构 Tab、对象多选、aspect/INDEX、动词多选、关键字；复制/导出使用同一 `tabItems` | `apps/desktop/src-core/compare-filter.ts:63-118`；`apps/desktop/src-renderer/App.tsx:1475-1553,1726-1759` |
| SQL 展示 | **已实现** | sql-formatter MySQL 方言、`<pre>` 语法高亮、风险说明、回滚建议 | `apps/desktop/src-renderer/sql.ts:18-65`；`apps/desktop/src-renderer/App.tsx:937-973` |
| SQL 复制/导出 | **已实现** | 主进程剪贴板 + renderer fallback；DROP 二次确认；`.sql` 头注释与排序 | `apps/desktop/src-main/main.ts:340-357`；`apps/desktop/src-renderer/sql.ts:67-99`；`apps/desktop/src-core/compare.ts:156-173` |
| 节点持久化 | **已实现** | `nodes.json` 元数据、`history.json` 最近 20 条、safeStorage/AES-GCM secret vault、原子写 | `apps/desktop/src-main/store-json.ts:1-116`；`apps/desktop/src-main/vault.ts:61-316` |
| 节点迁移 | **已实现** | 自定义 v1 加密 JSON、老连接串导入 | `apps/desktop/src-main/vault.ts:274-316,390-420`；`apps/desktop/src-core/vault.test.ts:101-177` |
| DBeaver | **已实现结构验收** | 节点选择、全选/全不选、稳定 JSON、SSH topology、无秘密下载 | `apps/desktop/src-main/converters/dbeaver.ts:97-217`；`apps/desktop/src-renderer/App.tsx:982-1098`；`apps/desktop/src-main/converters/dbeaver.test.ts:23-172` |
| 历史 | **部分 UI** | main/preload 支持 list/append/clear，最近 20 条、恢复 A/B；renderer 目前只使用 list/refresh，未发现清空入口 | `apps/desktop/src-main/main.ts:257-275`；`apps/desktop/src-renderer/store.ts:435-444`；`apps/desktop/src-renderer/App.tsx:165-192` |
| 打包 | **已有产物，发布未闭环** | Electron Builder：Windows NSIS x64、macOS DMG x64/arm64；图标生成和包内资源已有证据 | `apps/desktop/electron-builder.yml:1-27`；`apps/desktop/scripts/generate-icon.mjs:231-302`；`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:101-111` |
| 真实目标环境 | **未完全验证** | Docker MySQL fixture、demo、旧 RDS/内网证据有记录；指定内网真库、SSH 私钥、Windows 真机仍未闭环 | `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:7-20,49-58,68-76`；`.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md:5-18,28-33` |
| 跨数据库/云/AI/自动执行 | **明确未实现** | 当前只面向 MySQL；无 PG/Oracle、云协作、AI、自动执行 SQL | `.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md:67-69`；`.trellis/tasks/09-24-product-expansion-roadmap/prd.md:27-32`；`apps/desktop/src-main/compare-run.ts:61-65` |

### 4. 已实现能力的细节与证据强度

#### 4.1 结构比较（FACT，强证据）

- 旧 CLI 语义被移植到纯 TypeScript：`filterTable` 忽略 AUTO_INCREMENT/CHECKSUM/DELAY_KEY_WRITE/ROW_FORMAT/DEFAULT 等文本片段，`filterField` 忽略 COMMENT；`diffTableField` 生成列、主键、`KEY` 索引的 ALTER。见 `apps/desktop/src-core/diff.ts:24-175`。
- `compareRun` 对 A/B 的表、视图、过程、函数做 union；`null` 代表 SHOW CREATE 不可用而跳过，缺失 map key 才代表对象不存在。见 `apps/desktop/src-core/compare.ts:63-150` 和对应测试 `apps/desktop/src-core/diff.test.ts:277-281`。
- 表语句按 `;\n` 拆分，id 使用 `:s<n>`；例程保持原子。见 `apps/desktop/src-core/diff.ts:65-79`、`apps/desktop/src-core/compare.ts:51-61`。
- 方向为 B 向 A 对齐，DEFINER 使用目标用户 `nodeB.user` 归一。见 `apps/desktop/src-main/compare-run.ts:92-94`、`apps/desktop/src-core/diff.ts:187-210`。

#### 4.2 数据比较（FACT，强证据 + 真实小表证据）

- 身份决策是 `decideIdentity`：PK 优先；否则两侧同一全列显式 `NOT NULL` UNIQUE；无身份则 skipped；列集不一致则 pk-mismatch。见 `apps/desktop/src-main/data-run.ts:121-166`。
- 读取先 `COUNT(*)`，超过默认 100,000 行且未确认时抛 `DataThresholdError`；分页使用主键范围 `ORDER BY ... LIMIT`，不是旧 CLI 的 `LIMIT 5000`。见 `apps/desktop/src-main/data-fetch.ts:1-8,49-135`、`apps/desktop/src-core/data-options.ts:1-77`。
- A/B 同一表并行读取，表与表之间串行；失败表记 error、阈值表记 confirm-needed，取消抛 ABORTED。见 `apps/desktop/src-main/data-run.ts:213-320`。
- DML 生成会转义值/标识符，INSERT 按批量切分，UPDATE 只写变化列；生成文本不送入 pool。见 `apps/desktop/src-core/data-diff.ts:30-142`、`apps/desktop/src-main/data-run.ts:7-8`。
- 真实只读冒烟已有 `buildings` 表 1/27 行，结果 inserts 0/deletes 26/updates 1；Docker fixture 另有联合主键、无主键、中文和阈值场景证据。见 `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md:20-26`、`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:9-12,33-44`。

#### 4.3 节点、秘密与历史（FACT，强证据）

- `NodeMeta` 只含连接拓扑/元数据；`SecretBundle` 单独承载 password、SSH password、privateKey、passphrase。见 `apps/desktop/src-core/types.ts:41-78`。
- `Vault` 优先 safeStorage；不可用时使用本地 32-byte master key + AES-256-GCM；secret 文件以 0600 写入。见 `apps/desktop/src-main/vault.ts:61-106,210-264`。
- 自定义导出 v1 的 secret 段是 AES-GCM；跨机器因 master key 不同会失败，测试覆盖。见 `apps/desktop/src-main/vault.ts:274-315`、`apps/desktop/src-core/vault.test.ts:101-140`。
- `history.json` 追加去重置顶并截断 20 条；main 在真实 compare 成功后 best-effort append，失败不阻塞结果。见 `apps/desktop/src-main/store-json.ts:98-115`、`apps/desktop/src-main/compare-run.ts:121-134`。
- 节点删除同时删 metadata 与 vault secret；E2E 有临时 user-data 清理断言。见 `apps/desktop/src-main/main.ts:180-189`、`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:29-32`。

### 5. 明确未实现、部分实现或仅有后端接口的能力

| 项目 | 结论 | 证据 |
|---|---|---|
| 自动执行 SQL | **明确不做**。代码没有任何执行 DiffItem.sql/DataDiffResult 的 pool.query 路径；只生成文本。 | `apps/desktop/src-core/data-diff.ts:1-4`；`apps/desktop/src-core/diff.ts:1-3`；`.trellis/spec/backend/index.md:1-3`；`.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md:67-69` |
| PostgreSQL/Oracle/其他数据库 | **明确不做首版**。连接配置、SQL、formatter 和 `SHOW CREATE` 均以 MySQL 为中心。 | `.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md:67-69`；`apps/desktop/src-main/connection.ts:88-102`；`apps/desktop/src-main/metadata.ts:41-50`；`apps/desktop/src-renderer/sql.ts:18-24` |
| 多跳/跳板 SSH | **明确不做**。当前 `ensureTunnel` 是一跳 forwardOut，没有 jump host 字段或循环。 | `apps/desktop/src-main/connection.ts:182-290`；`.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md:67-69` |
| DataGrip 导出 | **阻塞/未实现**。真实脱敏 `dataSources.xml`/`dataSources.local.xml` fixture 未提供，尤其 SSH 样本。 | `.trellis/tasks/09-24-datagrip-converter/prd.md:1-42` |
| DBeaver 真机导入 | **未验证**。结构化 JSON、CDP 下载和无秘密已验收，但环境无 DBeaver。 | `.trellis/tasks/archive/2026-09/09-22-converters/dbeaver-report.md:5-7,34-54` |
| 代码签名、公证 | **未配置/未验证**。构建产物报告为 unsigned。 | `apps/desktop/electron-builder.yml:1-27`；`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:101-111` |
| 自动更新 | **未配置**。builder 只有 target/icon；任务明确列为 out of scope。 | `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/prd.md:61-64` |
| CI/发布流水线 | **未发现仓库配置**；当前证据是本机手工 build/pack 和任务报告。 | `find` 未发现 `.github`/CI 配置；`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/implement.md:6-25` |
| Linux 当前桌面包 | **当前 builder 未声明 Linux target**；老 CLI README 的 Linux 支持不是当前 Electron 发布矩阵。 | `apps/desktop/electron-builder.yml:10-27`；`mysqldiff/README.md:36-37` |
| 结构对比真实目标库全量验证 | **部分验证**。旧 RDS 有 515/516 表、521 项只读结构证据；最新 E2E 指定内网库因不可达改用 Docker。 | `.trellis/tasks/archive/2026-09/09-21-desktop-m7-smoke/smoke-report.md:14-24`；`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:7-20,49-58` |
| SSH 私钥真机 | **未闭环**。密码认证/端口 22 有部分真机证据，私钥材料未提供，隧道转发被服务端拒绝。 | `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md:5-18,28-33`；`.trellis/tasks/archive/2026-09/09-22-verify-closeout/prd.md:31-33` |
| 历史清空 UI | **后端接口存在但未接入当前 UI**。`SqlDiffApi.history.clear` 和 main handler 存在；renderer 无 `clearHistory` action/call。 | `apps/desktop/src-main/main.ts:257-275`；`apps/desktop/src-main/preload.ts:122-126`；`apps/desktop/src-renderer/store.ts:138-229,435-444`（无 clear action） |
| 手动 pin 控件 | **字段/过滤存在，当前表单无 pin 控件**。`NodeMeta.pinned` 和 `fav` 判断存在；NodeModal 只编辑 star。 | `apps/desktop/src-core/types.ts:61-67`；`apps/desktop/src-renderer/node-filter.ts:13-18`；`apps/desktop/src-renderer/App.tsx:1289-1292` |
| 节点备注 | **首版 PRD 提到，但当前 NodeMeta/表单没有 notes 字段**。 | `.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md:22-25`；`apps/desktop/src-core/types.ts:51-70`；`apps/desktop/src-renderer/App.tsx:1242-1370` |
| 结构表多选 | **当前是范围 checkbox + 单个表名过滤，不是结构表清单多选**；数据表映射才有 A/B 行选择。 | `apps/desktop/src-renderer/App.tsx:459-480,734-846`；`.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md:33-36` |
| 独立 DML 三 Tab | **历史设计存在，但当前 UI 已合并到主 DiffTable**；当前用对象“数据”与 INSERT/UPDATE/DELETE 动词 chips 定位。 | `apps/desktop/src-renderer/App.tsx:34-39,47-54,595-615`；`.trellis/tasks/archive/2026-09/09-22-ui-fix-batch/design.md:8-23` |
| 结果基线/报告/评论/审批 | **不存在**。HistoryEntry 只保存时间、别名、id、差异数，不保存结果快照/审查状态。 | `apps/desktop/src-core/types.ts:118-128`；`apps/desktop/src-main/store-json.ts:98-115` |
| 可执行 rollback | **不存在**。rollback 是文本建议/占位，不是执行器。 | `apps/desktop/src-core/risk.ts:37-116`；`apps/desktop/src-renderer/App.tsx:960-971` |

### 6. 证据覆盖与当前验证状态

- **FACT / 当前自动门禁**：2026-09-24 在 `apps/desktop` 运行 `npm test` 得到 17 个 test files、167 tests 全通过；`npm run typecheck` 和 `npm run lint` 也无输出错误。测试清单由 `find src-core src-main src-renderer -name '*.test.ts` 得到 17 个文件。
- **FACT / 真实 E2E**：最新归档报告记录 22/22 测试动作在 demo/Docker fixture 范围完成，T2/T3/T4/T5/T6/T7/T8 有截图或临时文件断言；指定内网真库和 Windows 真机仍明确未闭环。见 `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:22-58`。
- **FACT / 历史真库**：M7 记录 515/516 表、0 view/routine，521 项结构差异，DROP 332/CREATE 15/CHANGE 174；只读执行约束写在报告开头。见 `.trellis/tasks/archive/2026-09/09-21-desktop-m7-smoke/smoke-report.md:1-35`。
- **INFERENCE**：核心算法和单机桌面闭环已有“可用且可回归”的证据；由于缺少真实用户访谈、持续使用数据、目标内网/Windows/SSH 私钥闭环，不能把它等同于经过市场验证的成熟产品。
- **HYPOTHESIS**：用户是否需要把一次对比结果保存为可交接审查包、是否需要 headless/CI 入口，当前仓库没有用户研究证据；不能从技术可复用性直接推出需求频率。

## Related Specs

- `.trellis/spec/backend/index.md` — main/core 边界、只读契约、进程分层。
- `.trellis/spec/backend/database-guidelines.md` — 查询、连接池、并发、方向和数据身份规则。
- `.trellis/spec/backend/error-handling.md` — IPC 错误、部分失败、清理和 renderer 消毒。
- `.trellis/spec/backend/quality-guidelines.md` — 安全不变量、比较不变量、测试和打包。
- `.trellis/spec/backend/dbeaver-export.md` — DBeaver topology-only contract。
- `.trellis/spec/frontend/index.md`、`state-management.md`、`component-guidelines.md`、`quality-guidelines.md` — 当前 renderer 状态、组件、CDP 和 a11y 边界。
- `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md` — 最新 E2E 与环境限制证据。
- `.trellis/tasks/09-24-datagrip-converter/prd.md` — 明确阻塞的 DataGrip 方向。

## Caveats / Not Found

- `python3 ./.trellis/scripts/task.py current --source` 在本次子代理会话返回 `(none)`，但用户明确指定了当前任务目录；本文件按用户给出的 `.trellis/tasks/09-24-product-expansion-roadmap/research/` 写入。
- 根 `.gitignore:2-3` 忽略整个 `mysqldiff/`；旧 CLI 源码仍在工作树中，但不属于当前 Git tracked files。它只能作为历史行为参考，不能被当作当前发布物的一部分。
- 当前源码注释仍有少量历史漂移：例如 `apps/desktop/src-main/metadata.ts:8` 仍写“首版不做数据对比”、`apps/desktop/src-main/preload.ts:73` 仍写 `NOT_IMPLEMENTED`；实际数据比较和连接测试已在后续任务/源码中落地。`apps/desktop/README.md:53` 当前已更新为“DBeaver 拓扑导出；DataGrip 转换等待真实 fixture”，与源码方向一致。后续引用应以符号和当前测试为准。
- 未发现 React Testing Library、jsdom、端到端测试框架配置或持久化应用日志系统；`apps/desktop/vitest.config.ts:3-5` 只收集三目录的 `*.test.ts`。
