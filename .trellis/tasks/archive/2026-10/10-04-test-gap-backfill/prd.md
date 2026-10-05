# 补历史功能测试缺口

## Goal

给代码面扫描出的**零覆盖 / 弱覆盖**函数补齐测试用例，让"每个功能点和优化点都有测试"成为可核查的事实，而非依赖记忆。

## Background（已确认事实 · 代码面扫描，2026-10-04）

扫描方式：`grep -rho "\b<fn>\b" src-{core,main,renderer}/**/*.test.ts | wc -l`。结果为 0 视为零覆盖；1–3 视为弱覆盖。

### 完全零覆盖的导出函数

| 模块 | 零覆盖函数 | 说明 |
|---|---|---|
| `src-core/risk.ts` | `riskFor` / `explainFor` / `rollbackFor` | 三个薄封装；`assessRisk` 本身在 `diff.test.ts` 有 4 处，但三个导出入口从未被直接调用 |
| `src-core/compare-filter.ts` | `normalizeScopes` / `hasDataScope` | 在 `compare-run.ts` 内部使用，但无直接单测（非法输入、无数据开关语义未覆盖） |
| `src-main/vault.ts` | `loadOrCreateMasterKey` / `aesGcmEncrypt` / `aesGcmDecrypt` / `assertSafeNodeId` | `Vault` 类经 `vault.test.ts` 走通，但四个导出原语零直测（`assertSafeNodeId` 的路径穿越防护尤其需要独立断言） |
| `src-renderer/sql.ts` | `saveTextFile` / `saveTextFiles` / `copyText` / `downloadTextFile` / `formatSqlSafe` / `exportSavedMessage` | 6 个导出零覆盖；`highlightSql` 有 5 处、`buildExportText` 4 处 |
| `src-renderer/demo.ts` | `buildDemoMetadata` | demo 模式入口数据结构无直测（`runDemoCompare` 有 5 处） |
| `src-core/compare.ts` | `sortDiffItems` | 被 `compareRun` 内部使用（`:141`/`:160`），排序规则无独立断言 |

### 弱覆盖

| 模块 | 函数 | 引用数 | 缺口 |
|---|---|---|---|
| `src-main/compare-run.ts` | `resolveDataPairs` | 1 | A/B 数据配对解析几乎无覆盖 |

## Requirements

- [ ] R1 每个上表函数新增独立 `it()`，至少 2 项（正常路径 + 边界/异常路径）
- [ ] R2 `assertSafeNodeId` 必须覆盖路径穿越与非法字符（如 `../`、绝对路径、空串）三类攻击形态
- [ ] R3 `aesGcmEncrypt`/`aesGcmDecrypt` 必须覆盖往返一致、密文不含明文、错误密钥解密抛错
- [ ] R4 `normalizeScopes` 必须覆盖 `unknown`/空/混合非法值的降级语义（这是外部请求入口）
- [ ] R5 `saveTextFiles`/`copyText`/`downloadTextFile` 涉及浏览器 API，需 mock，断言失败路径不抛未捕获异常
- [ ] R6 补测不修改产品代码（R4 父任务约束）；若发现产品 bug 只记录、另开任务
- [ ] R7 补测文件全部落在 `tests/` 下（依赖迁移子任务先行）

## Acceptance Criteria

- [ ] AC1 上表全部函数在 `tests/` 中有直测用例，`grep` 计数均 ≥ 2
- [ ] AC2 用例总数 ≥ 650 + 新增数（预期新增 25–35 项）
- [ ] AC3 `npx vitest run` / `typecheck` / `lint` / `build` 全绿
- [ ] AC4 `git diff --name-only` 不含任何 `src-*/` 产品源文件
- [ ] AC5 补测过程中发现的产品 bug 已在任务 notes 中记录

## Out of Scope

- 迁移 e2e spec（属 `10-04-tests-migration` 之外的独立 harness）
- 覆盖率工具接入（vitest coverage）与阈值门禁——本轮先补用例，工具化另议
- React 组件渲染测试（当前项目无 testing-library，属新增依赖）

## Key Decisions

- 补测范围以**代码面扫描**为准，不按任务历史逐条追认：历史任务 AC 已由当时的 check 覆盖过，追认会产生大量无价值重复用例
- 不引入新依赖（testing-library / jsdom）：浏览器 API 用 `vi.stubGlobal` mock

## Open Questions

无。
