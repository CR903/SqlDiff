# Design — Review Manifest v1（版本化无秘密）

## Architecture / Boundaries

改动落在既有三层，不新增模块边界：

```
src-core/manifest.ts       manifest schema、序列化、脱敏、CoverageStatus 映射（纯函数，跨宿主）
src-core/types.ts          Manifest 相关类型
src-main/main.ts           IPC handler：从 CompareResult 构建并返回导出物
src-renderer/App.tsx       「导出审查报告」入口（复用现有导出按钮组）
src-renderer/sql.ts        复用 downloadJsonFile / downloadTextFile
```

核心原则：**manifest 是 `CompareResult` 的确定性投影，不是新的一份数据**。序列化在 main 进程（构建时直接拿到 `CompareResult`），renderer 只负责下载。

## Contracts

### 1. Manifest Schema（`src-core/types.ts`）

```ts
export const REVIEW_MANIFEST_VERSION = 1;

/** 一次真实比较的审查证据（无秘密、行值脱敏）。 */
export interface ReviewManifest {
  schemaVersion: typeof REVIEW_MANIFEST_VERSION;
  /** 应用版本（package.json version） */
  appVersion: string;
  /** ISO 时间 */
  exportedAt: string;
  /** A → B 方向 */
  aAlias: string;
  bAlias: string;
  /** scopes / includeData / tableFilter（来自 CompareRequest 的可序列化子集） */
  scope: {
    scopes: string[];
    includeData: boolean;
    tableFilter?: string;
  };
  /** 结果来源（仅允许 'real'；demo 不导出） */
  source: 'real';
  /** 差异统计（stats 的平面化） */
  stats: {
    ALL: number;
    CREATE: number;
    DROP: number;
    CHANGE: number;
    INDEX: number;
    DML: { INSERT: number; DELETE: number; UPDATE: number };
  };
  /** 差异项（DDL 全量，DML 行值脱敏） */
  items: ReviewManifestItem[];
  /** 数据对比逐表状态（含 reason） */
  dataTables?: DataTableStatus[];
  /** 结构覆盖报告 */
  coverage?: StructureCoverage;
  /** 授权可见性报告 */
  visibility?: CompareVisibility;
  /** 覆盖状态统一汇总（枚举 + 计数） */
  coverageStatus: CoverageStatus;
}

/** manifest 内的差异项：DiffItem 的投影（sql 已按类型脱敏）。 */
export interface ReviewManifestItem {
  id: string;
  objectType: DiffItem['objectType'];
  objectName: string;
  changeType: ChangeType;
  dml?: DmlType;
  aspects: StmtAspect[];
  risk: RiskLevel;
  sql: string; // DDL 原样 / DML 脱敏
}
```

**rollback / explain 不进入 manifest**（Q4 决策：保持交接报告最小；且 rollback 含行值需额外裁决）。这通过不复制字段实现，而非复制后再删——避免未来改动忘记同步。

### 2. CoverageStatus（统一枚举 + 计数）

```ts
export type CoverageStatusKind =
  | 'ok'                  // 全部可检查且无差异/有差异（无跳过、无不可见、无失败）
  | 'permission-denied'   // 结构 skipped 含 permission-denied，或数据侧 fetch-failed 且是权限
  | 'no-row-identity'   // 数据侧 no-pk / pk-mismatch
  | 'over-threshold'    // 数据侧 confirm-needed（超阈待确认）
  | 'aborted'          // 结构 aborted 或数据侧 aborted
  | 'error'            // 数据侧 error（fetch-failed 等非权限）
  | 'grant-invisible'; // visibility.excluded 非空

export interface CoverageStatus {
  /** 全局最严重状态（用于快速判断）；无任何问题的真实比较为 'ok'。 */
  kind: CoverageStatusKind;
  /** 各来源计数（映射后累加） */
  counts: Partial<Record<CoverageStatusKind, number>>;
}
```

**映射规则（确定性、纯函数 `deriveCoverageStatus`）**：

| 来源 | 原始状态 | 映射到 |
|---|---|---|
| 无 skipped、无 excluded、无失败 dataTable | — | `ok` |
| `coverage.skipped[].reason === 'permission-denied'` | — | `permission-denied` |
| `coverage.skipped[].reason === 'object-missing' \|\| 'unknown' \|\| 'aborted'` | — | `error`（aborted 单独） |
| `coverage.skipped[].reason === 'aborted'` | — | `aborted` |
| `dataTables[].status === 'skipped' && reason === 'no-pk' \|\| 'pk-mismatch'` | — | `no-row-identity` |
| `dataTables[].status === 'confirm-needed'` | — | `over-threshold` |
| `dataTables[].status === 'error'` | — | `error` |
| `dataTables[].status === 'skipped' && reason === 'over-threshold'` | — | `over-threshold` |
| `visibility.excluded.length > 0` | — | `grant-invisible` |

**优先级（用于取 `kind`）**：`grant-invisible` > `permission-denied` > `over-threshold` > `no-row-identity` > `error` > `aborted` > `ok`。

### 3. DML 脱敏器（纯函数）

在 `sqlLiteral` 层做掩码最干净（`data-diff.ts:49-68`）。脱敏器作用于**已生成的 DML 文本**而非原始值——因为它要保留语句骨架：

```ts
/** 把 DML 语句中的字面值替换为脱敏占位符。 */
export function redactDmlSql(sql: string): string
```

规则（基于 `sqlLiteral` 的输出形态）：
- 单引号字符串字面量 `'...'` → `'***'`（保留引号与转义结构）
- 数字字面量 → `0`
- `NULL` / `TRUE` / `FALSE` 保留
- 反引号标识符、关键字、运算符、注释**原样保留**
- 日期字面量 `'2024-01-01 00:00:00'` → `'***'`（本质是字符串）

**实现选择**：正则分两遍——先提取并替换反引号标识符为占位符，再处理剩余字面量，最后还原。复用 `highlightSql` 的占位符思路（`sql.ts:48-53`）。

**不脱敏 DDL**：仅当 `objectType === 'data'` 的 `DiffItem.sql` 走 `redactDmlSql`。结构 DDL 原样。

### 4. JSON 序列化（确定性）

```ts
export function serializeManifest(m: ReviewManifest): string
```
- `JSON.stringify(m, null, 2) + '\n'`（对齐 `store-json.ts` 的原子写风格，但 manifest 不落盘，只下载）
- 字段顺序即类型声明顺序（TS 对象字面量保持插入序），保证同输入 byte 稳定——对齐 DBeaver 导出的确定性契约（`dbeaver-export.md:51`）

### 5. Markdown 生成

```ts
export function manifestToMarkdown(m: ReviewManifest): string
```

区块（Q4 决策）：
1. 头部：`# SqlDiff 审查报告` + A/B、时间、schemaVersion、appVersion
2. 差异摘要表：`| 对象 | 类型 | 变更 | 风险 |`（不内联 SQL）
3. 结构 DDL 代码块：按对象分组的 ` ```sql ` 块（DML 脱敏）
4. 覆盖/可见性说明：skipped（原因）、grant-invisible（对象+侧）、reliable:false 提示
5. 保密声明：`本报告不含连接凭据；数据行值已脱敏`

复用 `toExportSql` 的头字段（`compare.ts:160-171`）但用 Markdown 语法重写。

### 6. IPC 契约

```ts
// preload.ts
runManifest: {
  build: (req: CompareRequest) => Promise<ManifestExportResult>;
}

export interface ManifestExportResult {
  /** 文件名，如 sqldiff-review-2026-09-30T...json / .md */
  jsonFileName: string;
  markdownFileName: string;
  jsonContent: string;
  markdownContent: string;
  /** 非 'ok' 的覆盖状态，供 UI toast */
  coverageStatusKind: CoverageStatusKind;
}
```

**关键设计**：manifest 构建在 main 进程（`compare.run` 已经跑过、`CompareResult` 在 IPC 返回途中）——但 renderer 拿到的 `CompareResult` 是脱敏前的完整结果。为避免 renderer 侧持有敏感 DML 后再脱敏（脱敏器必须在 main 侧跑），**renderer 把 `CompareRequest` 重新发给 main，main 重新跑一次比较？不行——重跑代价高**。

**更优方案**：`compare.run` 的返回值就是 renderer 已持有的。manifest 导出应复用**本次比较的 `CompareResult`**。做法：`compare.run` 返回 `CompareResult` 后，renderer 在导出时把**结果回传**给 main 做脱敏+序列化？——不行，敏感 DML 已经过 IPC 到 renderer 了。

**决策：DML 脱敏在 main 侧的 `compare.run` 返回前做**。即 `runCompareRequest` 返回的 `CompareResult` 中，`objectType === 'data'` 的 `DiffItem.sql` **已经脱敏**（`redactDmlSql` 在 main 进程、构造结果时应用）。这样：
- renderer 从 `compare.run` 拿到的一直是脱敏后的 DML（数据面板仍展示真实值？——不，数据面板需要真实值！）

**修正**：数据面板必须显示真实行值，所以 `compare.run` 不能脱敏。正确的做法是：**manifest 导出走独立 IPC，main 侧用本次比较的输入参数重新构建 manifest**。

具体：`compare.run` 返回完整结果给 renderer（数据面板用）。同时 main 侧 `compare-run.ts` 在返回前，把 `CompareResult` 的**脱敏投影**暂存？——投影要落盘？Q1 决策是「不落盘」。

**最终方案（低成本且正确）**：manifest 构建是**纯函数，输入是 renderer 持有的 `CompareResult`**，但脱敏在构建函数内部做（`redactDmlSql` 应用于 data 项的 sql）。虽然敏感 DML 已存在 renderer 内存，但：
- renderer 本来就是单机应用，用户自己能看到行值
- 导出物（JSON/MD 下载）是脱敏后的
- 不新增 IPC 往返，不重跑比较，不落盘

**安全边界**：脱敏发生在**下载内容**层面（`manifestToMarkdown` / `serializeManifest` 内部对 data 项调用 `redactDmlSql`），而非 store 内存。这满足 AC2（导出物不含行值），且不破坏数据面板。主进程不参与 manifest 构建——**manifest 构建放 `src-core`，renderer 调用**。

**重新决策**：`ManifestExportResult` 的构建完全在 renderer 侧完成（`src-core/manifest.ts` 纯函数），main 只提供一个 IPC 读 appVersion（或 preload 已有？）。

实际上 appVersion 可从 `window` 拿吗？不能。用 `main.ts` 已有 `ipcMain.handle('app.info')`？先检查有没有。若无，新增 `app.version` IPC 或在 manifest 里用固定 `'0.1.0'` 不准确。**设计：新增 `app.version` IPC（main 读 `app.getVersion()`）**。

## Data Flow

```
用户点击「导出审查报告」：
  App 调用 manifest.buildManifest({
    result: 当前 CompareResult（已含 source/coverage/visibility）,
    request: 上次 CompareRequest（store 已持有 scopes/includeData/tableFilter）,
    aliases: { aAlias, bAlias },
    appVersion: await ipc.app.version(),
  })
  → 纯函数返回 { jsonContent, markdownContent, coverageStatusKind }
  → App 用 downloadJsonFile / downloadTextFile 下载
```

**CompareRequest 从 store 拿**：`runCompare` 已在 store 里构造 request（`store.ts:555-571`），存到 store 供导出用。

## Trade-offs

| 选择 | 代价 | 理由 |
|---|---|---|
| 脱敏在构建函数内（renderer 下载层） | 敏感 DML 仍短暂存在于 renderer 内存 | 数据面板必须显示真实值，无法在 IPC 层脱敏；导出物是脱敏的 |
| 纯函数构建，不重跑比较 | renderer 需存 CompareResult + CompareRequest | 避免重跑代价，符合单机应用形态 |
| rollback/explain 不进入 manifest | 交接时无回滚 SQL | Q4 决策：保持最小；回滚属后续报告工作台 |
| Markdown 含 DDL 代码块 | 文件较大 | Q4 决策：交接价值 |
| 字段顺序即类型顺序 | 新增字段需注意位置 | 保证 byte 稳定（DBeaver 先例） |

## Compatibility

- `ReviewManifest` 是新增类型，不改 `CompareResult` / `DiffItem`。
- `redactDmlSql` 是纯函数新增，不影响 `sqlLiteral` 原实现（数据面板仍显示真实值）。
- IPC 新增 `app.version`，纯增量。
- store 新增 `lastCompareRequest`（或从现有 state 重建），不破坏既有字段。

## Rollout / Rollback

1. `src-core/manifest.ts`：schema、序列化、Markdown、CoverageStatus、脱敏（纯函数）
2. `preload.ts` + `main.ts`：`app.version` IPC
3. `store.ts`：保存 lastCompareRequest
4. `App.tsx`：导出入口按钮 + 下载
每步可独立 typecheck/测试。回滚点：步骤 4 可单独回滚（UI 入口），1–3 纯增量无破坏。

## Operational Notes

- 脱敏器是纯函数，必须在 `src-core` 可单测（字符串/数字/日期/Buffer/NULL）。
- `redactDmlSql` 用占位符方案（复用 highlightSql 思路），必须有「反引号标识符含 `'` 不误伤」的测试。
- 不落盘、不新增存储文件；manifest 只存在于下载内容与浏览器内存。