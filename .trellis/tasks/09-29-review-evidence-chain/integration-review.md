# 集成复核（S4）— 安全迁移审查证据链

- 复核时间：2026-09-30
- 复核人：smarterlab（Trellis workflow S4）
- 状态：**通过（AC7 ✅）**

## 复核范围

父任务 `09-29-review-evidence-chain` 的 Cross-Child Acceptance Criteria（AC1–AC7），对三个已归档子任务的产出做最终集成复核：三条链路（来源/覆盖/可见性 → manifest → 应用服务测试）语义一致，无重复实现或命名冲突。

## 子任务归档确认（AC1）

| 子任务 | 状态 | 归档路径 |
|---|---|---|
| `09-29-result-source-state` | ✅ 已归档 | `.trellis/tasks/archive/2026-09/09-29-result-source-state/` |
| `09-29-grant-blindness-false-drop` | ✅ 已归档 | `.trellis/tasks/archive/2026-09/09-29-grant-blindness-false-drop/` |
| `09-29-review-manifest` | ✅ 已归档 | `.trellis/tasks/archive/2026-09/09-29-review-manifest/` |
| `09-29-compare-service-integration-tests` | ✅ 已归档 | `.trellis/tasks/archive/2026-09/09-29-compare-service-integration-tests/` |

各子任务 prd/design/implement/jsonl 齐备，验收结论可独立复核。

## 逐项复核结论

### AC2 真实/演示/部分失败可分辨 — ✅

- `ResultSource = 'real' | 'demo'`（`src-core/types.ts:201`），`compare-run.ts` 边界层显式标注 `result.source = 'real'`（`compare-run.ts:245`），`src-renderer/demo.ts:115` 标注 `out.source = 'demo'`。
- renderer store 仅真实成功时保存 `lastCompareRequest`，demo/失败路径清空（`store.ts:615 / 660 / 678`），并有 `demo-source.test.ts` / `store-source-split.test.ts` 断言。
- UI 演示结果醒目区分（demo 无 coverage/visibility，见 `demo-source.test.ts` 的 `hasCoverageNotice`）。

### AC3 无机器可读产物含 secret 或未经裁定行值 — ✅

- `manifest-export.md` §Secret boundary：manifest 不得含 `password` / `sshPassword` / `privateKey` / `passphrase` / `vaultCiphertext` / `SecretBundle` / 连接串。
- `redactDmlSql` 仅作用于 `objectType === 'data'` 的 SQL，在 `serializeManifest` / `manifestToMarkdown` 内部调用（`manifest.ts:101 / 200 / 258 / 293`）。
- `manifest.test.ts` 有秘密字段缺席断言 + AC3 round-trip 测试（真实结果 → manifest → 解析回等价语义）。

### AC4 manifest 显式 schema 版本与升级路径 — ✅

- `REVIEW_MANIFEST_VERSION = 1`（`types.ts:298`），`ReviewManifest.schemaVersion` 显式携带。
- `manifest.test.ts` 断言 `schemaVersion` 可解析、与常量一致；spec 记录了版本与序列化契约。

### AC5 全链无 SQL 执行入口、`mysqldiff/` 未改动 — ✅

- `git log --all -- mysqldiff/` 无任何提交；`git status --porcelain -- mysqldiff/` 无 diff。
- 新增测试仅 mock 连接层，无真实 SQL 执行；全链无写库路径。

### AC6 四件套在每个子任务归档前为绿 — ✅

- 本次复核重新执行四件套：**typecheck ✅ / lint ✅ / test 26 files / 287 tests ✅ / build ✅**。

### AC7 三条链路语义一致、无重复实现或命名冲突 — ✅

- 核心契约类型**单一定义于 `src-core/types.ts`**：`ResultSource` / `CoverageReason` / `Visibility` / `CompareVisibility` / `StructureCoverage` / `DataTableStatus` / `CoverageStatus` / `ReviewManifest` / `REVIEW_MANIFEST_VERSION`。
- manifest 纯函数**唯一实现于 `src-core/manifest.ts`**（`deriveCoverageStatus` / `redactDmlSql` / `buildManifest` / `serializeManifest` / `manifestToMarkdown`），无第二处重复实现。
- `deriveCoverageStatus` 的枚举与 `DataTableStatus` 状态词汇一致（`ok` / `permission-denied` / `no-row-identity` / `over-threshold` / `aborted` / `error` / `grant-invisible`），映射规则在 `manifest-export.md` §4 记录。
- 应用服务集成测试直接消费同一契约：`compare-run.integration.test.ts` 将全链路输出喂 `buildManifest` 并断言 `coverageStatus` 与 `deriveCoverageStatus` 一致（AC5 衔接）。

## 复核发现与修复

| # | 发现 | 处置 |
|---|---|---|
| 1 | `.trellis/spec/backend/index.md` Guidelines 表格未收录子任务 2 新增的 `manifest-export.md` | 本次复核补录索引条目（见下） |

## 复核结论

父任务 AC1–AC7 全部满足。三个子任务产出语义一致、无重复实现或命名冲突；`mysqldiff/` 未触碰；spec 索引缺口已修复。**同意归档父任务。**