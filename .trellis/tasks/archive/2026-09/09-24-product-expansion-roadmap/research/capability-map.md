# Research: SqlDiff 当前能力地图（服务器重启后复核）

- **Query**: very thorough 盘点当前 SqlDiff 的能力、用户流程、架构边界、已实现/未实现能力、技术债与可复用 seam；每条结论区分事实、推断和待验证假设。
- **Scope**: internal（`apps/desktop` 当前源码、单测、构建/打包配置、Trellis specs、归档任务 PRD/设计/报告、Git 状态）
- **Date**: 2026-09-24
- **Snapshot**: `HEAD=f51d562`；研究采集时产品代码无工作树改动，`apps/desktop/README.md` 存在一处用户已有未提交文档改动；研究文件写入当前任务的 `research/`。本次 Check Agent 只修正任务文档，未修改产品代码。
- **证据标记**:
  - **FACT**：可在当前源码、测试、任务报告或实际复核命令中直接观察。
  - **INFERENCE**：由一个或多个 FACT 推导出的产品/架构含义，标明推理链。
  - **HYPOTHESIS**：尚无用户访谈、付费/使用数据或真实环境证据支持的产品判断，不当作已实现能力或已证实需求。
- **路径约定**：正文表格/段落中未重复写 `apps/desktop/` 前缀的 `src-core/*`、`src-main/*`、`src-renderer/*`、`App.tsx` 等引用，均相对于 `apps/desktop/`；`.trellis/tasks/archive/...` 与当前任务路径按仓库实际路径书写。

## Findings

### 0. 本次复核基线

- **FACT**：当前应用是 Electron main process + Vite/React renderer + TypeScript shared core，版本为 `0.1.0`；生产依赖含 `mysql2`、`ssh2`、`sql-formatter`、`zustand` 和 `monaco-editor`。证据：`apps/desktop/package.json:2-6,18-43`。
- **FACT**：本次在 `apps/desktop` 重新执行 `npm test -- --run` 得到 **17 个 test files、167 tests passed**；`npm run typecheck` 和 `npm run lint` 均无错误输出。证据：本次命令输出（2026-09-24）；Vitest 收集范围见 `apps/desktop/vitest.config.ts:1-5`。
- **FACT**：研究采集阶段没有重新执行会写入 `dist-*`/`release` 的 `npm run build` 或 `npm run pack`；本次 Check Agent 质检阶段另行运行了 `npm run build`（未运行 pack）。最新构建/包核验仍引用归档报告 `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:101-111`，不能把它误写成此次 pack 结果。
- **FACT**：产品源码、测试和归档报告共同确认的核心安全边界是“读取目标 MySQL、生成 SQL、永不执行生成 SQL”。证据：`.trellis/spec/backend/index.md:1-3,18-23`；`.trellis/spec/backend/database-guidelines.md:15-23`；执行查询检索只发现 `SELECT`/`COUNT`/`information_schema`/`SHOW CREATE`，对应 `src-main/connection.ts:321-354`、`src-main/metadata.ts:78-138`、`src-main/data-fetch.ts:49-85`。

### 1. 产品形态与核心用户任务

#### 1.1 当前产品是什么

- **FACT**：当前产品是一个**本地单机桌面工具**，不是 HTTP 服务、云端产品、团队平台或数据库迁移执行器。`main.ts` 是 Electron composition root，`preload.ts` 暴露 `window.sqldiff`，renderer 只通过该桥访问主进程。证据：`apps/desktop/src-main/main.ts:41-67,277-359,367-411`；`apps/desktop/src-main/preload.ts:66-150`；`.trellis/spec/backend/index.md:1-3`。
- **FACT**：核心价值是把两个 MySQL 数据库的只读结构/行差异变成可筛选、可预览、可复制、可导出的 SQL。证据：`apps/desktop/src-main/compare-run.ts:53-65,96-135`；`apps/desktop/src-renderer/App.tsx:506-649,880-975`；`.trellis/tasks/09-24-product-expansion-roadmap/prd.md:10-15`。
- **FACT**：A 被标为 `SOURCE`、B 被标为 `TARGET`；比较方向固定为“把 B 对齐到 A”，即生成升级 B 的 SQL。证据：`apps/desktop/src-renderer/App.tsx:346-380,450-455`；`apps/desktop/src-core/compare.ts:100-117`；`apps/desktop/src-main/compare-run.ts:92-94`。
- **FACT**：旧 `mysqldiff/` 是兼容行为参考，不是新桌面实现的运行路径；当前规范明确将其视为只读历史区域。证据：`.trellis/spec/backend/directory-structure.md:43-47`；`apps/desktop/src-core/diff.ts:1-15`；`.trellis/tasks/09-24-product-expansion-roadmap/prd.md:27-32`。

#### 1.2 用户要完成的核心任务

以下是代码直接呈现的任务，不等同于已验证的市场需求：

1. **FACT**：建立或找回可连接的 MySQL 节点，并测试连通性。节点模型含 alias、host、port、user、database、分组、标签、收藏/频次和单个 SSH 配置；秘密单独存储。证据：`apps/desktop/src-core/types.ts:41-78`；`apps/desktop/src-renderer/App.tsx:1104-1373`；`apps/desktop/src-main/main.ts:139-253`。
2. **FACT**：选择 A/B 两个节点，拖拽或下拉放入槽位，交换/清空，并可恢复上次 A/B 组合。证据：`apps/desktop/src-renderer/App.tsx:346-400`；`apps/desktop/src-renderer/store.ts:54,106-126,263-290`。
3. **FACT**：选择结构范围（表/视图/过程/函数）、是否包含数据行，以及表名子串过滤；可选地配置数据表映射和数据分页选项。证据：`apps/desktop/src-renderer/App.tsx:403-499,734-874`；`apps/desktop/src-renderer/store.ts:239-249,327-365,519-571`。
4. **FACT**：运行一次只读比较，查看差异条目、风险、回滚建议和 SQL，并按需要复制或导出。证据：`apps/desktop/src-main/compare-run.ts:61-135`；`apps/desktop/src-renderer/App.tsx:506-649,880-975`。
5. **FACT**：把节点拓扑迁移到 DBeaver，或用加密自定义 JSON 备份/恢复，或粘贴旧 CLI 连接串。证据：`apps/desktop/src-renderer/App.tsx:251-283,1605-1635`；`apps/desktop/src-main/converters/dbeaver.ts:97-217`；`apps/desktop/src-main/vault.ts:274-315,390-420`。
6. **FACT**：查看最近 20 次比较的摘要，并在节点仍存在时从历史恢复 A/B 组合。证据：`apps/desktop/src-core/types.ts:118-128`；`apps/desktop/src-main/store-json.ts:98-115`；`apps/desktop/src-renderer/App.tsx:165-192,1564-1575`。

- **INFERENCE**：从上述代码路径可推导，当前产品主要服务“需要人工审阅一次 MySQL A→B 差异并拿到 SQL”的桌面工作流；这描述的是已实现工作流，不是对目标用户角色或频率的证明。推理依据：`App.tsx:403-975`、`compare-run.ts:53-135`；仓库没有访谈、遥测、付费或留存数据。

### 2. 端到端用户流程与状态流

#### 2.1 启动、节点库和历史

- **FACT**：Electron ready 时注册 IPC、下载策略并创建 1440×900、最小 1100×680 的窗口；renderer 首屏 effect 调用 `refreshNodes` 和 `refreshHistory`。证据：`apps/desktop/src-main/main.ts:394-402`；`apps/desktop/src-renderer/App.tsx:1450-1454`。
- **FACT**：无 IPC 的 Vite 预览会使用三条 seed 节点；有 IPC 时 `refreshNodes` 只有在返回数组非空时才替换当前节点，失败时保留 seed。证据：`apps/desktop/src-renderer/store.ts:76-104,409-433`。
- **FACT**：节点卡支持拖拽/点击选取、星标、测试、编辑、删除；节点库工具支持加密 JSON 导出/导入、DBeaver 导出和旧连接串导入。证据：`apps/desktop/src-renderer/App.tsx:72-162,194-339`；`apps/desktop/src-renderer/store.ts:446-517`。
- **FACT**：节点关键字搜索覆盖 alias/host/database/group，不覆盖 tags；历史关键字只过滤 A/B alias。证据：`apps/desktop/src-renderer/node-filter.ts:8-19`；`apps/desktop/src-renderer/App.tsx:237-241`。
- **FACT**：节点删除同时删除 `nodes.json` 元数据和 Vault 中对应 secret；创建时若 metadata 已写入但 secret 保存失败，代码会回滚节点。证据：`apps/desktop/src-main/main.ts:142-189`。
- **FACT**：历史条目只保存时间、A/B alias、可选 node id 和差异数，不保存 scopes、过滤条件、数据选项、SQL、快照或审查结论。证据：`apps/desktop/src-core/types.ts:118-128`；`apps/desktop/src-main/store-json.ts:98-115`。
- **INFERENCE**：历史目前更像“最近运行索引”，不是可恢复的比较项目或审计记录；依据是 `HistoryEntry` 字段集合和 `restoreHistory` 只恢复两个 slot。

#### 2.2 A/B 选择与比较参数

- **FACT**：A/B node id 存在 renderer `localStorage` 的 `sqldiff.lastCombo` 中，内容只有 id，不含秘密或结果。证据：`apps/desktop/src-renderer/store.ts:54,106-126`。
- **FACT**：结构 scopes 默认四项全选；`normalizeScopes` 对非法/空输入回落四项结构范围，数据由 `includeData` 或 scopes 中的 `'data'` 单独开启。证据：`apps/desktop/src-renderer/store.ts:239-241`；`apps/desktop/src-core/compare-filter.ts:19-43`；`apps/desktop/src-core/types.ts:139-150`。
- **FACT**：表名过滤只作用于表和数据行，视图/过程/函数不按该关键字过滤；过滤大小写不敏感。证据：`apps/desktop/src-core/compare-filter.ts:79-117`；`apps/desktop/src-renderer/App.tsx:473-478`。
- **FACT**：当前结构范围是一个表名子串过滤框，不是表清单多选；只有数据表映射提供逐行 A→B 选择。证据：`apps/desktop/src-renderer/App.tsx:459-480,734-846`；`.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md:33-36`。
- **FACT**：数据表映射可由同名交集自动生成，也可由用户在 A/B 下拉中手动改配；后端显式 pair 优先，否则使用同名交集。证据：`apps/desktop/src-renderer/store.ts:366-393`；`apps/desktop/src-main/compare-run.ts:144-161`。
- **FACT**：数据选项为分页批量（100–5000，默认 1000）、行阈值（10000–1000000，默认 100000）、INSERT 分批（100–2000，默认 500）；非法值回落默认。证据：`apps/desktop/src-core/data-options.ts:7-77`；`apps/desktop/src-renderer/App.tsx:667-731`；`apps/desktop/src-core/data-options.test.ts:13-85`。

#### 2.3 建连、取快照与结构比较

- **FACT**：A/B 两边各自创建 `mysql2/promise` pool，pool connection limit 为 5；直连使用节点 host/port，SSH 节点先按 nodeId 复用一个 tunnel，再把 MySQL endpoint 改为 `127.0.0.1:<localPort>`。证据：`apps/desktop/src-main/connection.ts:88-112,228-318`。
- **FACT**：元数据读取使用 `information_schema` 获取 BASE TABLE、VIEW 和 routine 名称，再对每个对象执行 `SHOW CREATE`；单对象失败转为 `null`，不把权限错误误判为对象删除。证据：`apps/desktop/src-main/metadata.ts:41-55,78-138,170-203`；`apps/desktop/src-core/compare.ts:63-69,111-139`；`apps/desktop/src-main/metadata.test.ts:148-180`。
- **FACT**：四类对象的 `SHOW CREATE` 各自使用保序 `mapWithLimit`，默认 worker 上限 10；A/B metadata fetch 也并行。证据：`apps/desktop/src-main/metadata.ts:13-14,140-167,191-196`；`apps/desktop/src-main/metadata.test.ts:107-145`。
- **FACT**：表 diff 覆盖表新增/删除、列增删改、主键变更和 `KEY` 索引增删；视图/过程/函数走 routine diff，DEFINER 差异会归一。证据：`apps/desktop/src-core/diff.ts:46-79,81-175,177-242`；`apps/desktop/src-core/diff.test.ts:104-194`。
- **FACT**：表 SQL 会按 `;\n` 拆成单语句条目，每条独立 classify/risk/aspect；视图、过程、函数保持原子条目。证据：`apps/desktop/src-core/diff.ts:65-79`；`apps/desktop/src-core/compare.ts:51-61,104-150`；`apps/desktop/src-core/ddl-dml-index.test.ts:33-58,101-129`。
- **FACT**：结果条目带 `ChangeType`、`StmtKind`、`StmtAspect`、`RiskLevel`、SQL、explain 和 rollback 文本；结构结果和统计由 core 统一组装。证据：`apps/desktop/src-core/types.ts:87-104,192-207`；`apps/desktop/src-core/compare.ts:29-49,142-150`。
- **FACT**：旧兼容过滤会忽略表级 `AUTO_INCREMENT`、`CHECKSUM`、`DELAY_KEY_WRITE`、`ROW_FORMAT`、`DEFAULT` 和字段 COMMENT。证据：`apps/desktop/src-core/diff.ts:24-43`；对应测试 `apps/desktop/src-core/diff.test.ts:76-102`。
- **INFERENCE**：因此当前结构 diff 的“等价”定义是旧 CLI 文本归一后的等价，不是 MySQL 完整语义等价；尤其是 `DEFAULT` 被过滤后，默认值变化可能不形成差异。推理依据：`diff.ts:33-43` 是比较前的全局文本删除；`diffTable` 随后只比较过滤后的字符串（`diff.ts:47-62`）。

#### 2.4 数据比较

- **FACT**：数据比较只有在 `includeData` 或 scopes 携带 `'data'` 时执行；结构比较先完成，再追加数据条目和逐表状态。证据：`apps/desktop/src-core/compare-filter.ts:29-33`；`apps/desktop/src-main/compare-run.ts:90-119`。
- **FACT**：行身份优先使用 PRIMARY KEY；没有 PK 时只接受两侧同一组、每列显式 `NOT NULL` 的 UNIQUE；可空 UNIQUE 或无唯一键的表跳过行级 diff并只给行数/原因。证据：`apps/desktop/src-core/data-pk.ts:17-30,70-143`；`apps/desktop/src-main/data-run.ts:121-166,185-210`；测试 `apps/desktop/src-main/data-run-identity.test.ts:52-124`。
- **FACT**：数据读取先 `COUNT(*)`，超过阈值且未确认则记 `confirm-needed`；随后按主键 keyset 分页 `SELECT *`，A/B 同表读取并行、表与表之间串行。证据：`apps/desktop/src-main/data-fetch.ts:49-57,65-85,105-134`；`apps/desktop/src-main/data-run.ts:213-248,286-313`。
- **FACT**：A-only 行生成 INSERT，B-only 行生成 DELETE，同 key 不同值生成只含变化列的 UPDATE；INSERT 按 insertBatch 分批，DML 不会传入 pool 执行。证据：`apps/desktop/src-core/data-diff.ts:83-142`；`apps/desktop/src-main/data-run.ts:55-85,230-248`。
- **FACT**：字符串、引号、反斜杠、NULL、Date、Buffer 有专门 literal 处理；联合主键 key 用 NUL 分隔。证据：`apps/desktop/src-core/data-diff.ts:30-68`；`apps/desktop/src-core/data-diff.test.ts:44-101`。
- **FACT**：逐表状态包括 pending/running/done/skipped/error/confirm-needed；取消通过 `AbortSignal` 传播，UI可发 `compare.cancel`。证据：`apps/desktop/src-core/types.ts:158-184`；`apps/desktop/src-main/main.ts:280-288,315-339`；`apps/desktop/src-main/data-run.ts:168-207,251-320`。
- **FACT**：当前数据行已经并入中央主 DiffTable；UI 没有独立 INSERT/DELETE/UPDATE 三个 Tab，而是用“数据”对象 chip 和 INSERT/UPDATE/DELETE 动词 chips 定位。证据：`apps/desktop/src-renderer/App.tsx:34-39,47-54,595-615,1545-1559`；历史设计中的独立三 Tab 已被 `09-22-ui-fix-batch/design.md:8-23` 改为合并主表。
- **INFERENCE**：数据比较是一个“全表 materialize 后在内存比对”的实现，而不是数据库端流式 join/checksum；分页解决单次查询包体和表间峰值，不等于 O(1) 内存。推理依据：`data-fetch.ts:122-134` 将所有 rows 放入 `out`，随后 `data-diff.ts:97-109` 再构造两张 Map。

#### 2.5 查看、筛选、复制和导出

- **FACT**：中央表按 ALL/CREATE/DROP/CHANGE、对象多选、INDEX/切面、动词多选和表/数据关键字组合过滤；组内 OR、组间 AND。证据：`apps/desktop/src-renderer/App.tsx:506-649,1475-1553`；共享语义 `apps/desktop/src-core/compare-filter.ts:63-118`。
- **FACT**：未选中单条时，DiffTable 和 SqlPreview 使用同一最终 `tabItems`；选中行后预览/复制/导出/风险/回滚收窄为单条。证据：`apps/desktop/src-renderer/App.tsx:896-975,1726-1759`；`.trellis/spec/frontend/state-management.md:39-43`。
- **FACT**：SQL 预览使用 `sql-formatter` MySQL 方言和 `<pre>` 正则高亮；高亮函数先转义 HTML，再处理注释/字符串/标识符。证据：`apps/desktop/src-renderer/sql.ts:18-65`；`apps/desktop/src-renderer/App.tsx:954-958`；`apps/desktop/src-renderer/sql.test.ts:12-34`。
- **FACT**：复制优先走 main 的 Electron clipboard，失败后降级到 `navigator.clipboard` 和隐藏 textarea；含 `changeType === 'DROP'` 的当前列表会先 `window.confirm`。证据：`apps/desktop/src-renderer/sql.ts:67-99`；`apps/desktop/src-renderer/App.tsx:896-935`。
- **FACT**：`.sql` 导出包含 A/B/时间/条数头注释并按 DROP→CREATE→CHANGE 排序；renderer 发起 Blob 下载，main 注册 `will-download` 将文件保存到系统 Downloads。证据：`apps/desktop/src-core/compare.ts:156-173`；`apps/desktop/src-renderer/sql.ts:101-125`；`apps/desktop/src-main/download.ts:17-39`；`apps/desktop/src-main/main.ts:394-398`。
- **FACT**：本地 main 还暴露 `sql.format` IPC，但 renderer 当前直接 import `sql-formatter` 并调用本地 `formatSqlSafe`；源码搜索未发现 renderer 调用 `api.sql.format`。证据：`apps/desktop/src-main/main.ts:340-350`；`apps/desktop/src-main/preload.ts:102-105,145-146`；`apps/desktop/src-renderer/sql.ts:1-5,18-35`。
- **FACT**：回滚内容是本地规则生成的说明/占位文本，不是可执行 rollback 引擎。证据：`apps/desktop/src-core/risk.ts:37-116`；`apps/desktop/src-renderer/App.tsx:960-971`。

#### 2.6 节点备份、迁移和 DBeaver

- **FACT**：自定义 `ExportJSON` v1 将每个节点的 `NodeMeta` 和 AES-GCM `secretsEnc` 放在同一 JSON；导入时用当前 Vault master key 解密，跨目录/机器不匹配会失败。证据：`apps/desktop/src-core/types.ts:80-116`；`apps/desktop/src-main/vault.ts:274-315`；测试 `apps/desktop/src-core/vault.test.ts:101-140`。
- **FACT**：旧连接串支持 `user:pass@host~db#port[+sshuser:sshpass@sshhost#sshport]`，结构化表单则是特殊字符密码的正式入口；解析器明确记录 user/password 分隔符限制。证据：`apps/desktop/src-main/vault.ts:348-420`；`apps/desktop/src-renderer/App.tsx:1269-1276,1369`；`apps/desktop/src-renderer/App.tsx:1629-1635`。
- **FACT**：DBeaver 导出是 topology-only：固定 `provider=mysql`、`driver=mysql8`、MANUAL/native、SSH PASSWORD/PUBLIC_KEY；不读取 Vault、不输出密码/私钥/passphrase/密文，私钥节点只给 warning。证据：`apps/desktop/src-main/main.ts:218-222`；`apps/desktop/src-main/converters/dbeaver.ts:137-217`；`apps/desktop/src-main/converters/dbeaver.test.ts:23-156`。
- **FACT**：DBeaver 节点选择 modal 支持逐项勾选、全选/全不选、数量、取消和下载；文件下载复用 JSON Blob 路径。证据：`apps/desktop/src-renderer/App.tsx:982-1098`；`apps/desktop/src-renderer/sql.ts:101-125`。
- **FACT**：`NodeConverter` 反向导入接口和注册表仍为空；DBeaver 是独立的 SqlDiff→DBeaver exporter，不复用该反向接口。证据：`apps/desktop/src-main/converters/index.ts:1-32`；`apps/desktop/src-main/converters/dbeaver.ts:137-217`。
- **FACT**：DataGrip 导出尚未实现，任务状态为 blocked，原因是缺少真实脱敏 `dataSources.xml`/`dataSources.local.xml`（尤其 SSH）fixture。证据：`.trellis/tasks/09-24-datagrip-converter/prd.md:1-42`；`.trellis/tasks/09-24-datagrip-converter/task.json:1-26`。

### 3. 当前能力矩阵

| 能力域 | 状态 | 当前实际能力 | 证据与边界 |
|---|---|---|---|
| 节点库 | **已实现，有边界** | CRUD、测试、搜索、全部/历史/我的/常用、star、useCount、group/tags 字段 | `main.ts:139-253`; `App.tsx:72-339`; `node-filter.ts:8-20`；表单没有 notes，pinned 只有模型/过滤没有控件 |
| 直连 MySQL | **已实现** | host/port/user/password/database、连接测试和延迟 | `connection.ts:88-103,301-390`; `connection.test.ts:113-135` |
| SSH | **部分真实验证** | 单跳、密码或 privateKey+passphrase、隧道复用 | `connection.ts:55-85,228-318`; `smoke-report2.md:5-13`；密码认证连通但该环境拒绝 TCP forwarding，私钥未验证 |
| 元数据 | **已实现，MySQL 专用** | BASE TABLE、VIEW、PROCEDURE/FUNCTION、SHOW CREATE、限流 | `metadata.ts:41-203`; `metadata.test.ts:41-180` |
| 结构 diff | **已实现但文本兼容型** | 表/列/主键/部分索引、routine、DEFINER 归一、语句拆分 | `diff.ts:24-242`; `compare.ts:51-150`; `diff.test.ts:76-292` |
| 数据 diff | **已实现但有资源/身份边界** | PK/全非空 UNIQUE、联合键、keyset、INSERT/DELETE/UPDATE、阈值/状态/取消 | `data-pk.ts:17-143`; `data-fetch.ts:65-135`; `data-run.ts:121-321` |
| 结果过滤 | **已实现** | 4 个 change Tab、对象/切面/动词多选、关键字 | `compare-filter.ts:63-118`; `App.tsx:506-649,1475-1553` |
| 风险/回滚 | **已实现为解释器，不是执行器** | high/medium/low、中文 explain、备份/回滚占位 | `risk.ts:22-116`; `App.tsx:960-971` |
| SQL 展示 | **已实现** | MySQL formatter、轻量高亮、格式化失败回落 | `sql.ts:18-65`; `sql.test.ts:12-34` |
| 复制/下载 | **已实现，保存完成状态仍间接** | 当前列表/单条复制、DROP confirm、.sql/JSON Downloads 落盘 | `App.tsx:896-935`; `sql.ts:67-125`; `download.ts:17-39`; `e2e-report.md:42-46` |
| 本地持久化 | **已实现单机版** | nodes.json、history.json、原子写、最近 20 条 | `store-json.ts:1-116`; `vault.test.ts:180-205` |
| 加密备份 | **已实现本机版** | safeStorage/AES-GCM secret、v1 加密 JSON | `vault.ts:61-315`; `vault.test.ts:70-140` |
| DBeaver | **已实现结构验收** | topology-only JSON、SSH 映射、无秘密、确定性 | `dbeaver.ts:97-217`; `dbeaver.test.ts:23-172`; `dbeaver-report.md:17-40` |
| DataGrip | **明确未实现/阻塞** | 等待真实 XML fixture | `09-24-datagrip-converter/prd.md:1-42` |
| 真实环境 | **部分验证** | Docker fixture、直连真实库、小表行级、结构大库有证据 | `e2e-report.md:7-12,33-49`; `smoke-report.md:14-24`; 内网库/Windows/私钥限制仍在报告 |
| 发布 | **已有包，发布治理未闭环** | mac x64/arm64 DMG、Windows x64 NSIS、图标 | `electron-builder.yml:1-27`; `e2e-report.md:101-111` |
| 签名/公证/更新 | **未配置** | 当前包 unsigned，无 auto updater | `e2e-report.md:105-111`; `09-24-e2e-icon-release/prd.md:61-64` |
| 跨数据库 | **未实现** | 无 engine/dialect，MySQL transport/metadata/parser/literal 固定 | `types.ts:50-70`; `connection.ts:88-102`; `metadata.ts:41-55`; `diff.ts` |
| CLI/CI/调度 | **未实现** | 只有 Electron invoke；无 CLI、job、scheduler、通知 | `preload.ts:66-106`; `main.ts:277-359`; 根目录无 CI 配置 |
| 团队/云/审批 | **未实现** | 无账号、项目、权限、评论、审批、审计服务 | `store-json.ts`; `types.ts:118-128`; 无 server/API/ORM |
| AI/自动执行 SQL | **明确不做首版** | 只有本地规则文本，无外部 AI 或执行器 | `09-21-sqldiff-desktop/prd.md:67-69`; `risk.ts:1-2`; `database-guidelines.md:15-23` |

### 4. 已实现能力的语义细节与限制

#### 4.1 结构比较的覆盖面

- **FACT**：当前四类结构对象是 `table`、`view`、`procedure`、`function`；没有 trigger、event、sequence、schema、collation 或其他对象类别。证据：`apps/desktop/src-core/types.ts:4-10`；`apps/desktop/src-main/metadata.ts:26-32,42-50`。
- **FACT**：routine 列表来自 `information_schema.parameters` 的 distinct `specific_name/routine_type`；代码没有独立的 routine catalog 查询。证据：`metadata.ts:42-44,100-112`。
- **HYPOTHESIS**：如果目标 MySQL 中存在无参数 routine 仅在 routine catalog 而不在 `information_schema.parameters` 中，当前列表可能漏报；仓库没有覆盖该真实 MySQL fixture，因此不能把 routine 完整性宣称为已验证。依据：`metadata.ts:42-44,100-112` 的唯一清单查询，缺口需实测。
- **FACT**：表字段 diff 是逐行正则解析，列/主键/index 变化由 legacy `diffTableField` 产生；它不是完整 SQL AST 解析器。证据：`apps/desktop/src-core/diff.ts:81-175`。
- **FACT**：表选项和字段 COMMENT 在比较前被删除；因此产品行为是刻意兼容 legacy 的归一化。证据：`diff.ts:24-43`。
- **FACT**：索引识别条件是行首 `KEY \``；`aspectOf` 另有 `UNIQUE/FULLTEXT/SPATIAL` 的展示分类正则，但结构生成器的测试主要覆盖普通 `KEY`。证据：`diff.ts:96-129`; `classify.ts:29-52`; `diff.test.ts:139-147`; `ddl-dml-index.test.ts:60-85`。
- **INFERENCE**：因此“INDEX 过滤”已实现不等于“所有 MySQL index 语法都能被结构 diff 正确生成”；UNIQUE/全文/空间等形式的结构生成覆盖度未被当前测试证明。
- **FACT**：DDL 中对象名在 legacy 生成器内直接包入反引号字符串，例如 `DROP TABLE \`${name}\`` 和 ALTER 语句；规范明确把该输出 hardening 记录为独立边界。证据：`diff.ts:59-60,141-170`；`.trellis/spec/backend/database-guidelines.md:7-12`。
- **FACT**：风险规则是本地确定性规则：DROP TABLE/COLUMN/PRIMARY 为 high，routine/view 为 medium，index 为 low，CREATE/ADD 为 low，其余多为 medium；不是基于实际数据库统计或策略配置。证据：`risk.ts:37-116`。
- **FACT**：rollback 只生成备份/恢复提示和占位模板；没有读取备份、验证回滚或执行路径。证据：`risk.ts:50-116`；`App.tsx:967-971`。

#### 4.2 数据比较的覆盖面

- **FACT**：PK 解析支持联合主键，UNIQUE 解析支持表级、复合和列级内联形式；`COMMENT` 中的 `UNIQUE` 字样被先 strip，避免误判。证据：`data-pk.ts:50-117`；`data-unique.test.ts:56-85`。
- **FACT**：PK 优先于 UNIQUE；只有全列显式 NOT NULL 的 UNIQUE 可作为身份，可空 UNIQUE 被跳过并点名可空列。证据：`data-pk.ts:120-143`；`data-run.ts:127-165`。
- **FACT**：同一表 A/B 的 key 列集必须一致；不一致为 `pk-mismatch` 状态而不是继续生成 DML。证据：`data-run.ts:150-165,202-210`。
- **FACT**：无身份表仍会尝试获取 A/B 行数，但不会读取全部行做 row diff；状态 message 给出“加主键/全列 NOT NULL UNIQUE/整行 hash 抽样”的替代提示。证据：`data-run.ts:185-200`。
- **FACT**：INSERT 语句从第一行的 `Object.keys` 生成 values 顺序，没有显式 column list。证据：`data-diff.ts:75-81`。
- **INFERENCE**：当 A 行与 B 行的列顺序/形状不一致时，INSERT 输出可能依赖驱动返回形状；当前单测未覆盖跨行不同列形状，需 fixture 验证。推理依据：`Object.keys(rows[0])` 是唯一列来源（`data-diff.ts:75-81`）。
- **FACT**：Buffer 被按 UTF-8 文本转成 SQL 字符串，未提供二进制专用编码/截断策略；任务 PRD 将 BLOB 大字段优化列为 out of scope。证据：`data-diff.ts:10-15,64-67`；`.trellis/tasks/archive/2026-09/09-21-data-diff-v2/prd.md:29-32`。
- **FACT**：行读取是 `SELECT *`，没有用户可配置的列裁剪、WHERE 条件、时间范围、抽样或脱敏策略。证据：`data-fetch.ts:69-85`；`CompareRequest` 仅含表映射和三项数据选项，`types.ts:139-184`。
- **FACT**：阈值是单次比较的全局 request 字段；`confirmOverThreshold` 为整个请求的布尔值，UI“确认并重跑”会重跑当前比较而不是只确认单表。证据：`types.ts:175-184`；`data-run.ts:291-302`；`App.tsx:863-869,1716-1720`。
- **FACT**：表级失败/跳过/阈值待确认不会中断其他表；只有取消被当作整体中断。证据：`data-run.ts:286-313`；`.trellis/spec/backend/error-handling.md:7-15`。

#### 4.3 结果、风险和输出

- **FACT**：`DiffItem` 的 `changeType` 是 CREATE/DROP/CHANGE 三态；数据行另有 `dml` INSERT/DELETE/UPDATE，且 DML 映射到统计兼容的三态。证据：`types.ts:12-20,87-104,186-200`；`data-run.ts:55-60`。
- **FACT**：UI 当前没有把 DML 三种操作显示为三个一级 Tab；它们通过“数据”对象和动词 chips 过滤。证据：`App.tsx:34-39,47-54,595-615`。
- **FACT**：表语句拆分后每个语句是一个 DiffItem，`id` 以 `:s<n>` 保序；例程块不拆。证据：`compare.ts:55-60`; `ddl-dml-index.test.ts:101-129`。
- **FACT**：`toExportSql` 只输出 SQL 和头注释，不输出 rollback、risk explanation、输入指纹、快照版本或审查状态。证据：`compare.ts:156-173`。
- **FACT**：复制和 `.sql` 导出从当前过滤后的列表生成；选中单条时有意只输出该条。证据：`App.tsx:896-935`; `sql.test.ts:36-87`; `ddl-dml-index.test.ts:199-213`。
- **FACT**：renderer 的导出 toast 在调用 Blob 下载后立即显示“已导出”；下载是否完成由 main 的 `will-download`/E2E 文件断言证明，UI 没有下载完成 IPC。证据：`App.tsx:924-935`; `download.ts:23-39`; `.trellis/spec/backend/quality-guidelines.md:36-39`。

### 5. 明确未实现、部分实现和未闭环能力

#### 5.1 代码/任务明确未实现

- **FACT**：没有自动执行 SQL、事务、migration、写入 API 或 rollback 执行器。证据：`.trellis/spec/backend/index.md:1-3`; `.trellis/spec/backend/database-guidelines.md:3-5,15-23`; `09-21-sqldiff-desktop/prd.md:67-69`。
- **FACT**：没有 PostgreSQL、Oracle、SQL Server、MariaDB 专用 driver/dialect 分支；NodeMeta 没有 engine/dialect 字段。证据：`types.ts:50-70`; `connection.ts:88-102`; `metadata.ts:41-55`; `09-21-sqldiff-desktop/prd.md:67-69`。
- **FACT**：没有多跳 SSH、SSH agent、bastion/jump host 字段或代理配置；当前 `ensureTunnel` 是一次 `forwardOut`。证据：`types.ts:41-48`; `connection.ts:182-209,228-290`; `smoke-report2.md:5-13`。
- **FACT**：没有 TLS/SSL connection options、数据库角色权限校验、只读账号策略或连接池策略编辑器。证据：`types.ts:50-78`; `connection.ts:89-103`; `NodeMeta` 无这些字段。
- **FACT**：没有 CLI 命令、无无头 runner、无项目文件输入、无 JSON/exit-code CI 入口；当前唯一运行入口是 Electron `app` 和 renderer IPC。证据：`package.json:6-15`; `main.ts:394-411`; `preload.ts:66-106`。
- **FACT**：没有账号、团队、项目、权限、评论、审批、共享报告、审计事件、通知或云同步。证据：`store-json.ts:1-116` 只存本地 metadata/history；`types.ts:118-128` 只有摘要；`main.ts` 无 server/network handler。
- **FACT**：没有 baseline/project manifest、结果快照、报告 schema、风险策略配置或审查工作流。证据：`HistoryEntry` 字段 `types.ts:118-128`; `CompareRequest/Result` 字段 `types.ts:139-207`; `toExportSql` `compare.ts:156-173`。
- **FACT**：没有 AI/LLM 集成；当前“智能化”是离线本地风险规则。证据：`risk.ts:1-2`; `09-21-sqldiff-desktop/prd.md:67-69,76-78`。
- **FACT**：没有 scheduler、cron、定时巡检、通知、重试队列或 job 状态持久化。证据：`main.ts:277-359` 只有同步 IPC handlers；`CompareRequest` 是即时 A/B 请求，`types.ts:139-150`。
- **FACT**：DataGrip exporter、反向 DBeaver/DataGrip importer、自动写入 IDE workspace 均未实现。证据：`converters/index.ts:14-25` 注册表为空；`09-24-datagrip-converter/prd.md:1-42`; `09-22-converters/prd.md:33-39`。
- **FACT**：没有代码签名、公证、auto updater 或 CI 发布流水线。证据：`electron-builder.yml:1-27`; `09-24-e2e-icon-release/prd.md:61-64`; `e2e-report.md:101-111`。
- **FACT**：当前 builder 没有 Linux target；旧 CLI README 的 Linux 支持不能当作当前桌面包能力。证据：`electron-builder.yml:10-27`; `mysqldiff/README.md:36-37`。

#### 5.2 有接口/字段但没有完整用户能力

- **FACT**：`history.clear` main/preload 接口存在，但 renderer store 没有 `clearHistory` action，也没有 UI 入口。证据：`main.ts:257-275`; `preload.ts:122-126`; `store.ts:138-229,435-444`。
- **FACT**：`NodeMeta.pinned` 和 `fav` 判断存在，但 NodeModal 当前只提供 star 控件，没有 pin 控件。证据：`types.ts:61-67`; `node-filter.ts:13-18`; `App.tsx:1289-1292`。
- **FACT**：首版任务 PRD 提到节点“备注”，当前 `NodeMeta` 和 NodeModal 没有 notes 字段。证据：`09-21-sqldiff-desktop/prd.md:22-25`; `types.ts:50-70`; `App.tsx:1242-1370`。
- **FACT**：主进程仍暴露 `sql.format`，但 renderer 当前走本地 formatter；该 IPC 不是当前主要格式化路径。证据：`main.ts:340-350`; `preload.ts:102-105`; `sql.ts:18-35`。
- **FACT**：`NodeConverter` 是第三方配置→SqlDiff 的反向接口，注册表为空；它不是当前 DBeaver exporter 的调用链。证据：`converters/index.ts:1-32`; `main.ts:29-33,218-222`。
- **FACT**：历史记录不可恢复原 scopes、tableFilter、dataOptions 或结果；点击历史只尝试恢复 A/B id。证据：`types.ts:118-128`; `App.tsx:1564-1575`。

#### 5.3 真实环境尚未闭环

- **FACT**：最新 E2E 报告记录 22/22 动作，但指定 `192.168.0.5:3306` 内网真库不可达，使用 Docker MySQL 8 fixture 代替；报告明确声明 fixture 不等同于指定真库。证据：`e2e-report.md:7-20,33-57`。
- **FACT**：SSH 密码认证和 `exec` 已连通，但该服务端拒绝 TCP forwarding；SSH 私钥没有材料，私钥通道未验证。证据：`smoke-report2.md:5-13,28-33`。
- **FACT**：Windows 证据是 macOS 交叉构建的 PE/NSIS/资源核验，不包含 Windows Explorer 或真机启动。证据：`e2e-report.md:14-20,101-111`。
- **FACT**：DBeaver 没有安装环境，验收采用官方结构化 JSON、CDP 下载和 no-secret 断言，不等同于 DBeaver IDE 真机导入。证据：`dbeaver-report.md:5-7,34-54`。
- **FACT**：DataGrip exporter 因真实脱敏 XML fixture 缺失而保持 blocked。证据：`09-24-datagrip-converter/prd.md:1-42`。

### 6. 架构边界与当前可复用入口

以下是“存在的边界/接口”与“尚未存在的边界”两部分，避免把技术可能性误写成产品能力。

#### 6.1 已存在的边界

- **FACT**：跨进程领域契约集中在 `src-core/types.ts`：`NodeMeta`、`SecretBundle`、`DiffItem`、`CompareRequest`、`CompareResult`、`DataTableStatus` 和统计类型。证据：`types.ts:41-207`。
- **FACT**：core 中 `compareRun`、`diffDataRows`、`postFilterResult`、`toExportSql`、`classify`、`verbOf`、`risk` 等是无数据库连接的确定性函数；对应测试覆盖主要纯逻辑。证据：`compare.ts:77-173`; `data-diff.ts:89-143`; `compare-filter.ts:85-118`; `classify.ts:18-94`; `risk.ts:46-117`。
- **FACT**：`DbQueryable` 是 metadata/data-fetch 的最小 query 接口，测试通过 fake object 注入；`SafeStorageLike` 是 Vault 的 Electron 适配接口；`TunnelClient/TunnelServer` 是 tunnel 生命周期测试边界。证据：`metadata.ts:16-19`; `vault.ts:19-22`; `connection.ts:127-137`; 对应 `metadata.test.ts:24-39`、`vault.test.ts:51-60`、`connection.test.ts:36-47`。
- **FACT**：`CompareRunHooks` 和 `DataRunOptions` 提供逐表状态、拉取进度和 AbortSignal；`DataTableStatus` 把局部失败显式传给 renderer。证据：`compare-run.ts:37-42`; `data-run.ts:34-47`; `types.ts:158-173`。
- **FACT**：renderer/main 通过 typed `SqlDiffApi` 单一 contextBridge 通信；API 同时覆盖节点、历史、连接、比较、数据表清单和 SQL copy/format。证据：`preload.ts:66-150`; `main.ts:139-357`。
- **FACT**：本地持久化以可注入目录的纯文件函数存在，`SQLDIFF_USER_DATA_DIR` 可切换 user-data 根；`Vault` 以 `VaultOptions` 注入 safeStorage。证据：`store-json.ts:15-28,82-115`; `vault.ts:183-208`。
- **FACT**：DBeaver exporter 是独立纯 builder + result contract，输出 topology 且不接 Vault；这是当前已落地的转换器方向。证据：`dbeaver.ts:97-217`; `dbeaver.test.ts:23-172`。
- **FACT**：renderer 的 SQL 下载 helper、筛选链和 local components 均可独立复用/测试；`node-filter.ts`、`sql.ts` 有纯 helper 测试，UI 组件仍在 `App.tsx` 内。证据：`node-filter.test.ts`; `sql.test.ts`; `App.tsx:72-975`; `frontend/directory-structure.md:22-31`。

#### 6.2 当前不存在的抽象/接缝

- **FACT**：没有 `engine`/`dialect` 字段或 metadata provider 接口；MySQL 查询、SHOW CREATE 解析和数据 SQL literal 分散在 connection/metadata/data-fetch/diff/data-diff。证据：`types.ts:50-70`; `connection.ts:88-103`; `metadata.ts:41-138`; `data-fetch.ts:33-85`; `data-diff.ts:36-68`。
- **FACT**：没有 repository/storage interface；`compare-run.ts` 和 `data-run.ts` 直接调用 `loadNodes(ctx.userDataDir)`、`ctx.vault`。证据：`compare-run.ts:32-35,74-78`; `data-run.ts:29-32,269-273`。
- **FACT**：没有 job/run manifest、结果持久化或异步任务状态模型；`compare.run` 返回一次完整 `CompareResult`，history 只存摘要。证据：`preload.ts:91-97`; `types.ts:118-128,139-207`。
- **FACT**：没有通用 report/risk policy contract；风险规则写死在 `risk.ts`，导出函数只生成 SQL 文本。证据：`risk.ts:12-116`; `compare.ts:156-173`。
- **FACT**：没有可独立调用的第二宿主（CLI、HTTP service、scheduler）入口；现有 `runCompareRequest` 仍依赖 Electron user-data/Vault 上下文和 concrete connection functions。证据：`compare-run.ts:32-35,61-141`; `main.ts:315-339`; `package.json:6-15`。
- **INFERENCE**：因此“可复用”目前主要是函数级和契约级复用，不等于已形成平台级 adapter/repository/job 架构。

### 7. 已知技术债与失败/误读边界

以下条目是代码或报告直接显示的 debt/限制，不包含未经证实的产品改进建议。

- **FACT：架构/文档漂移**：`metadata.ts:8` 仍写“首版不做数据对比”，但当前已有 data-run；`preload.ts:73` 仍写 `NOT_IMPLEMENTED` 占位说明，但 `nodes.test` 已实现真实连接测试；README 的部分目录/里程碑说明是历史描述。证据：对应源文件行；当前实现分别见 `data-run.ts:1-8`、`main.ts:191-207`。
- **FACT：单文件复杂度**：`App.tsx` 1,783 行、`store.ts` 651 行，组件、工作流、派生过滤和 modal state 集中在少数文件。证据：当前文件行数统计；`App.tsx:72-975,1379-1783`; `store.ts:138-651`。
- **FACT：集成测试缺口**：没有 `main.ts`、`preload.ts`、`compare-run.ts`、`data-run.ts`、`store-json.ts`、`store.ts`、`App.tsx` 的同名测试；Vitest 当前收集的是 core/main/renderer 下的 `*.test.ts`，实际 17 个文件主要覆盖纯函数/fake boundary。证据：`vitest.config.ts:3-5`; 本次 test 输出；文件清单。
- **FACT：真实连接/调度测试缺口**：`connection.test.ts:1-2` 明确真实建连依赖手工冒烟；`data-fetch.test.ts` 只测 SQL/nextKey，不测 `fetchAllByPK` 循环、阈值、取消和峰值内存。证据：对应测试文件。
- **FACT：资源生命周期边界**：`Promise.all` 只有全部 settle 后才给 `poolA/poolB` 赋值；一侧 pool 已创建而另一侧失败时，当前代码没有引用可关闭它，规范将其列为 cleanup gap。证据：`compare-run.ts:80-89,139-141`; `data-run.ts:275-279,314-316`; `database-guidelines.md:25-31`。
- **FACT：取消粒度有限**：main 只有一个 `dataAbort` controller，signal 只在分页循环顶部检查；结构 metadata 阶段没有同样的取消路径，UI 文案也写明“结构对比不可中断”。证据：`main.ts:280-288`; `data-fetch.ts:97-103,125-132`; `App.tsx:480-487`。
- **FACT：退出清理异步未等待**：`before-quit` 以 `void closeAll().catch(...)` 启动关闭，不等待 Promise 完成。证据：`main.ts:408-411`; `frontend/hook-guidelines.md:16-20` 对 effect cleanup 的要求形成对照。
- **FACT：隧道缓存生命周期粗粒度**：tunnel 按 nodeId 缓存在全局 Map，节点 update/delete 没有对应 `closeTunnel` 调用，正常关闭主要在 app quit。证据：`connection.ts:140-146,228-291,392-427`; `main.ts:162-189,408-411`。
- **FACT：数据内存不是流式**：`fetchAllByPK` 将整表所有 rows 放入数组，`diffDataRows` 再建 A/B Map；表级串行只限制跨表峰值。证据：`data-fetch.ts:105-134`; `data-run.ts:213-229,286-289`; `data-diff.ts:97-109`。
- **FACT：生成结构 DDL 的标识符边界未收敛**：`diff.ts` 直接把对象名插入反引号；这与执行查询使用 `escapeIdent`/`escapeDataIdent` 的路径不同。证据：`diff.ts:59-60,141-170`; `database-guidelines.md:7-12`。
- **FACT：真实/示例结果边界是文本提示而非强类型状态**：后端比较失败时 `runCompare` 填入 demo items，toast/lastCombo 带原因，但结果模型没有 `source: real|demo` 字段。证据：`store.ts:611-629`; `CompareResult` 字段 `types.ts:202-207`; `e2e-report.md:51-57`。
- **FACT：空节点刷新边界**：`refreshNodes` 对空数组不替换现有 nodes，失败也保留 seed；这使 preview/demo 与 Electron 空库状态的显示语义共享同一兜底。证据：`store.ts:409-431`。
- **FACT：本地状态与任务历史不承担审计**：没有 logger、job id、审查状态或可关联运行事件；当前诊断主要是 typed status、toast、IPC error 和任务报告。证据：`.trellis/spec/backend/logging-guidelines.md:1-31`; `types.ts:118-128`。
- **FACT：安全配置仍偏窄**：renderer/main 开启 context isolation、关闭 node integration，但没有 `index.html` CSP、窗口导航/新窗口拦截配置。证据：`main.ts:367-380`; `apps/desktop/index.html:1-11`; `current-technical-baseline.md:42-47`。
- **FACT：可访问性未闭环**：NodeCard、Slot 和 diff row 不是键盘可操作元素，tabs/chips 无 `aria-pressed`，NodeModal 无 focus trap；没有 a11y automation。证据：`.trellis/spec/frontend/component-guidelines.md:34-38`; `.trellis/spec/frontend/quality-guidelines.md:36-38`。
- **FACT：构建产物包含测试编译文件**：当前 `tsconfig.main.json` include `src-main` + `src-core` 且未排除 `*.test.ts`；现有 `dist-main` 中有 15 个 `*.test.js`，`release/win-unpacked/resources/app.asar` 列表也可见这些文件。证据：`tsconfig.main.json:1-10`; `apps/desktop/.gitignore:1-5`; 生成目录/包内文件列表。
- **FACT：未使用依赖与包体事实**：`monaco-editor` 是 production dependency，但当前 renderer 使用 `<pre>` 正则高亮；本地 node_modules 约 98 MB，现有 release 目录约 1.3 GB（包含多平台展开产物）。证据：`package.json:18-23`; `sql.ts:1-3,42-65`; `App.tsx:954-958`; 目录大小复核。
- **FACT：自动化交付未形成闭环**：仓库未发现 CI 配置、Playwright harness 或可提交 E2E runner；最新 CDP harness 位于临时目录，任务只持久化报告/截图。证据：`e2e-report.md:1-5,60-64`; `09-24-e2e-icon-release/design.md:3-10`; 根目录文件扫描。
- **FACT：目标环境覆盖有限**：Docker、macOS 交叉构建和直连真库有证据；指定内网库、SSH private key、Windows 真机、DBeaver IDE 导入、DataGrip fixture 尚未形成同等证据。证据：`e2e-report.md:7-20,49-58`; `smoke-report2.md:5-13`; `dbeaver-report.md:50-55`; `09-24-datagrip-converter/prd.md:1-20`。

### 8. 当前验证证据摘要

- **FACT**：自动化纯逻辑层当前全绿：17 files / 167 tests；覆盖结构 diff、过滤/复制一致性、风险、PK/UNIQUE 身份、Vault、metadata SQL、连接配置、下载和 DBeaver no-secret。证据：本次 `npm test` 输出；`vitest.config.ts:3-5`; 具体测试文件。
- **FACT**：历史 E2E 在 demo + Docker MySQL 8 范围记录 22/22 动作通过，包含节点 CRUD、结构/数据比较、联合主键、无主键、中文、过滤、复制、导出、安全文件、交换和快捷键。证据：`e2e-report.md:22-49`。
- **FACT**：历史真实直连验证包括 515/516 表结构、521 条结构差异，以及 `buildings` 表 1/27 行的真实 row diff；密码 SSH 认证连通但转发被服务端拒绝。证据：`smoke-report.md:14-24`; `smoke-report2.md:15-26`。
- **INFERENCE**：这些证据足以说明核心 MySQL 桌面链路已经能在可控环境运行和回归；不足以说明所有 MySQL 版本、所有 SSH 环境、Windows 原生运行、大数据规模或真实客户工作流已成熟。依据：报告明确列出的环境豁免和未完成项。

## Files Found

| File Path | Description |
|---|---|
| `apps/desktop/src-core/types.ts` | 跨层 Node/Secret/Diff/Compare/Data 状态契约 |
| `apps/desktop/src-core/diff.ts` | legacy MySQL SHOW CREATE 结构 diff 与 routine/table SQL |
| `apps/desktop/src-core/compare.ts` | metadata 快照组装、条目统计、排序、SQL 导出 |
| `apps/desktop/src-core/compare-filter.ts` | 主/renderer 共享 scope、对象、切面、动词和关键字过滤 |
| `apps/desktop/src-core/data-diff.ts` | 行级 DML 和值/标识符输出 |
| `apps/desktop/src-core/data-pk.ts` | PK/UNIQUE 身份解析与资格判定 |
| `apps/desktop/src-core/data-options.ts` | 数据分页、阈值、INSERT batch 默认值和归一化 |
| `apps/desktop/src-core/classify.ts` / `risk.ts` | 变更/动词/切面分类与本地风险解释 |
| `apps/desktop/src-main/connection.ts` | mysql2 pool、ssh2 单跳 tunnel、连接测试与资源生命周期 |
| `apps/desktop/src-main/metadata.ts` | information_schema/SHOW CREATE 和并发限流 |
| `apps/desktop/src-main/data-fetch.ts` | COUNT 与 keyset SELECT |
| `apps/desktop/src-main/data-run.ts` | 行身份决策、逐表状态、DML 组装、取消/部分失败 |
| `apps/desktop/src-main/compare-run.ts` | A/B 总编排、数据追加、历史落盘 |
| `apps/desktop/src-main/vault.ts` | safeStorage/AES-GCM、secret 文件、加密导出、旧串导入 |
| `apps/desktop/src-main/store-json.ts` | nodes/history 原子文件存储 |
| `apps/desktop/src-main/converters/dbeaver.ts` | SqlDiff→DBeaver topology-only exporter |
| `apps/desktop/src-main/converters/index.ts` | 未注册的未来第三方→SqlDiff `NodeConverter` seam |
| `apps/desktop/src-main/main.ts` | Electron lifecycle、IPC、窗口、下载和退出清理 |
| `apps/desktop/src-main/preload.ts` | typed `window.sqldiff` bridge |
| `apps/desktop/src-renderer/store.ts` | Zustand 状态、IPC actions、A/B 流程和 demo fallback |
| `apps/desktop/src-renderer/App.tsx` | 三栏 UI、节点/数据/筛选/SQL/DBeaver workflows |
| `apps/desktop/src-renderer/sql.ts` | formatter、highlighter、clipboard、Blob 下载 |
| `apps/desktop/src-renderer/demo.ts` | 无 IPC/失败时的内存 demo compare |
| `apps/desktop/src-renderer/node-filter.ts` | 左侧节点/历史过滤 |
| `apps/desktop/electron-builder.yml` / `package.json` | 平台目标、依赖、脚本、产物配置 |
| `apps/desktop/src-core/*.test.ts` / `src-main/*.test.ts` / `src-renderer/*.test.ts` | 自动化证据，当前 17 files |
| `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md` | 最新 CDP、Docker fixture、真实环境限制与打包证据 |
| `.trellis/tasks/archive/2026-09/09-22-verify-closeout/smoke-report2.md` | SSH 密码/转发和真实小表行级证据 |
| `.trellis/tasks/archive/2026-09/09-21-desktop-m7-smoke/smoke-report.md` | 515/516 表、521 条结构差异和早期打包证据 |
| `.trellis/tasks/09-24-datagrip-converter/prd.md` | DataGrip blocked 状态和 fixture 前置条件 |
| `mysqldiff/DB.js` / `mysqldiff/mysqldiff` / `Tools.js` | legacy CLI 兼容语义参考，非当前桌面运行源 |

## Code Patterns

### A→B 比较和条目模型

```text
NodeMeta + SecretBundle
  -> createMysqlPool / ensureTunnel
  -> fetchMetadata(A) + fetchMetadata(B)
  -> filterMetadataByScopes
  -> compareRun(DatabaseMetadata, targetUser=B.user)
  -> postFilterResult
  -> optional runDataCompare
  -> DiffItem[] + CompareStats + DataTableStatus[]
  -> renderer final tabItems
  -> SQL preview / clipboard / Blob download
```

证据：`compare-run.ts:53-135`、`compare.ts:104-173`、`store.ts:519-639`、`App.tsx:1475-1759`。

### 纯 core 与 Node main 的边界

- `diff.ts`、`data-diff.ts`、`compare.ts` 不建立 DB 连接；它们只消费快照/行。
- `metadata.ts`、`data-fetch.ts`、`connection.ts` 负责 Node-only I/O。
- `compare-filter.ts` 被抽到 core 以避免 renderer bundle 引入 `node:crypto/mysql2/ssh2`。证据：`.trellis/spec/backend/directory-structure.md:33-41`; `compare-filter.ts:1-8`。

### 部分失败而非全有或全无

- 单对象 SHOW CREATE 失败：metadata `null` → compare 跳过。
- 单表数据读取失败：`DataTableStatus.error` → 其他表继续。
- 超阈：`confirm-needed` → 用户显式确认后重跑。
- 取消：ABORTED/AbortError → 结束当前数据运行。
- 历史落盘失败：不阻塞已成功比较。

证据：`metadata.ts:190-201`; `compare.ts:63-69,111-138`; `data-run.ts:185-210,286-313`; `compare-run.ts:121-134`; `.trellis/spec/backend/error-handling.md:7-15,30-39`。

## External References

- 本文件没有新增外部资料；产品能力结论以当前仓库源码、测试、任务报告为主。
- 已有外部格式研究：`.trellis/tasks/archive/2026-09/09-22-converters/research/dbeaver-connection-import.md`；DataGrip 格式与“SSH XML 标签未由公开资料证实”的 caveat 见 `.trellis/tasks/archive/2026-09/09-22-converters/research/datagrip-dataspell-connection-import.md:120-130`。

## Related Specs

- `.trellis/spec/backend/index.md` — main/core 边界、无 HTTP/ORM、只读契约。
- `.trellis/spec/backend/directory-structure.md` — runtime ownership、type-only import、legacy 区域。
- `.trellis/spec/backend/database-guidelines.md` — MySQL 查询、A→B、null snapshot、pool/tunnel 生命周期。
- `.trellis/spec/backend/error-handling.md` — IPC error、typed partial status、cleanup 和 demo fallback。
- `.trellis/spec/backend/quality-guidelines.md` — 安全不变量、测试、CDP、packaging。
- `.trellis/spec/backend/dbeaver-export.md` — topology-only/no-secret exporter contract。
- `.trellis/spec/frontend/index.md` — renderer 桌面边界和 bridge 规则。
- `.trellis/spec/frontend/state-management.md` — Zustand/local/derived state、过滤与复制一致性。
- `.trellis/spec/frontend/component-guidelines.md` — 组件、HTML escaping、a11y baseline。
- `.trellis/spec/frontend/quality-guidelines.md` — CDP 下载/剪贴板/confirm 验证和已知缺口。
- `.trellis/tasks/archive/2026-09/09-21-sqldiff-desktop/prd.md` — 初始产品范围和 out-of-scope。
- `.trellis/tasks/archive/2026-09/09-21-data-diff-v2/prd.md` — 数据比较历史范围和 BLOB/异构表边界。
- `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md` — 最新可执行验证与环境限制。
- `.trellis/tasks/09-24-datagrip-converter/prd.md` — DataGrip 明确阻塞项。

## Caveats / Not Found

- `python3 ./.trellis/scripts/task.py current --source` 在本次子会话返回 `(none)`；本文件按主会话明确指定的 `.trellis/tasks/09-24-product-expansion-roadmap/` 写入。
- 当前工作树的 `apps/desktop/README.md` 有未提交文档改动；本报告以 `HEAD` 代码和当前源码为主，不把该文档 diff 当成产品实现证据。
- `mysqldiff/` 被根 `.gitignore` 忽略；它可作为历史兼容证据，但不应被当作当前 Git tracked 发布物。
- 没有发现客户访谈、真实使用遥测、付费数据、CI pipeline、可提交 E2E harness、PostgreSQL/Oracle fixture、Docker compose 配置或自动更新配置。
- 结构 parser 的 UNIQUE/FULLTEXT/SPATIAL/无参数 routine 覆盖、无 PK 整表抽样、跨版本 SHOW CREATE 差异、BLOB/大字段和百万行峰值均未被当前自动化测试充分证明；这些是待验证边界，不是已确认缺陷或已确认需求。

## 当前产品成熟度摘要（本报告结尾）

- **FACT — 核心工程能力：中高成熟度（证据层面）**：MySQL 直连、结构 diff、数据 diff、过滤、风险文本、Vault、复制/下载、DBeaver exporter 已有源码、纯函数测试和 Docker/CDP 证据；核心路径可回归。证据：本次 17/167 测试；`e2e-report.md:22-49`; `dbeaver-report.md:17-40`。
- **FACT — 桌面交付：可用但仍是 0.1.0 预发布形态**：macOS x64/arm64 与 Windows x64 有构建产物，图标和结构已核验；但 unsigned、无 auto updater、无 CI，Windows 只有交叉构建证据。证据：`package.json:2-3`; `electron-builder.yml:1-27`; `e2e-report.md:101-111`。
- **FACT — 真实环境覆盖：中等且有明显边界**：大库直连、真实小表行级和 Docker fixture 有证据；指定内网库、SSH private key/forwarding、Windows 真机、DBeaver IDE、DataGrip fixture 未闭环。证据：`smoke-report.md:14-24`; `smoke-report2.md:5-13`; `e2e-report.md:49-58`; `dbeaver-report.md:50-55`。
- **FACT — 安全边界：本地只读模型已建立，但不是审计/执行平台**：Electron bridge 隔离、secret 不进 nodes/history、生成 SQL 不执行均有代码和测试证据；生成 DDL 标识符插值、demo fallback、无应用日志/CSP/权限模型仍是边界。证据：`main.ts:367-380`; `vault.ts:274-315`; `database-guidelines.md:7-23`; `store.ts:611-629`; `index.html:1-11`。
- **INFERENCE — 产品成熟度标签**：综合当前证据，更准确的描述是“功能完整度较高、单机 MySQL 工作流可用的桌面预发布/早期 Beta”，而不是经过市场验证的生产平台。依据是功能矩阵、自动化/E2E 证据与上述真实环境/发布缺口同时存在。
- **HYPOTHESIS — 市场成熟度未知**：仓库没有证明目标用户是谁、痛点频率、付费意愿、团队协作/CI/跨库需求或留存，因此不能给出“产品已成熟市场”的结论。
