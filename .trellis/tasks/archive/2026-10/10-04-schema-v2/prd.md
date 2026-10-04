# Schema v2：结论进结构

## Goal

`PreflightReport` 引入 `summary` 字段，把当前只存在于 Markdown 里的结论（GO/DEGRADED/BLOCK + 一句话依据）沉进 JSON 结构，让 UI 与程序（以及未来的 JEV 输入契约）直接复用，不再各自调 `deriveDecision` 重算。

## Background（已确认事实）

- V2 渲染层已上线：`deriveDecision(m): { level: 'GO'|'DEGRADED'|'BLOCK'; message: string }` 是纯函数，每次由调用方实时计算，不存进报告（见 `.trellis/spec/backend/preflight.md` §14）。
- 触发条件已满足：spec 原话"若结论层字段被 UI / 程序复用，再考虑引入 summary"——UI 徽标三态同步（commit `04c529f`）已在 UI 层复用 decision，重复计算真实存在。
- 当前结构（`apps/desktop/src-core/preflight-types.ts:100-117`）：`verdict: { level: 'pass'|'warn'|'block'|'unknown'; blocking; warnings; unknowns }`，四态计数；JSON 要求 byte 稳定序列化（字段顺序即声明顺序）。
- 实现顺序依赖：SQL 联动与历史 diff 都可能消费 `summary`，schema-v2 宜先行。

## Requirements

- [ ] R1 `PreflightReport` 新增 `summary` 字段：`{ decision: 'GO'|'DEGRADED'|'BLOCK'; message: string; blocking: number; warnings: number; unknowns: number }`（Q1 已定：只存 decision，不存双视角全文）
- [ ] R2 `summary` 由现有 `deriveDecision` 在报告生成时一次算出并写入，不再由各调用方重复计算；UI 徽标改从 `summary` 读取
- [ ] R3 双视角全文仍只活在 md 文件里，JSON 保持轻量
- [ ] R4 版本与兼容：`schemaVersion` 1→2；旧 v1 文件读取时 `getSummary` 按需回填（设计已确认，无强制重跑）
- [ ] R5 全套单测 + JSON 序列化测试更新；`preflight.md` 规格追加 schema v2 章节

## Acceptance Criteria

- [ ] AC1 报告 JSON 含 `summary { decision, message, blocking, warnings, unknowns }`，`schemaVersion = 2`
- [ ] AC2 UI 徽标改从 `summary` 读取，不再调 `deriveDecision`（`App.tsx:681,685`）
- [ ] AC3 旧 v1 文件可读：缺 `summary` 时按需 `deriveDecision` 回填，无报错、无强制重跑
- [ ] AC4 全套 vitest 不回归（含更新后的序列化快照）；`preflight.md` 追加 schema v2 章节
- [ ] AC5 `verdict` 四态字段保留（计数来源），渲染层双视角全文仍只活在 md 里

## Key Decisions

- Q1 已定：`summary` 只存 decision（+ 计数快照），双视角全文不进 JSON。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
