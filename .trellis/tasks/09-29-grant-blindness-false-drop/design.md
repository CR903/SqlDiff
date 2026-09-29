# Design — 授权盲区导致假 DROP

## Architecture / Boundaries

沿用既有三层，不引入新模块：

```
src-main/grants.ts         新文件：授权完整性判定（纯解析 + DbQueryable 探针）
src-core/types.ts          新增 visibility 契约（跨宿主共享）
src-main/compare-run.ts    收窄元数据 + 合并「无法比较」清单
src-renderer/store.ts      新增 exclusion 状态
src-renderer/App.tsx       常驻范围明示
```

`src-core` 保持纯函数/纯类型，不引入 Node 依赖、不反向依赖 `src-main`。判定逻辑（授权文本 → 结论）是纯函数，放在 `src-core` 以便单测；探针（执行 `SHOW GRANTS`）放 `src-main`。

## Contracts

### 1. 可见性判定

```ts
/** 单库的可见性完整度：full=可证明全量可见；partial=可证明存在不可见对象。 */
export type Visibility = 'full' | 'partial';

/** 账号在一批库上的可见性判定结果。 */
export interface VisibilityAssessment {
  /** 库名 → 判定。未列出的库视为 'partial'（默认保守）。 */
  byDatabase: Record<string, Visibility>;
  /** 判据是否可靠：false 表示 SHOW GRANTS 失败或输出无法解析，一律按 partial 处理。 */
  reliable: boolean;
}
```

**为什么不放 `Reason` 枚举**：不可见对象的原因就是「授权不可见」，无多态分支。加枚举会诱导无意义细分。

### 2. 无法比较清单

```ts
export interface ExcludedObject {
  name: string;
  objectType: ObjectType;
  /** 哪一侧可见（另一侧不可见）。 */
  side: 'a-only' | 'b-only';
  reason: 'grant-invisible';
}

export interface CompareVisibility {
  /** 被排除的单侧不可见对象。 */
  excluded: ExcludedObject[];
  /** 实际进入比较的对象总数。 */
  compared: number;
  /** 判据是否可靠；false 时界面需更强的提示措辞。 */
  reliable: boolean;
}
```

`CompareResult` 加法扩展：`visibility?: CompareVisibility`（可选，保持 core 既有构造点不变）。

### 3. 授权解析（纯函数，`src-core`）

输入 `SHOW GRANTS FOR CURRENT_USER()` 的行数组，输出逐库判定。判别式（实测见 PRD §5）：

- 命中 `` ON `db`.* `` 或 `` ON db.* `` → 该库 `'full'`
- 命中 `` ON `db`.`tbl` `` → 该库 `'partial'`
- 命中 `` ON *.* ``（全局非 USAGE）→ 所有库 `'full'`
- 命中 `GRANT \`role\` TO`（角色授权，无 `ON`）→ `reliable: false`，全部按 `partial`
- 无法解析 / 空输出 / 查询抛错 → `reliable: false`，全部按 `partial`

**保守方向**：`reliable: false` 永远退向 `partial`（收窄），绝不退向 `full`（放行假 DROP）。这是 Q3 的落地。

### 4. 收窄

`compare-run.ts` 在 `filterMetadataByScopes` 之后、`compareRun` 之前：

```
1. 拉 A/B 元数据（现有 fetchMetadata）
2. 拉 A/B 授权判定（并发，SHOW GRANTS）
3. 若该库任一侧 visibility ≠ 'full'：
     计算双方可见对象交集
     从 filteredA/filteredB 中移除单侧对象
     记录 ExcludedObject(side)
4. compareRun(filteredA', filteredB')   ← 假 DROP 在此已归零
5. result.visibility = { excluded, compared, reliable }
```

**为何在 `compareRun` 之前收窄而非之后过滤**：假 DROP 在 `compareRun` 内生成（`compare.ts:110-117` 对 `missing` 侧传空串）。事后过滤 items 无法区分「真 DROP」与「假 DROP」。必须在输入侧收窄。

**为何不改 `compare.ts`**：`compareRun` 是纯函数，不该知道授权/可见性概念。收窄在边界层（`compare-run.ts`）做，符合 `directory-structure` 的分层约定，且 `demo.ts` 的 demo 路径不受影响。

## Data Flow

```
真实路径:
  runCompareRequest
    ├─ fetchMetadata(A) / (B)          → snapA.meta, snapB.meta
    ├─ assessVisibility(A) / (B)      → SHOW GRANTS（并发）
    ├─ filterMetadataByScopes
    ├─ narrowToSharedVisibility(...)   → filtered' + excluded
    ├─ compareRun(filteredA', filteredB')
    └─ result.source='real'; result.coverage=mergeCoverage(...); result.visibility={...}

demo 路径:
  runDemoCompare → source='demo'，无 coverage/visibility
```

## UI

**范围明示（常驻）**：`status`（`App.tsx:1585` 附近）复用上一任务的状态行机制：

- `visibility.reliable && excluded.length === 0` → 不显示任何提示
- `excluded.length > 0` → 状态行追加「· N 个对象因授权未参与比较」；可展开明细（对象名 / 类型 / 哪侧可见）
- `reliable === false` → 额外措辞「授权范围无法确认，已按最保守范围比较」，措辞更强

明细复用上一任务的 `coverage-card` / `st-skipped` 行样式（`App.tsx:1746-1761`），不新增独立面板，符合 R3 与 `state-management.md:12`（展开态归 `App` 局部 state）。

## 秘密边界

- `SHOW GRANTS FOR CURRENT_USER()` 只读当前用户自身，不接受 `FOR <user>` 参数（`grants.ts` 内不提供该入口）。
- 授权原文**不进入** `CompareResult` / store / 界面 / manifest；只传递 `Visibility` 枚举与对象名清单。
- R4 在实现 checklist 中作为独立检查项。

## Trade-offs

| 选择 | 代价 | 理由 |
|---|---|---|
| 收窄在 `compare-run.ts` 而非 `compare.ts` | 边界层多一步 | `compareRun` 保持纯函数；假 DROP 在 core 内生成，输入侧收窄是唯一正解 |
| 判定放 `src-core` 纯函数 + `src-main` 探针 | 多一个文件 | 解析是纯逻辑应可单测；`SHOW GRANTS` 执行属 main |
| `reliable: false` 退向收窄 | 极端情况收窄过多 | 误判为 full 会漏出假 DROP，代价远大于过度收窄 |
| 不为不可见原因做枚举 | 单一 reason | 不可见只有「授权不可见」一种原因，无多态分支 |
| 不改 `demo.ts` | demo 无 visibility | demo 是可信示例数据，无需授权判定 |

## Compatibility

- `CompareResult.visibility` 可选，既有 core 测试构造点不变。
- 库级授权账号（`cov_view`）走 `full` 分支，输出与改动前**完全一致**（AC5）。
- `fetchMetadata` 签名不变；新增 `assessVisibility` 是独立探针，不影响现有 tuple 解包。
- 旧 spec `database-guidelines.md:36` 的限定性修正由 Phase 3.3 同步。

## Rollout / Rollback

分步实施，每步可独立 typecheck：

1. `src-core` 授权解析纯函数 + `CompareVisibility` 类型（无运行时影响）
2. `src-main/grants.ts` 探针 + `assessVisibility`
3. `compare-run.ts` 收窄 + 合并 visibility
4. store 状态 + UI 明示

回滚点：步骤 3 是行为变更最大处（改变既有用户输出）。若发现过度收窄影响正常路径，可单独回滚 3–4 而不影响 1–2（解析层仍可复用）。步骤 1–2 纯增量，无回滚必要。

## Operational Notes

- `SHOW GRANTS` 与元数据拉取**并发**执行，不串行拖慢比较。
- 云厂商托管实例（RDS 等）可能改写 `SHOW GRANTS` 形态 → 落 `reliable: false` → 保守收窄。
- fixture 验证：`cov_limited`（应收窄、假 DROP 归零）/ `cov_view`（不应收窄）/ `cov_mixed`（A 全 B 不全，逐库判定）。
- 本任务同时可清理上一任务的真库 `permission-denied` 欠账：fixture 的 `cov_view` 对视图返回 1142，可顺带验证 `permission-denied` 分支对真库生效。
