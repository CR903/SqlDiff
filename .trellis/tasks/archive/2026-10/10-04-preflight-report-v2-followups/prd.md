# Preflight Report v2 后续

## Goal

V2 渲染层（结论式双视角报告，已上线）往下落三件事：结论进结构（程序可复用）、加速建议可一键应用（减少手改 SQL）、历史可对比（看到风险收敛/恶化）。三项各自独立验收。

## Task Map

| 子任务 | 交付 | 依赖 |
|---|---|---|
| `10-04-schema-v2` | `summary` 进 `PreflightReport`，UI 改读结构 | 无，先行 |
| `10-04-sql-linkage` | 报告给加速建议 diff + 一键应用（默认不改交付物） | 宜在 schema-v2 后（消费 `summary`/inferences，可并行开发、后集成） |
| `10-04-history-diff` | preflight 历史持久化 + 独立历史视图（任意两次 diff） | 宜在 schema-v2 后（diff 用 verdict/issues，`summary` 让对比更稳） |

父任务本身无直接实现工作，只做集成复核。

## Requirements

- [ ] 三个子任务按各自 PRD 达成验收
- [ ] 实现顺序：schema-v2 先落地并归档，再启动后两项的 `task.py start`（后两项规划可并行）

## Acceptance Criteria

- [ ] 三个子任务全部 archived，且各自 AC 全绿
- [ ] 全套 vitest 不回归；`preflight.md` 规格三处更新（schema v2 / 联动 / 历史）均已写入
- [ ] 无秘密入库；JSON 旧文件可读（v1 兼容策略生效）

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
