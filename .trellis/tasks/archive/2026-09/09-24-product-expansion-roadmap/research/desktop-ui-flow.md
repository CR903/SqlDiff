# Research: 桌面 UI 流程与可观察行为

- **Query**: 盘点 SqlDiff 当前桌面 renderer 的页面/组件结构、用户操作流程、状态/IPC 数据流、预览/复制/下载行为、错误与可访问性边界。
- **Scope**: internal
- **Date**: 2026-09-24
- **证据标记**: `FACT` / `INFERENCE` / `HYPOTHESIS`。

## Findings

### 1. UI 形态和组件所有权

当前没有 router、页面目录或独立组件库；`App.tsx` 是 renderer composition root，组件是文件内局部函数组件。证据：`.trellis/spec/frontend/index.md:1-14`、`apps/desktop/src-renderer/App.tsx:1-18,68-70`。

| 区域 | 组件/符号 | 负责的交互 | 证据 |
|---|---|---|---|
| 顶栏 | `App` return `:1637-1651` | 产品名、离线/只读提示、快捷键提示 | `apps/desktop/src-renderer/App.tsx:1637-1651` |
| 左栏 | `NodeLibrary`, `NodeCard`, `HistoryRow` | 节点搜索/Tab、选择、CRUD 入口、导入导出、历史恢复 | `apps/desktop/src-renderer/App.tsx:72-339` |
| 中央上 | `CompareSlots`, `Slot` | A/B 拖拽/下拉、交换/清空、范围、表过滤、运行/取消、进度 | `apps/desktop/src-renderer/App.tsx:346-499` |
| 中央下 | `DiffTable` | Tab、对象/aspect/verb 过滤、结果行选择、计数 | `apps/desktop/src-renderer/App.tsx:506-649` |
| 数据面板 | `DataSection`, `DataOptionsInputs` | 表清单、同名配对、手动 A→B 映射、批量/阈值/INSERT 分批、超阈确认 | `apps/desktop/src-renderer/App.tsx:652-874` |
| 右栏 | `SqlPreview` | SQL 高亮、风险、回滚、复制、导出、DROP 确认 | `apps/desktop/src-renderer/App.tsx:876-975` |
| 节点表单 | `NodeModal` | 新增/编辑、测试、保存、secret 内存输入 | `apps/desktop/src-renderer/App.tsx:1100-1373` |
| DBeaver 弹窗 | `DBeaverExportModal` | 节点多选、全选/全不选、警告、下载 JSON | `apps/desktop/src-renderer/App.tsx:978-1098` |

### 2. 屏幕结构

- **FACT**：主布局是固定三栏 CSS Grid：左 280px、中间弹性、右 380px；应用本身设置固定桌面最小窗口 1100×680。证据：`apps/desktop/src-renderer/styles.css:6-19`、`apps/desktop/src-main/main.ts:367-380`。
- **FACT**：样式是单一 `apps/desktop/src-renderer/styles.css` 深色系统；没有 Tailwind、CSS-in-JS 或第二套组件样式进入生产 renderer。证据：`apps/desktop/src-renderer/main.tsx:1-5`、`apps/desktop/src-renderer/styles.css:1-170`、`.trellis/spec/frontend/component-guidelines.md:27-32`。
- **INFERENCE**：这是面向桌面工作区的固定布局，不是移动/浏览器响应式产品；缩小到最小尺寸以外的空间没有产品流程。依据是 CSS grid、minWidth/minHeight 和 frontend quality spec。
- **FACT**：`monaco-editor` 在依赖中，但生产 SQL 视图仍为高亮 `<pre>`；代码注释明确这是 worker/体积 fallback。证据：`apps/desktop/package.json:18-23`、`apps/desktop/src-renderer/sql.ts:1-3`、`apps/desktop/src-renderer/App.tsx:954-956`。

### 3. 启动流程

1. `main.tsx` 以 StrictMode 挂载 `App`。证据：`apps/desktop/src-renderer/main.tsx:1-13`。
2. `App` 首次 effect 并行调用 `refreshNodes` 和 `refreshHistory`。证据：`apps/desktop/src-renderer/App.tsx:1450-1454`。
3. `refreshNodes` 成功且返回非空数组才覆盖 seed nodes；若数组为空或 IPC 失败，保留 seed nodes。证据：`apps/desktop/src-renderer/store.ts:409-433`。
4. 无 `window.sqldiff` 时保留 seed nodes；`runCompare` 使用 `runDemoCompare`，数据面板的 `refreshDataTables` 给出“预览模式”toast。证据：`apps/desktop/src-renderer/store.ts:96-104,366-371,608-629`。
5. Electron 模式启动 `main.ts` 注册 IPC、Downloads handler，创建 BrowserWindow；开发环境可用 `VITE_DEV_SERVER_URL`，否则加载打包 renderer。证据：`apps/desktop/src-main/main.ts:361-402`。

**INFERENCE**：冷启动的默认可见状态是演示态而非保证的空库态；最新 E2E 报告也明确 T1 截图展示 seed demo，空态由 T2 删除节点证据覆盖。依据：`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:26-29,49,57`。

### 4. 节点管理流程

#### 4.1 列表和筛选

- 左 Tab 是全部、历史、我的、常用；默认 `all`。证据：`apps/desktop/src-renderer/store.ts:39-54,235-241`、`apps/desktop/src-renderer/App.tsx:27-32,291-336`。
- 搜索覆盖 alias/host/database/group，不覆盖 tags；历史关键字只过滤 A/B alias。证据：`apps/desktop/src-renderer/node-filter.ts:8-19`、`apps/desktop/src-renderer/App.tsx:237-241`。
- “我的”= `star`；“常用”= `pinned` 或 `useCount > 0`，按 useCount 倒序。证据：`apps/desktop/src-renderer/node-filter.ts:13-19`。
- 星标点击先乐观更新 renderer，再异步 `nodes.update`；持久化失败被忽略。证据：`apps/desktop/src-renderer/store.ts:396-407`。

#### 4.2 新增/编辑/删除

- 表单字段包括 alias、host、port、user、password、database、group、tags、star、SSH enabled/host/port/user/authType，以及 password/privateKey/passphrase secret 输入。证据：`apps/desktop/src-renderer/App.tsx:1115-1182,1242-1350`。
- 编辑时密码/私钥/passphrase 留空表示不动原 secret；新建时空 secret 仍可保存。证据：`apps/desktop/src-renderer/App.tsx:1141-1182,1180-1182`。
- 表单先做必填校验，再经 Zustand `saveNode` → preload → main；main 做端口、SSH auth、节点元数据校验并分别写 metadata/secret。证据：`apps/desktop/src-renderer/App.tsx:1219-1240`、`apps/desktop/src-renderer/store.ts:446-462`、`apps/desktop/src-main/main.ts:86-177`。
- 删除前有 `window.confirm`，删除后从 renderer nodes 和 A/B 槽移除；main 同时删除 vault secret。证据：`apps/desktop/src-renderer/App.tsx:1597-1603`、`apps/desktop/src-renderer/store.ts:464-472`、`apps/desktop/src-main/main.ts:180-189`。
- 节点测试有两种：保存后 `nodes.test(id)`，或表单免保存 `conn.test({node,secret})`；延迟显示在卡片上。证据：`apps/desktop/src-renderer/App.tsx:1185-1217,1581-1595`、`apps/desktop/src-renderer/store.ts:475-485`、`apps/desktop/src-main/main.ts:191-208`。

#### 4.3 持久化/导入导出

- 普通“导出”调用 `nodes.export` 得到 v1 加密 JSON，再通过 JSON Blob 下载；不把 secret 放进 renderer state/localStorage。证据：`apps/desktop/src-renderer/App.tsx:1605-1611`、`apps/desktop/src-renderer/store.ts:487-491`、`apps/desktop/src-main/vault.ts:274-315`。
- “导入”在 renderer 读取文件并 JSON.parse，main 的 `Vault.importDecrypted` 做真正形状/密文校验。证据：`apps/desktop/src-renderer/App.tsx:1621-1627`、`apps/desktop/src-renderer/store.ts:503-509`、`apps/desktop/src-main/vault.ts:292-315`。
- “连串”使用 `window.prompt` 输入老 CLI `user:pass@host~db#port[+sshuser:sshpass@sshhost#sshport]`，main 解析后走 vault。证据：`apps/desktop/src-renderer/App.tsx:1629-1635`、`apps/desktop/src-main/vault.ts:390-420`。

### 5. A/B 比较流程

1. 节点卡拖拽把 node id 放入 `text/plain`；槽位 `preventDefault` 并解析该 id。也可用每个槽的 `<select>`。证据：`apps/desktop/src-renderer/App.tsx:91-100,361-390`。
2. 点击节点卡按 A → B 自动填槽；第三次点击替换 B；槽位可交换/清空。证据：`apps/desktop/src-renderer/store.ts:263-291`。
3. localStorage 只保存 `sqldiff.lastCombo` 的 A/B id；节点刷新后在两槽都为空时恢复。证据：`apps/desktop/src-renderer/store.ts:54,106-126,409-427`。
4. 运行时校验两槽非空、至少一个结构范围或数据开启；A/B 不能是同一节点。证据：`apps/desktop/src-renderer/store.ts:519-529`、`apps/desktop/src-main/compare-run.ts:66-72`。
5. 请求通过 preload `compare.run` 发送 `aId/bId/scopes/tableFilter/includeData/dataTables/dataOptions`；main 创建 AbortController，订阅 table/fetch progress。证据：`apps/desktop/src-renderer/store.ts:540-572`、`apps/desktop/src-main/main.ts:316-338`。
6. 结构 metadata A/B 并发拉取；先 scope 裁剪，再 `compareRun`，再 `postFilterResult`。证据：`apps/desktop/src-main/compare-run.ts:80-95`。
7. 若数据开启，解析显式映射或 A/B 同名交集，然后进入 `runDataCompare`；数据结果追加到结构 items 后重新排序。证据：`apps/desktop/src-main/compare-run.ts:96-119,144-162`。
8. 真实比较成功会追加 history、刷新历史，并把 A/B useCount 加一后 best-effort 持久化。证据：`apps/desktop/src-main/compare-run.ts:121-134`、`apps/desktop/src-renderer/store.ts:591-607`。
9. 真实比较失败时 renderer 生成 demo items、显示消毒后的失败原因；这条路径不证明真实比较成功。证据：`apps/desktop/src-renderer/store.ts:611-629`、`.trellis/spec/frontend/state-management.md:45-47`、E2E 报告 `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:51-58`。

### 6. 数据对比流程

- 只有 `includeData` 开启时中央才渲染 `DataSection`；默认表映射为空，服务端会按同名交集。证据：`apps/desktop/src-renderer/App.tsx:1702-1725`、`apps/desktop/src-main/compare-run.ts:144-162`。
- “载入表清单”调用 `data.tables`，main 只读 `SQL_TABLES`，并为 A/B pool 同时建立连接。证据：`apps/desktop/src-renderer/store.ts:366-393`、`apps/desktop/src-main/main.ts:289-314`。
- 清单载入后 A/B 同名表自动成为 pair；用户可以改 B、删行、加行。证据：`apps/desktop/src-renderer/store.ts:379-386`、`apps/desktop/src-renderer/App.tsx:792-846`。
- 三项数值输入在 blur/Enter 时归一化；超范围/非法值回落默认并 toast。证据：`apps/desktop/src-renderer/App.tsx:667-730`、`apps/desktop/src-renderer/store.ts:339-364`。
- 表状态以文本/颜色显示 running/done/skipped/error/confirm-needed；没有独立的“仅失败表重试”动作。证据：`apps/desktop/src-renderer/App.tsx:847-871`、`apps/desktop/src-main/data-run.ts:168-248`。
- “确认并重跑”是对整个当前比较重新发送 `confirmOverThreshold: true`；它不是只重跑 confirm-needed 表。证据：`apps/desktop/src-renderer/App.tsx:863-869,1716-1720`、`apps/desktop/src-renderer/store.ts:555-571`。
- 数据结果最终进入同一个 `DiffTable`；当前没有 DML 专用三个 Tab。证据：`apps/desktop/src-renderer/App.tsx:1544-1555,1726-1750`、`.trellis/tasks/archive/2026-09/09-22-ui-fix-batch/design.md:8-23`。

### 7. 差异查看、复制和导出流程

#### 7.1 过滤链

当前 renderer 的最终链是：

```text
items
  → byKw（表/数据对象名或 SQL 子串）
  → byObj（对象多选）
  → byAspect（切面多选）
  → byAspect + diffFilter + verbSet
  → tabItems（同时传给 DiffTable 和 SqlPreview）
```

证据：`apps/desktop/src-renderer/App.tsx:1475-1553`、`apps/desktop/src-renderer/App.tsx:1726-1759`。共享 post-filter 的结构是 scopes → verb → aspect → keyword，组内 OR、组间 AND；证据：`apps/desktop/src-core/compare-filter.ts:79-117`。

- Tab/对象/切面/动词的计数使用上游列表，保证切换可逆；`visibleCount` 是最终 `tabItems.length`。证据：`apps/desktop/src-renderer/App.tsx:1500-1553`、`.trellis/spec/frontend/state-management.md:39-43`。
- 选中行后，SqlPreview 的 current 变为单项，复制/导出/风险/回滚也随之收窄；未选中时使用当前过滤列表。证据：`apps/desktop/src-renderer/App.tsx:896-921`。
- 过滤变更会清理 `selectedId` 的路径是 object/aspect/verb/diff setters；tableFilter/toggleScope 当前不清 selection，SqlPreview 会在 selected id 不在 tabItems 时回退。证据：`apps/desktop/src-renderer/store.ts:292-325`、`.trellis/spec/frontend/state-management.md:21-25`。

#### 7.2 SQL 预览

- `formatSqlSafe` 使用 `sql-formatter` 的 MySQL language + uppercase keywords，失败返回原文。证据：`apps/desktop/src-renderer/sql.ts:18-26`。
- `highlightSql` 先 HTML escape，再暂存注释/字符串/反引号标识符后高亮；唯一生产 `dangerouslySetInnerHTML` 在 `SqlPreview`。证据：`apps/desktop/src-renderer/sql.ts:38-65`、`apps/desktop/src-renderer/App.tsx:954-956`。
- 风险/回滚不是外部服务结果，而是 `apps/desktop/src-core/risk.ts` 的确定性规则；DROP TABLE/COLUMN/PRIMARY 为 high，routine/view 为 medium，index 为 low 等。证据：`apps/desktop/src-core/risk.ts:12-116`、`apps/desktop/src-core/diff.test.ts:212-228`。
- 空结果显示“暂无 SQL”；E2E 报告指出 0 条时按钮提前 return，因此不会产生“暂无可导出 SQL”toast，但不会产生文件。证据：`apps/desktop/src-renderer/App.tsx:937-959`、`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:51-55`。

#### 7.3 复制和文件下载

- 含 DROP 时只复制前弹 `window.confirm`；复制优先 `sql.copy` → navigator.clipboard → textarea execCommand。证据：`apps/desktop/src-renderer/App.tsx:909-922`、`apps/desktop/src-renderer/sql.ts:67-99`。
- `.sql` 下载使用 Blob + `<a download>`，toast 是发起下载后的 optimistic 文案；主进程 handler 设置 Downloads 保存路径，但没有完成事件 IPC。证据：`apps/desktop/src-renderer/sql.ts:101-125`、`apps/desktop/src-renderer/App.tsx:924-935`、`.trellis/spec/backend/quality-guidelines.md:36-40`。
- E2E 用 trusted CDP click 和 `will-download` 文件检查证明过落盘；最新报告也明确空结果不产文件。证据：`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:42-43,68-76`。

### 8. DBeaver 弹窗流程

- 入口在左栏工具行，默认全选所有已加载节点；可逐项取消、全选、全不选，显示 selected/total。证据：`apps/desktop/src-renderer/App.tsx:251-283,982-1093`。
- 弹窗明确写出“不迁移密码/私钥，导入后需重新输入”；私钥节点显示待补密钥。证据：`apps/desktop/src-renderer/App.tsx:1043-1074`。
- store 只传 ids，main 只读 NodeMeta，不调用 Vault；renderer 收到 JSON 后调用 `downloadJsonFile`。证据：`apps/desktop/src-renderer/store.ts:493-500`、`apps/desktop/src-main/main.ts:218-222`、`apps/desktop/src-renderer/App.tsx:1017-1033`。
- 真实 DBeaver IDE import 未在本环境执行；只有结构化 JSON、CDP 下载和无秘密断言。证据：`.trellis/tasks/archive/2026-09/09-22-converters/dbeaver-report.md:5-7,34-54`。

### 9. 错误、状态和视觉反馈

- IPC 错误统一通过 `sanitizeIpcError`；连接测试返回 typed `ConnTestResult`，数据表返回 typed `DataTableStatus`。证据：`.trellis/spec/backend/error-handling.md:3-16`、`apps/desktop/src-renderer/App.tsx:1185-1215,1581-1595`。
- 比较进度通过 `compare.progress` table/fetch 事件，renderer 使用 unsubscribe；toast 2.2 秒自动消失。证据：`apps/desktop/src-renderer/store.ts:540-551,630-638`、`apps/desktop/src-renderer/App.tsx:1456-1461`、`apps/desktop/src-main/main.ts:320-338`。
- 连接中/保存中/测试中/导出中按钮使用 disabled 文案；空节点、空结果、加载、失败和 demo 状态各有文本。证据：`apps/desktop/src-renderer/App.tsx:1219-1239,1354-1367,774-871,937-959`。
- **INFERENCE**：错误信息可诊断但没有统一错误码/日志关联；用户通常只能看到 domain-prefixed message 或 table status，排查跨层原因依赖 task evidence/测试，而不是产品内诊断中心。依据：`.trellis/spec/backend/logging-guidelines.md:3-15`。

### 10. 可访问性和测试边界

- 使用原生 button/input/select/textarea/label，部分 progress/dialog 有 ARIA；没有 React Testing Library、jsdom、快照或 a11y 自动化。证据：`.trellis/spec/frontend/component-guidelines.md:34-38`、`.trellis/spec/frontend/quality-guidelines.md:12-20`。
- 已知 UI 交互缺口：可点击 NodeCard/Slot/表格行没有键盘 handler；tabs/chips 没有 `aria-pressed`；NodeModal 没有 focus trap。证据：`.trellis/spec/frontend/component-guidelines.md:34-38`、`.trellis/spec/frontend/quality-guidelines.md:36-38`。
- 17 个 Vitest 文件/167 tests 覆盖纯函数和注入 fake；UI 交互依赖 Electron CDP。证据：当前 `npm test` 输出、`apps/desktop/vitest.config.ts:3-5`、`.trellis/spec/frontend/quality-guidelines.md:40-60`。
- E2E 报告覆盖节点 CRUD、demo/Docker compare、过滤、DROP/data、中文、导出、secret、快捷键、交换、搜索；指定内网真库/Windows 真机仍为环境限制。证据：`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:22-58`。

## UI Capability Inferences

1. **INFERENCE（高置信）**：当前 UI 已是一个可完成单机迁移审查主闭环的工作台，而不是仅有 demo 的 UI 原型；依据是 Node CRUD、真实 metadata/data 路径、结果过滤、SQL 输出和 CDP 证据同时存在。
2. **INFERENCE（高置信）**：UI 的“共享工作流”仍由单个 Zustand store + 大型 App composition root 承担；跨组件状态边界清楚，但交互分支和本地 workflow state 仍集中在 `store.ts`/`App.tsx`。依据：`.trellis/spec/frontend/state-management.md:3-17`、`apps/desktop/src-renderer/store.ts:138-229`。
3. **INFERENCE（中等置信）**：产品当前最明显的用户可见语义风险是 demo fallback 与真实结果共存于同一结果模型；代码在 toast/lastCombo 写明原因，但没有独立的 demo/real result type 或结果区标识。依据：`apps/desktop/src-renderer/store.ts:611-629`、`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:54-56`。
4. **HYPOTHESIS**：用户是否需要保存/分享/审批结果，当前 UI 没有相关对象或流程，不能从“导出 SQL/JSON”推断已有协作需求。

## Related Specs

- `.trellis/spec/frontend/index.md`
- `.trellis/spec/frontend/component-guidelines.md`
- `.trellis/spec/frontend/hook-guidelines.md`
- `.trellis/spec/frontend/state-management.md`
- `.trellis/spec/frontend/quality-guidelines.md`
- `.trellis/tasks/archive/2026-09/09-22-ui-fix-batch/design.md`
- `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md`

## Caveats / Not Found

- 本文件不把 HTML mock 的行为当作生产事实；`apps/desktop-mock/index.html` 明确是参考原型，当前生产行为以 `apps/desktop/src-renderer/App.tsx`/`store.ts` 为准。规范也把 mock 列为 reference-only：`.trellis/spec/backend/directory-structure.md:43-47`。
- 未发现路由、页面级权限、移动端断点、Monaco 编辑器或用户可编辑 SQL 输入。
- `history.clear`、pinned 编辑、notes、结构表多选和独立 DML Tab 在当前 renderer 中没有完整用户入口；详见 capability inventory。
