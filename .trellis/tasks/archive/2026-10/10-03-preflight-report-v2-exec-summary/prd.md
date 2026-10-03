# Preflight Report v2：结论式渲染（双视角 + 分层文件）

## 背景

当前 `preflightToMarkdown` 输出 213 行报告，实测 83% 篇幅（165 行）是原始 facts（key/value/source/observedAt 平铺），verdict 与 issues 埋在最底部。用户反馈：

> 「含金量不高，都是细节的东西，没有总结概括的东西，导致需要花费很多时间去逐行查看细节」

问题定位（基于真实 8.0.46 报告 dump 分析）：
1. **Facts 平铺**：6 类事实按 category 分组但每类仍是原始键值对，读者需自己推理
2. **Inferences 平铺**：10 条 DDL 矩阵判定一行一条，未按风险分组
3. **Verdict 在最底部**：`Level: warn / Blocking: 0 / Warnings: 1 / Unknowns: 2` 是计数不是结论
4. **只有一种视角**：没有区分「写 DDL 的人」与「执行 DDL 的人」两种角色

## 范围

### 必须做

- [ ] **双视角渲染**：`preflightToMarkdown` 输出拆成两个文件
  - `report.md` — 结论式摘要（首屏可读）
  - `report-detail.md` — 原始完整数据（可追溯）
- [ ] **开发视角（Developer View）**：DDL 作者关心「我写的东西对不对」
  - DDL 分类成功率（成功分类 N / 落入 OTHER 类 N）
  - Unparsed DDL 清单（无法识别语法的 DDL，附原因）
  - 表结构隐患（无 PK / 无索引 / 缺 UNIQUE 的表，与 DDL 无关但影响后续变更）
  - DdlOp 分布（17 种 DdlOp 各占几条）
- [ ] **运维视角（Ops View）**：执行方关心「执行这段 DDL 会发生什么」
  - 一句话决策语（GO / DEGRADED / BLOCK）+ 依据
  - DDL 按锁/重建风险三档分组（INSTANT / INPLACE SHARED / INPLACE EXCLUSIVE）
  - 表风险热图（行数、大小、PK、涉及 DDL 数、综合风险标记）
  - 环境问题（read_only / replica_lag / gtid_mode / permission 的 block 与 warn 项）
  - 建议执行窗口（低峰 / 可立即 / 需等待）
- [ ] **文件命名**：`sqldiff-preflight-{ts}.md`（结论）+ `sqldiff-preflight-{ts}-detail.md`（细节），JSON 文件名不变
- [ ] **UI/IPC 联动**：`PreflightExportResult` 返回两个 markdown 文件名与内容（`markdownFileName` → `markdownFileName` + `detailMarkdownFileName`）
- [ ] **单元测试**：新渲染函数覆盖开发/运维两个视角的分支（block / warn / pass / unknown 场景）
- [ ] **回归**：558 项单元测试不回归；JSON schema 与字节稳定性不变
- [ ] **规格文档**：更新 `.trellis/spec/backend/preflight.md` § 追加「v2 结论式渲染」章节

### 明确不做

- [ ] **不改 schema v1**：`PreflightReport` 类型、`PreflightFact/Inference/Unknown/Issue` 结构、JSON 序列化保持 byte 稳定。渲染层先行，用户满意后再评估 schema v2
- [ ] **不改 UI**：本轮只改 Markdown 渲染层，UI 徽标 / 展示层留待后续任务
- [ ] **不引入新依赖**：仍用 `preflight.ts` 单文件纯函数
- [ ] **不做本地化**：Markdown 中文文案沿用现有风格

## 验收标准

- [ ] `report.md` 首屏（前 40 行内）包含：
  - 一句话决策（GO / DEGRADED / BLOCK 三态 + 依据）
  - 开发视角结论区
  - 运维视角结论区
- [ ] `report-detail.md` 保留完整的 Facts / Inferences / Unknowns / Issues / Verdict 五段
- [ ] 两个文件互相有导航链接（`report.md` 底部有 `→ [完整原始数据](./xxx-detail.md)`；`report-detail.md` 顶部有 `← [返回结论](./xxx.md)`）
- [ ] 开发视角至少含 3 个维度：DDL 分类成功率、unparsed 清单、表结构隐患
- [ ] 运维视角至少含 4 个维度：决策语、DDL 风险分组、表热图、环境问题
- [ ] 决策语三态语义：
  - **BLOCK**：有 severity=block 的 issue，不能发
  - **DEGRADED**：无 block 但有 INPLACE EXCLUSIVE 或严重 warn，需排期
  - **GO**：无 block、无 INPLACE EXCLUSIVE、无严重 warn，可发
- [ ] 单元测试新增 ≥ 6 项（覆盖两个视角 × 三态决策）
- [ ] 558 项原测试不回归，typecheck/lint 全绿
- [ ] JSON 序列化 byte 稳定性不回归（schemaVersion、字段顺序、序列化格式不变）
- [ ] 真实 8.0.46 + 8.0.26 e2e 跑通，dump 报告可对比阅读

## 约束

- 渲染函数保持纯函数（不引入 IO / 日期 / 随机）
- Markdown 单元格内 `|` 转义沿用 `mdCell`
- 数字格式化：行数（M / K / 原值）、大小（GB / MB / KB）
- 两个 markdown 文件共用 checkedAt 时间戳，命名前缀一致便于成对查找
- 若渲染时数据缺失（如无 inferences）需优雅降级，不抛错

## Key Decisions

| # | 决策 | 依据 |
|---|---|---|
| 1 | 渲染层先行，不动 schema v1 | 用户明确「先出 PoC，不合适再调整数据结构层」。schema 变更会打破 UI/单测/e2e 三处契约 |
| 2 | 两个 md 文件而非一个折叠 | 用户选方案 C：`report.md`（结论）+ `report-detail.md`（细节）。用户明确「先看结论，有疑问和根据细节追溯具体原因」——物理分离比 `<details>` 折叠更符合「按需加载」心智 |
| 3 | 双视角分开而非混合 | 用户明确「能分两种场景来分开看吗，不同人视角不一样」。开发者写 DDL 关心语法正确性，运维执行关心锁和影响，两者关注点完全不同 |
| 4 | 决策语三态（GO/DEGRADED/BLOCK） | 现有 verdict.level 是 pass/warn/block/unknown 四态，但 unknown 单独一档在 Markdown 里意义不大（多数是 not-applicable 噪声）。合并为「有 block → BLOCK / 无 block 但有严重 warn 或 INPLACE EXCLUSIVE → DEGRADED / 其余 → GO」更贴合运维决策 |
| 5 | 保留 JSON 与详情文件 | 结论文件是给人看的，JSON 是给程序读的，detail md 是给怀疑结论的人追溯的。三层信息各归其位，不重复也不缺失 |

## Follow-up（不在本任务）

- UI 层同步：verdict 徽标从「pass/warn/block/unknown」升级为「GO/DEGRADED/BLOCK」三态
- Schema v2 评估：若结论层字段被 UI / 程序复用，再考虑引入 `summary` 字段进 PreflightReport
- SQL 生成联动：`ALGORITHM=INSTANT` 等加速建议目前只在 recommendation 文本里，未来可自动追加到生成的 DDL 语句中
- 历史对比：多次 preflight 结果 diff（如「本次比上次新增 2 条 warn」）

## 参考

- 现有：`.trellis/spec/backend/preflight.md`（v1 契约）
- 前置任务：`.trellis/tasks/archive/2026-10/10-03-production-preflight/`（v1 完整实现）
- 前置任务：`.trellis/tasks/archive/2026-10/10-03-preflight-e2e-mysql-8/`（真实 MySQL e2e）
- 现有渲染：`apps/desktop/src-core/preflight.ts:167-283`（preflightToMarkdown）
