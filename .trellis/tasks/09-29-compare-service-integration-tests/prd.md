# P1 compare/data 应用服务集成测试

- 父任务：`.trellis/tasks/09-29-review-evidence-chain`
- 前置：`09-29-result-source-state`（source/coverage 契约）、`09-29-review-manifest`（CoverageStatus/manifest 契约）均已归档
- 对应路线图 §5.2 P0：「compare/data 应用服务集成测试 —— 当前测试主要覆盖纯函数，cleanup/cancel/partial failure 仍有缺口」

## Goal

为 compare/data 应用服务（`runCompareRequest` / `runDataCompare`）补齐**可重复的集成测试**，把资源释放、取消传播、部分失败不中断这三条不变式变成自动化断言，支撑前两个子任务定稿的契约（source / coverage / visibility / dataTables 状态）在真实服务编排路径上被验证。

## Background / Confirmed Facts

### 1. 服务层实现（被测对象）

| 行为 | 实现位置 | 现状 |
|---|---|---|
| 资源释放（finally 关池） | `compare-run.ts:296-298`（`Promise.allSettled([poolA?.end(), poolB?.end()])`）；`data-run.ts:313-315` | 无测试证明异常路径关池 |
| 取消传播 | `data-fetch.ts:97-103`（`throwIfAborted` 抛 `code:'ABORTED'`）→ `data-run.ts:290-291`（`isAbortErr` → 整体抛出）→ `main.ts:282-290`（`compare.cancel` → `dataAbort.abort()`） | 无测试证明 signal 中断会整体抛出且关池 |
| 部分失败不中断 | `data-run.ts:286-312`：逐表串行，`DataThresholdError` → `confirm-needed`，其他异常 → `error:fetch-failed`，均 `continue` 处理下一表 | 无测试证明多表混合状态正确 |
| 结构+数据混合结果 | `compare-run.ts:253-276`：数据对比追加进 `CompareResult`，`source='real'`、`coverage`、`visibility`、`dataTables` 一并组装 | 无集成测试证明全链路输出形状 |

### 2. 现有测试只覆盖纯函数

- `compare-run-coverage.test.ts`：`mergeCoverage` 合并、`source` 标注（demo/core 缺省）
- `compare-run-visibility.test.ts`：`narrowToSharedVisibility` 收窄
- `data-run-identity.test.ts`：`decideIdentity` 行身份决策
- `data-fetch.test.ts`：`fetchPageByPK` 的 SQL/参数拼装
- `metadata.test.ts`：元数据 SQL/并发/`classifyCoverageReason`
- `connection.test.ts`：隧道配置/缓存（无真实建连）

**没有任何测试调用 `runDataCompare` 或 `runCompareRequest` 本身**——cleanup / cancel / partial failure 三条不变式无自动化断言。

### 3. 测试策略既有约定（spec）

`backend/quality-guidelines.md` §Test Strategy：
> Tests are Vitest files, mostly colocated, and avoid live infrastructure by extracting pure functions or injecting minimal fakes.
> Test null/empty input, compatibility edges, and cleanup paths, not just the happy path.

`quality-guidelines.md:38`：Close assigned pools in `finally` … cancel long data reads through the `AbortSignal` path。
`quality-guidelines.md:70`：assigned resources are closed, generated SQL is never sent to a pool。

### 4. 可 mock 的边界（模块级注入）

- `store-json.loadNodes`（节点读取）→ 假节点数组
- `connection.createMysqlPool`（连接创建）→ 假 Pool（`end` spy）
- `metadata.fetchMetadata` / `showCreateTable`（元数据拉取）→ 固定快照 / DDL
- `data-fetch.fetchAllByPK` / `getRowCount`（数据拉取）→ 可编程行为（成功 / 阈值 / 失败 / 取消）
- `grants.assessVisibility`（授权探针）→ 固定 `full/reliable`
- `ctx.vault`（秘密读取）→ 直接传假对象（`getNodeSecret` 返回假 secret）

被测对象（`runDataCompare` / `runCompareRequest` 及其内部编排逻辑）保持真实执行。

## Requirements

### R1 cleanup 集成测试

- 连接创建后元数据拉取失败 → `runCompareRequest` reject，且 A/B 两个池的 `end()` 均被调用。
- 数据对比中途出现普通异常 → `runDataCompare` 不泄漏连接，`end()` 被调用。

### R2 cancel 集成测试

- `AbortSignal` 中断数据拉取（`code:'ABORTED'`）→ `runDataCompare` 整体抛出（不是逐表 error），且池关闭。
- `runCompareRequest` 的 data 阶段取消 → 整体 reject，池关闭。

### R3 partial failure 集成测试

- 多表数据对比：一表正常（done）、一表超阈（confirm-needed / over-threshold）、一表拉取失败（error / fetch-failed）→ 不中断，`tables` 状态齐全、`items` 只含成功表、`stats` 正确累加。
- 无行身份表（no-pk）→ `skipped` 状态 + 行数，不中断（回归 `data-run-identity` 的服务层行为）。

### R4 全链路输出形状（runCompareRequest 集成）

- 结构对比 + 数据对比混合成功 → `CompareResult` 含 `source:'real'`、`coverage`、`visibility`、`dataTables`，`items` 排序后合并、`stats` 正确。
- 该结果可直接喂给 `buildManifest`（与 `09-29-review-manifest` 的契约衔接验证）。

### R5 只读边界

- 集成测试全程不执行真实 SQL；`mysqldiff/` 未改动；无写库路径。
- 测试只注入 fakes，不依赖真库 / Docker fixture / 网络。

## Acceptance Criteria

- [ ] AC1 `runDataCompare` 的 cleanup / cancel / partial failure 均有集成测试，且断言池 `end()` 被调用。
- [ ] AC2 `runCompareRequest` 的元数据失败 cleanup、data 阶段取消、结构+数据混合输出均有集成测试。
- [ ] AC3 部分失败测试断言 `tables` 状态序列（done / confirm-needed / error / skipped）与 `items` / `stats` 一致性。
- [ ] AC4 取消测试断言整体抛出（不是逐表 error），且错误码为 `ABORTED`（或等价 `AbortError`）。
- [ ] AC5 全链路输出可被 `buildManifest` 消费（衔接 `09-29-review-manifest`）。
- [ ] AC6 测试不依赖真库 / fixture / 网络，运行时间稳定（mock 连接层）。
- [ ] AC7 四件套全绿：typecheck / lint / test / build。
- [ ] AC8 `mysqldiff/` 无本任务 diff；无新增写库路径。

## Out of Scope

- 真实 MySQL fixture / Docker 集成环境（本任务用 mock 连接层，fixture 冒烟如需要单独排期）。
- IPC handler（`compare.cancel` 等）的 Electron 层测试——取消传播在服务层验证，IPC 是薄接线。
- 大表基准（10k/100k/1m 行、BLOB、峰值内存）——属路线图 P1 `sqldiff-data-diff-hardening`。
- UI 层 CDP 验证——本任务无 UI 改动。
- 修改被测服务实现本身（Q3 已批准：测试暴露的缺陷允许最小修复，范围与回滚点见 implement.md）。

## Open Questions

- ~~Q1（阻塞）测试边界策略~~ **已定**：纯 mock 连接层。模块级 mock `createMysqlPool` / `fetchMetadata` / `fetchAllByPK` / `getRowCount` / `showCreateTable` / `loadNodes` / `assessVisibility`，被测服务（`runDataCompare` / `runCompareRequest` 编排逻辑）全真。零环境依赖、CI 稳定，符合 spec「avoid live infrastructure」。
- ~~Q2 全链路范围~~ **已定**：两者都覆盖。`runDataCompare` 单独测（cleanup/cancel/partial failure 细粒度）+ `runCompareRequest` 全链路测（元数据失败 cleanup、data 阶段取消、结构+数据混合输出）。父任务锚点明确「compare/data 应用服务」。
- ~~Q3 缺陷修复授权~~ **已定**：允许最小修复。测试暴露的服务层缺陷（如某路径未关池、取消未传播）允许最小修复，但需在 implement.md 明确触及文件与回滚点，修复后四件套全绿。

## Key Decisions

| # | 决策 | 依据 |
|---|---|---|
| Q1 | 纯 mock 连接层，不用真库/fixture | `backend/quality-guidelines.md` §Test Strategy「avoid live infrastructure by injecting minimal fakes」；被测对象是服务编排逻辑，不依赖 MySQL 真实语义 |
| Q2 | `runDataCompare` + `runCompareRequest` 全链路都覆盖 | 父任务锚点「compare/data 应用服务」的 cleanup/cancel/partial failure 可重复测试 |
| Q3 | 测试暴露的缺陷允许最小修复 | 否则 AC 无法满足；修复范围受只读边界与 `mysqldiff/` 不动约束 |

## Notes

- 依据：`roadmap.md` §5.2、父任务 `prd.md` Task Map 子任务 3 与 AC5/AC6。
- 关键锚点：`compare-run.ts:197-319`、`data-run.ts:254-320`、`data-fetch.ts:97-135`、`main.ts:282-341`、`backend/quality-guidelines.md:37-54`。