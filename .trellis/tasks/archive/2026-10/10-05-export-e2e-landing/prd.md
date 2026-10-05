# 补 §11.1 保密边界断言 + Preflight/Manifest 导出 UI E2E

## Goal

两件事，都是「让已有契约变成真的」，不新增产品能力：

1. **§11.1 保密硬边界落测试**：构造含凭据的输入 → 走 Preflight 三种导出格式 + Manifest 导出 → 断言产物不含任何凭据值。这条边界**全仓零断言**。
2. **UI 可达性 E2E**：真机上走完 `对比 ⚡` → `运行 Preflight` → `导出 Preflight 报告` + `导出审查报告`，校验 3 个 Preflight 文件 + Manifest 文件落盘且内容正确。

父任务：[10-05-contract-test-landing](../contract-test-landing/)

## 背景（已核实 · 2026-10-05）

### 缺口 1：§11.1 保密硬边界零断言

`.trellis/spec/backend/preflight.md §11.1` 把「`PreflightReport` 与 Markdown 导出物必须不含连接凭据」列为**保密硬边界**。实测：

- `assertNoSecrets` 只用于 **DataGrip / DBeaver** 导出（`e2e/specs/datagrip-export.spec.ts`、`dbeaver-export.spec.ts`）
- `tests/core/preflight*.test.ts` 对 `vaultCiphertext` / `sshPassword` / `privateKey` / `passphrase` / `userPassword` / `SecretBundle` / `SHOW GRANTS` **零命中**
- Manifest 导出侧同样零断言

注意：`src-core/preflight.ts` 的 20 个导出、`manifest.ts` 的 6 个导出**都已有直测**。缺的不是「导出函数」，而是**跨序列化 + 渲染 + 写盘后仍成立的不变量**。

### 缺口 2：spec 强制要求的 E2E 不存在

`.trellis/spec/frontend/quality-guidelines.md:69` 明确要求：点 `导出 Preflight 报告` → 接原生保存框 → 校验落盘 → 解析 JSON 断言 `schemaVersion === 2` / `source === 'real'` / 正文不含凭据字段；并要求「与 review-manifest 导出断言放同一个 CDP harness run」。

实测 `e2e/specs/ui-smoke.spec.ts` 只有 3 项（DataGrip 导出 / DBeaver disabled / DBeaver 无秘密），**Preflight 与 Manifest 导出的 E2E 都不存在**。

### 关键约束：导出物是三个文件

`preflightFileNames`（`src-core/preflight.ts:305`）返回 `jsonFileName` / `markdownFileName`（结论）/ `detailMarkdownFileName`（细节）；`handleExportPreflight`（`App.tsx:2363-2370`）一次 `saveTextFiles` 写 3 份。spec 的两处交叉引用原本写「2 份」，已在本任务规划期修正（`6818043`）。

## 用户决策

- **D2**：UI 层走**真机 UI 全链路**，**零产品代码改动**（明确拒绝 env 门控的测试 seed 方案）。

## Requirements

- [ ] R1 §11.1 必须有直接断言：含凭据的输入 → Preflight 的 `serializePreflight` / `preflightToExecutiveMarkdown` / `preflightToDetailMarkdown` 三种产物 + Manifest 导出产物，全部断言不含凭据值
- [ ] R2 无秘密断言必须覆盖**值的泄漏**，不只是字段名——凭据值可能被拼进 SQL 字面量、recommendation 文本、targetAlias 等任何位置
- [ ] R3 导出物文件名契约（**3 个**文件）必须有测试锁死，且断言与 `handleExportPreflight` 实际写盘的一致
- [ ] R4 UI E2E 必须走真机完整链路：真实比较 → 运行 Preflight → 两个导出按钮，全程用真实按钮点击
- [ ] R5 UI E2E 必须在**同一次比较**后同时验证 Preflight 导出与 Manifest 导出（对齐 `frontend/quality-guidelines.md:69` 的「same CDP harness run」要求）
- [ ] R6 UI E2E 必须有 env 开关门控 + 清晰的 skip 原因（沿用 `e2e-harness.md` 既有约定）
- [ ] R7 fixture 必须在 `finally` 里清理，无残留数据库
- [ ] R8 **产品代码零改动**（D2 硬约束）
- [ ] R9 不引入新依赖
- [ ] R10 发现产品 bug 只记录、另开任务

## Acceptance Criteria

- [ ] AC1 §11.1 断言覆盖 Preflight 三种导出格式 **与** Manifest 导出
- [ ] AC2 无秘密断言经**变异测试自证非空转**（往导出链注入真实凭据值 → 断言必须变红）
- [ ] AC3 `preflightFileNames` 的 3 文件名有测试，且与 `handleExportPreflight` 写盘行为一致
- [ ] AC4 UI E2E 在真机上**真实执行而非 skip**，产出 3 个 Preflight 文件 + Manifest 文件并校验内容
- [ ] AC5 UI E2E 的 compare → preflight → export 三段链路都经真实按钮点击，不走 `page.evaluate` 旁路
- [ ] AC6 E2E 结束后两台机器 `SHOW DATABASES LIKE 'sqldiff_preflight_test%'` 为空
- [ ] AC7 `npx vitest run` 全绿且项数净增（父任务基线 748 项 + 子任务 A 增量）
- [ ] AC8 `npm run typecheck` / `lint` / `build` 全绿
- [ ] AC9 产品代码 `src-core/` `src-main/` `src-renderer/` 零改动
- [ ] AC10 `git grep -i "DB.smarterlab"` 为 0；`.env.e2e` 未入库

## Out of Scope

- **改动产品代码加测试 seed / hook**——用户已明确拒绝（D2）
- 往导出链**新增**脱敏逻辑（若发现泄漏，只记录并另开任务）
- 8.0.12–8.0.28 中间版本真机覆盖（需新机器）
- SSH 隧道真机覆盖
- UI 层 Preflight **历史对比视图**（`preflight-history.tsx`）的 E2E
- 覆盖率工具接入

## Key Decisions

- **D2 的代价写明**：真机 UI E2E 慢（~30s/项）、依赖数据库可达、**开关关闭时不执行**。这是这个选择的真实成本——回归价值取决于开关是否打开。接受。
- **无秘密断言测「值」不只测「字段名」**：字段名黑名单挡不住值泄漏（凭据被拼进 SQL 字面量或 recommendation 文本是最现实的泄漏路径）。这是 AC1 的核心。
- **单次比较满足两个导出**：`导出审查报告` 需要 `lastCompareRequest`（比较产物），`导出 Preflight 报告` 需要 `lastPreflightResult`（比较后跑的 preflight）——都来自同一次比较。这正好对上 spec 的「same harness run」要求，也让 fixture 只建一次。

## Open Questions

无。
