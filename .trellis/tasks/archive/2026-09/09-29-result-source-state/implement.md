# Implement — 比较结果来源与覆盖状态显式化

## 1. 类型契约（`src-core/types.ts`）

- [ ] 新增 `ResultSource`、`CoverageReason`、`CoverageSkip`、`StructureCoverage`
- [ ] `CompareResult` 加 `source?` 与 `coverage?`（均为可选）
- [ ] `ObjectType` 已在同文件，确认可作为 `ok` 的 key（若为联合字面量则用 `Record<ObjectType, number>`）

## 2. metadata 覆盖产出（`src-main/metadata.ts`）

- [ ] 新增 `MetadataSnapshot`（`{ meta, skipped }`）与原因分类纯函数
- [ ] 分类函数独立成纯函数并导出，便于单测：输入 `unknown`，输出 `CoverageReason`
  - `err` 缺失（`showCreate*` 返回 null）→ `object-missing`
  - `code === 'ABORTED'`（对齐 `data-run.ts:102`）→ `aborted`
  - MySQL 权限类错误 → `permission-denied`
  - 其余 → `unknown`
- [ ] `tolerant()` 改为接住错误并返回 `{ v, err }`
- [ ] 四类对象的 map 调用同步改为从 `{ v }` 取值，写入 `skipped`
- [ ] `fetchMetadata` 返回 `MetadataSnapshot`
- [ ] 确认 `mapWithLimit` 的 `MAX_CONCURRENCY = 10` 语义未变（`database-guidelines.md:28`）

## 3. 调用点同步（`src-main/compare-run.ts`）

- [ ] `fetchMetadata` 两处调用改为解包 `.meta`
- [ ] 合并 A/B `skipped` 为单一 `StructureCoverage`，`ok` 按对象类型累加
- [ ] 标注 `result.source = 'real'`
- [ ] 确认 `finally` 的 pool 清理逻辑未改动（泄漏修复属子任务 3）

## 4. demo 标注（`src-renderer/demo.ts`）

- [ ] `runDemoCompare` 返回加 `source: 'demo'`
- [ ] 确认不写 `coverage`（demo 覆盖 100%，无意义）

## 5. store 分流（`src-renderer/store.ts`）

- [ ] 新增 `resultError: string | null` 状态
- [ ] `catch` 分流：`isNoIpc` 保留 demo 回填；**其他错误不再写 `items: demo.items`**
- [ ] 真实失败路径：`items: []`、`dataStatus: []`、`resultError: clean`（用 `sanitizeIpcError`）
- [ ] 成功与 demo 路径均清空 `resultError`
- [ ] 核对 `finally` 的状态复位仍包含新字段

## 6. UI（`src-renderer/App.tsx`）

- [ ] `status` 拼装：`source === 'demo'` 时前置「本地示例 ·」
- [ ] 真实错误态：`resultError` 非空时在结果区渲染错误卡片（复用 `.empty` 样式），含原因与排查指引
- [ ] 覆盖计数：`coverage.skipped.length > 0` 时 statusbar 追加「· N 个对象未检查」并可点击展开
- [ ] 明细表：对象名 / 类型 / 原因码，复用 `App.tsx:840-845` 行渲染模式
- [ ] 展开状态用 `App` 局部 state，**不进 Zustand**（`state-management.md:12`）
- [ ] `skipped.length === 0` 时不渲染提示位

## 7. 测试

- [ ] 新增：原因分类纯函数单测（四类分支 + 未知错误降级）
- [ ] 更新 `metadata.test.ts:167-172`（"单对象失败记 null 不中断" → 新契约下 null 不变 + `skipped` 断言）
- [ ] 新增：部分对象失败时 `compareRun` 仍不产生 CREATE/DROP 假象（AC6）
- [ ] 新增：`compare-run` 覆盖合并与 `source='real'` 断言
- [ ] 新增：`runDemoCompare` 的 `source='demo'` 断言
- [ ] 确认既有 core 测试未被 `CompareResult` 新字段破坏

## 8. 规格同步（进入 3.3 前）

- [ ] `.trellis/spec/backend/database-guidelines.md:36` 补充覆盖记录语义（null 跳过不变 + 新增覆盖报告）
- [ ] `.trellis/spec/frontend/state-management.md:47` 的"已知可用性限制"更新为已解决，并记录新的两条路径语义

## Implementation Notes (完成时回填)

### 偏离 design.md（2 处，均为修正）

1. **`tolerant()` 的 `{v, err?}` 形状废弃。** 该形状用 `err` 是否为 `undefined` 区分「无错误」与「出错」，但 `Promise.reject(undefined)` 会让 catch 收到 `undefined`，与「成功但结果为 null」不可区分。改为在 `collect` 内直记：默认 `object-missing`，catch 分支才调 `classifyCoverageReason(err)`。该函数签名因此为 `(err: unknown)`，不再接受 `undefined` 约定。
2. **`mergeCoverage` 按 `scopes` 过滤 `ok` 与 `skipped`。** design 未提。若不过滤，取消勾选「视图」后仍会因未纳入范围的视图产生覆盖警告，与 `filterMetadataByScopes` 语义不一致。

### 额外新增（design 未列）

- `mergeCoverage` 按 A/B 合并但不标注库侧，符合 design 的取舍。
- 3 个 CSS 类（`.linkish` 等）而非复用既有类，因 `.statusbar` 需改为 flex 行。

### Check 阶段自修复（3 处）

1. **错误卡片位置错误**：原本渲染在 `</main>` 之外，与 `state-management.md` 的「in place of the diff list」矛盾，且 `DiffTable` 的「空空如也」空态仍会渲染在上方 —— 失败的对比仍可能被读成「无差异」。已改为在 `.pane-center` 内**替代** `DiffTable` + 数据提示。
2. **覆盖提示位重复**：原有独立 `<section class="coverage">` 面板 + footer 链接两套入口，违反 R4「不新增独立面板」。已删除独立面板，footer 计数成为唯一展开/收起控件。
3. **Q1 分流零测试**：`demo-source.test.ts` 把最高风险的行为变更显式踢给了别的任务。已补 `store-source-split.test.ts`（6 例）。

### 未完成项

- 真实路径 `source: 'real'` 无直接断言（需真实 pool，归子任务 3）
- 无 CDP 证据（错误卡片 / footer 计数 / 明细展开均为交互面）
- 无真库 `permission-denied` 验证（PRD 标注为可选，不阻塞 AC）

## Validation

```bash
cd apps/desktop
npm run typecheck
npm run lint
npm test
npm run build
```

逐层验证：步骤 2、3 完成后先跑一次 typecheck + test，确认 `DatabaseMetadata` 形状未破坏 core 契约。

真实环境验证（可选，不阻塞 AC）：用仅授予部分表权限的账号触发 `permission-denied`，核对状态行计数与明细表。

## Risky Files / Rollback Points

| 文件 | 风险 | 回滚 |
|---|---|---|
| `src-main/metadata.ts` | 触碰 `database-guidelines.md:36` null 跳过不变量 | 若 core 契约受损，回滚本步，不动后续 |
| `src-renderer/store.ts` | 行为变更最大，真实失败路径不再回填 | 可单独回滚步骤 5，不影响 1–4 |
| `src-main/compare-run.ts:87-88` | tuple 解包遗漏会静默产出 undefined | typecheck 必过；typecheck 不覆盖运行时 shape，需测试兜底 |

## Review Gates

1. 步骤 1–3 完成后检查：`CompareResult.source` 在真实路径恒为 `real`；`coverage.skipped` 正确合并
2. 步骤 5 完成后检查：真实失败不再产生 demo items
3. 全量四件套通过后进入 `trellis-check`

## Before `task.py start`

- [ ] `implement.jsonl` / `check.jsonl` 各含至少一条真实 spec 条目
- [ ] 用户已明确批准最终规划摘要
