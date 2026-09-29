# Design — 比较结果来源与覆盖状态显式化

## Architecture / Boundaries

改动落在既有三层，不新增模块边界：

```
src-core/types.ts        新增来源 + 覆盖契约（跨宿主共享，纯类型）
src-main/metadata.ts     tolerant() 接住错误 → 产出覆盖记录
src-main/compare-run.ts  合并 A/B 覆盖 → 写入 CompareResult
src-renderer/store.ts    no-ipc 与真实失败分流；demo 结果打来源标记
src-renderer/App.tsx     状态行常驻标识 + 可展开明细
```

`src-core` 保持纯函数与纯类型，不引入 Node 依赖，不反向依赖 `src-main`。

## Contracts

### 1. 来源标识

```ts
/** 比较结果来源：real=主进程真实比较；demo=本地示例降级。 */
export type ResultSource = 'real' | 'demo';
```

`CompareResult` 加法扩展（`types.ts:197`）：

```ts
export interface CompareResult {
  items: DiffItem[];
  stats: CompareStats;
  dataTables?: DataTableStatus[];
  /** 结果来源；缺省视为 'real' 以兼容既有构造点。 */
  source?: ResultSource;
  /** 结构覆盖报告；缺省表示未采集（兼容既有测试构造）。 */
  coverage?: StructureCoverage;
}
```

**兼容性理由**：`compare.ts:107` 的 `compareRun` 与 `compare-filter.ts:90` 的 `postFilterResult` 都在 core 内构造结果，无法在纯 core 判定来源（core 不知道调它的是主进程还是 demo）。因此 `source` 允许缺省为 `real`，由**边界层显式标注**：`compare-run.ts` 标注 real，`demo.ts:runDemoCompare` 标注 demo。缺省为 real 是有意的保守选择 —— 宁可让一个漏标注的真实现实被当成真，也不让真实结果被误标为 demo。

### 2. 结构覆盖契约

```ts
export type CoverageReason =
  | 'permission-denied'
  | 'object-missing'
  | 'aborted'
  | 'unknown';

export interface CoverageSkip {
  /** 对象名 */
  name: string;
  /** 对象类型，与 ObjectType 对齐 */
  objectType: ObjectType;
  reason: CoverageReason;
}

export interface StructureCoverage {
  /** 成功取到 SHOW CREATE 的对象数，按类型 */
  ok: Record<ObjectType, number>;
  /** 未取到 SHOW CREATE 的对象明细 */
  skipped: CoverageSkip[];
}
```

不设计"覆盖比例异常"阈值 —— PRD 已定为计数 + 明细，避免引入隐式告警等级。

### 3. metadata 层产出

`DatabaseMetadata` 保持 `Record<string, string | null>` 形状不变（`compare.ts:63` 的 `pick` 与 null 检查依赖它，且 `database-guidelines.md:36` 是不变量）。`fetchMetadata` 增加**并列返回值**，用 tuple 保持既有解构位置兼容：

```ts
export interface MetadataSnapshot {
  meta: DatabaseMetadata;
  skipped: CoverageSkip[];
}
```

`fetchMetadata` 现有调用点（`compare-run.ts:87-88`、测试）需同步改为解包 `.meta`。这是本任务唯一的破坏性内部变更，不外泄到 IPC 契约。

`tolerant()` 从丢弃错误改为接住并分类：

```ts
const tolerant = async (p: Promise<string | null>): Promise<{ v: string | null; err?: unknown }> =>
  p.then((v) => ({ v })).catch((err) => ({ v: null, err }));
```

`showCreate*` 自身在缺行/缺列时返回 `null`（`metadata.test.ts:82`），此时归类为 `object-missing` 而非 `unknown` —— 区分依据是 `err` 是否为 undefined。

## Data Flow

```
真实路径:
  compare-run.runCompareRequest
    → fetchMetadata(A) + fetchMetadata(B)   // 各产出 { meta, skipped }
    → compareRun(metaA, metaB)              // null 跳过不变量不变
    → result.source = 'real'
    → result.coverage = { ok: 计数A∪B, skipped: A.skipped ∪ B.skipped }

demo 路径:
  renderer runDemoCompare → source='demo'，无 coverage

失败路径（Q1）:
  store.runCompare catch
    ├─ isNoIpc  → demo 回填，source='demo'，coverage=undefined
    └─ 其他错误  → items=[], dataStatus=[], source 不变（无结果），
                   进入显式错误态（新增 resultError 状态）
```

A/B 覆盖合并时不区分库侧 —— 明细表用 `objectType` + `name` 呈现即可定位；跨库同名对象（例如两边都叫 `users`）会各产生一条 skipped，这是**可接受的保守表现**：宁可提示"至少有一侧未检查"也不要假装检查过。若需要标注库侧，可在明细表加一列 A/B 标识；PRD 未要求，先不加。

## UI

**常驻来源标识**：`status`（`App.tsx:1564-1566`）拼装时按 `source` 前置标记。

- `source === 'demo'` → 前缀「本地示例 · 」并保持现有的"本地示例数据"文案
- 真实成功 → 无前缀（保持当前观感，避免噪音）

**显式错误态**：`no-ipc` 之外的失败不再写 `items`。store 新增 `resultError: string | null`，`App` 在结果区渲染错误卡片（原因 + "请检查 A / B 节点配置后重试"），替代原本的差异列表位置。复用既有 `.empty` 样式类，不新建组件体系。

**覆盖计数与明细**：

- footer `statusbar` 在 `coverage.skipped.length > 0` 时追加「· N 个对象未检查」，可点击展开
- 明细表复用 `App.tsx:840-845` 数据侧 `statusRows` 的行渲染模式，字段为对象名 / 类型 / 原因码
- 展开状态放 `App` 的局部 state（符合 `state-management.md:12` 的 renderer-only 约定），**不进 Zustand**
- `skipped.length === 0` 时不渲染任何提示位

## Trade-offs

| 选择 | 代价 | 理由 |
|---|---|---|
| `source` 缺省为 `real` | 漏标注的 demo 结果会被当真 | 演示是开发态便利，真实结果误标代价更高；且 demo 构造点只有 1 处（`demo.ts`），可静态核查 |
| `fetchMetadata` 改返回 tuple | 破坏既有调用点 | 保持 `DatabaseMetadata` 形状不变是 `database-guidelines.md:36` 不变量的前提 |
| 覆盖不做比例阈值 | 用户需自己判断 1/500 与 500/500 的差别 | 阈值属产品策略，PRD 未授权；先给事实 |
| 明细不标 A/B 侧 | 同名对象出现两条，略显冗余 | 避免半错误的库侧标注（实际可能是双侧都失败）；后续 manifest 任务可补精确侧别 |

## Compatibility

- `CompareResult` 新字段全为可选，既有单测构造点（`diff.test.ts`、`data-diff.test.ts` 等）无需改动。
- `DatabaseMetadata` 形状不变，`compare.ts` 的 `pick` 与 null 检查不动。
- IPC 契约新增字段向后兼容：`preload.ts:92` 的 `Promise<CompareResult>` 自动携带。
- `HistoryEntry` **本任务不改** —— demo 路径本就不写历史（`compare-run.ts:121-134` 仅在真实成功时 append）。下游 manifest 任务再决定是否需要记录来源。

## Rollout / Rollback

单一 task 的分步实施，每步可独立 typecheck：

1. 类型 + metadata 覆盖产出（无 UI 变化）
2. compare-run 合并 + source 标注（无 UI 变化）
3. store 分流（错误态）
4. UI 标识 + 明细

回滚点：步骤 1–2 若发现 `database-guidelines.md:36` 不变量受损，回滚该步而不动后续。步骤 3 是行为变更最大的位置（用户可见的错误态），若引起意外回归可单独回滚而不影响 1–2。

## Operational Notes

- 不新增日志基础设施。原始错误 message 若需保留，走既有 `console` 模式，**不进界面与导出物**。
- 内网真库可验证：构造一个只授予部分表 `SHOW VIEW` 权限的账号，触发 `permission-denied`，核对明细表与计数。本任务不因此宣称已支持内网库。
