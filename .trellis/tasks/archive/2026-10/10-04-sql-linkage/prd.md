# SQL 生成联动

## Goal

preflight 的加速建议（如 `ALGORITHM=INSTANT`）不再只躺在 recommendation 文案里，而是能作用到实际交付的 DDL 上，减少用户手动改 SQL 的步骤与出错。

## Background（已确认事实）

- 现状：`ALGORITHM=INSTANT` 只存在于两处文案——`preflight-rules.ts:293` 的 `recommendation` 字段、 executive markdown 的 bullets（`preflight.ts:840`）；导出的 DDL 本体不受影响。
- DDL 文本生成侧：`classify.ts` / `preflight-ddl.ts` / `diff.ts` / `manifest.ts`（待细读确认导出链路）。
- 风险面：自动改写用户 DDL 是高风险动作——INSTANT 并非所有场景可用（v1 是乐观推断，未校验 DEFAULT 子句，见 spec §8），改错会导致线上执行失败。

## Requirements

- [ ] R1 报告里对每条可加速 DDL 给出"建议 diff"（加什么子句、为什么、依据哪条规则），展示层先行（Q2 已定：建议+一键应用，不直接改交付物）
- [ ] R2 用户可一键把建议应用到待导出的 DDL：预览 diff → 用户确认 → 作用到文本，可撤销（设计已确认交互形态）
- [ ] R3 仅处理 preflight 已有明确规则覆盖的加速项（首批 `ALGORITHM=INSTANT`）；规则未覆盖的不给建议、不猜
- [ ] R4 导出的 DDL 文件本体默认不变；应用建议是显式用户动作

## Acceptance Criteria

- [ ] AC1 executive 报告新增"可应用的加速建议"一节：每条写清规则 id、加什么子句、为什么；仅限规则明确覆盖项（首批 `ALGORITHM=INSTANT`），不覆盖不猜
- [ ] AC2 UI 有"应用加速建议"动作：预览 diff → 用户确认 → 作用到待导出 DDL；可撤销，默认不改交付物
- [ ] AC3 全套 vitest 不回归；`preflight.md` 追加联动章节
- [ ] AC4 建议是纯函数派生（`deriveSuggestedEdits`），不进 schema、不改规则引擎

## Key Decisions

- Q2 已定：建议+一键应用，不直接改交付物（v1 乐观推断有误判风险，自动改写 DDL 不可接受）。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
