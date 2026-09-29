# P0 比较结果来源与覆盖状态显式化

- 父任务：`.trellis/tasks/09-29-review-evidence-chain`
- 依赖：无（本链第一个子任务）
- 后续：`.trellis/tasks/09-29-review-manifest` 依赖本任务定稿的来源与覆盖语义

## Goal

让任何一次比较的结果都能被用户和下游消费者**判定来源**（真实 / 演示 / 部分失败）并**判定覆盖面**（哪些对象没被真正检查过及原因），消除"示例差异被当成真实结果"和"权限盲区被当成无差异"这两类误读。

## Background / Confirmed Facts

代码现状（复核于 `653a80c`）：

1. **demo fallback 把两种失败混为一谈。** `apps/desktop/src-renderer/store.ts:611-629` 的 `catch` 同时处理 `no-ipc`（`npm run dev` 无 Electron 后端）和真实对比失败（密码错误、连不上、权限不足），两条路径都执行 `items: demo.items`。即：**连接失败时用户会看到一份完整、格式正确的假 diff**。`isNoIpc` 只影响 toast 文案，不影响是否回填。

2. **唯一提示是 2.2 秒 toast。** `apps/desktop/src-renderer/App.tsx:1443-1448` toast 自动消失。常驻的 `lastComboText`（`store.ts:586, 625`）会显示"本地示例数据"，但它与真实结果占用同一状态位、同一视觉层级，差异列表本身无任何标识。

3. **`CompareResult` 没有任何来源字段。** `apps/desktop/src-core/types.ts:197-202` 只有 `items` / `stats` / `dataTables`。任何下游消费者（SQL 导出、`HistoryEntry`、未来的 manifest）都无从判断手上的结果真假。`HistoryEntry`（`types.ts:114-123`）同样只记 alias/id/diffCount。

4. **结构对比的覆盖损失完全静默。** `apps/desktop/src-main/metadata.ts:190` 的 `tolerant()` 把所有 `SHOW CREATE` 异常吞成 `null`；`apps/desktop/src-core/compare.ts:113-114, 128-129` 遇 `null` 直接 `continue`。**权限不足的表在结果里和"两库一致"完全无法区分。** `metadata.test.ts:167-172` 当前断言"单对象失败记 null 不中断"。

5. **`null` 跳过是有意设计，不能简单改掉。** `.trellis/spec/backend/database-guidelines.md:36` 明确写着 null 跳过的作用是"prevents a permission error from becoming a false CREATE/DROP"。因此修法只能是**保留跳过、追加覆盖记录**，不能改成当空串参与 diff。

6. **数据侧已有逐表状态可参照。** `DataTableStatusKind`（`types.ts:153`）已区分 pending/running/done/skipped/error/confirm-needed 并带 `reason`（no-pk / pk-mismatch / over-threshold / fetch-failed / aborted），但仅在 `includeData` 时存在，结构侧无等价物。

7. **规格已要求产品决策。** `.trellis/spec/frontend/state-management.md:47` 写明"Changes to fallback labeling or behavior require an explicit product decision and UI regression coverage"。

## Requirements

### R1 结果来源可判定

- `CompareResult` 携带显式来源标识，至少区分：真实比较结果、本地演示结果。
- 任何回填示例的路径都必须使该标识可见，**且不依赖会自动消失的提示**。
- 判定的成本必须是"看一眼"级别，不要求用户读日志或猜测。

### R2 失败类型不得与开发态混同

**决策（Q1 已定）**：拆开两条路径。

- **开发/演示态**（`no-ipc`，即 `npm run dev` 无 Electron 后端）：保留本地示例数据降级，来源标识为 demo。这是 `state-management.md:47` 记录的既有支持能力，不破坏。
- **真实比较失败**（凭据错误、连通性失败、权限不足、后端异常）：**不再回填示例数据**。结果列表清空，进入显式错误态，展示消毒后的原因，并引导用户回到节点配置排查。

因此 `isNoIpc` 不再只是 toast 文案分支，而是结果语义的分水岭。

### R3 结构覆盖可判定

- `fetchMetadata` 产出的快照必须能回答"哪些对象没拿到 `SHOW CREATE`、各是什么原因"。
- 覆盖状态区分至少：成功、失败跳过（含原因）、取消；不得只表达"有差异"。
- **保留 `database-guidelines.md:36` 的 null 跳过不变量**：失败对象仍不参与 diff，只是不再静默。
- 覆盖信息不得包含凭据、连接串或 DDL 原文以外的敏感内容。

**决策（Q3，代码勘查后收敛）**：原因码为**粗粒度应用自有码**，参照 `DataTableStatus.reason` 的既有先例（`no-pk` / `pk-mismatch` / `over-threshold` / `fetch-failed` / `aborted`），至少覆盖：

- `permission-denied` — MySQL 权限类拒绝
- `object-missing` — 对象在扫描与 `SHOW CREATE` 之间消失（`SHOW CREATE` 返回零行/缺列）
- `aborted` — 用户取消
- `unknown` — 其余异常，不透传原始 errno/message 给界面

**理由（代码证据）**：`metadata.ts:190` 当前直接丢弃 error 对象，代码库无既有错误分类体系（`ipc-error.ts` 只保留 message 字符串，唯一 code 判断是 `data-run.ts:102` 的 `ABORTED`）。透传 MySQL errno 会带来版本不稳定、泄露服务端细节、与既有 `reason` 词汇不一致三重成本。原始 message 保留在开发日志，不进界面与导出物。

### R4 覆盖信息在界面的呈现

**决策（Q2 已定）**：状态行计数 + 可展开明细。

- footer `statusbar`（`App.tsx:1749`）**常驻**计数，如「12 条差异 · 3 个对象未检查」；不依赖 2.2s toast。
- 点击可展开明细表，字段为对象名 / 对象类型 / 原因码，复用数据侧 `statusRows`（`App.tsx:840-845`）的呈现模式，不新增独立面板。
- 全部成功时不显示提示位，保持界面安静。
- 来源标识（R1）同样走常驻位，不与自动消失的 toast 绑定。

### R5 契约不外扩

- 新字段为**加法**，不改变 `items` / `stats` 的既有语义，现有调用方不因缺省而行为改变。
- 不新增 SQL 执行入口，不改变只读边界。

## Acceptance Criteria

- [x] AC1 `CompareResult` 携带来源标识，`compare.run` 真实返回与 `runDemoCompare` 返回可被调用方区分。
- [x] AC2 真实比较失败时，用户不会看到格式完整的示例差异列表：结果清空并进入显式错误态（Q1 策略）。
- [x] AC3 存在界面上的**常驻**来源标识，不依赖 2.2s toast。
- [x] AC4 存在结构覆盖失败矩阵：对象名、对象类型、原因码可见；权限盲区不再等同于"无差异"。
- [x] AC5 覆盖信息含"全部成功"与"存在跳过"两种可区分状态，且"存在跳过"在结果界面有提示位。
- [x] AC6 `null` 跳过不变量保留：有 `null` 的对象仍不产生 CREATE/DROP 假象。
- [x] AC7 `metadata.test.ts:167-172` 的断言按新契约更新，且有覆盖失败场景的单测。
- [x] AC8 单测、typecheck、lint、build 全绿；`npm run dev` 无 Electron 场景仍能跑出演示结果。
- [x] AC10 覆盖明细全部成功时状态行不显示额外提示（界面安静），存在跳过时才出现计数与展开入口。
- [x] AC9 `mysqldiff/` 未改动；无任何写库路径新增。

## Out of Scope

- Review manifest、报告导出、JSON/Markdown 产物（属 `09-29-review-manifest`）。
- baseline / 漂移语义。
- headless CLI / CI 退出码。
- 修复 `.trellis/spec/backend/database-guidelines.md:30` 记录的 pool 构造泄漏（属子任务 3）。
- 大表内存与基准（属另一 P1 任务）。
- 把覆盖信息做成自动阻断发布的功能。

## Key Decisions

| # | 决策 | 依据 |
|---|---|---|
| Q1 | 拆开两条路径：无后端保留示例，真实失败转显式错误态 | 用户决定；`state-management.md:47` 要求显式产品决策 |
| Q2 | 覆盖信息：状态行计数 + 可展开明细 | 用户决定；复用 `App.tsx:840-845` statusRows 模式 |
| Q3 | 原因码用粗粒度应用码，不透传 MySQL errno | 代码勘查：`metadata.ts:190` 丢弃 error、无既有错误分类体系、参照 `DataTableStatus.reason` |

## Risks

- **改动跨 main/core/renderer 三层契约**，`DatabaseMetadata` 与 `CompareResult` 都是共享类型，回归面比表面大。
- `tolerant()` 必须改为接住 error 而非丢弃，这是 `fetchMetadata` 内部行为变更，`metadata.test.ts:167-172` 需同步。
- 覆盖提示若做得过重，会让正常用户每次都看到警告；已用"全部成功时静默"约束。
- 原因码分类依赖 MySQL 错误形态，未知错误必须降级为 `unknown` 而非误分类。

## Notes

- 依据：`.trellis/tasks/archive/2026-09/09-24-product-expansion-roadmap/roadmap.md` §2.3、§5.2 P0。
- 父任务要求：全链无 SQL 执行入口、不含 secret、父任务不作为实现目标。
