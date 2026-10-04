# 多次 preflight 历史对比

## Goal

多次 preflight 结果可对比（如"本次比上次新增 2 条 warn"），让用户看到风险是收敛了还是恶化了，而不是每次只看孤立的一份报告。

## Background（已确认事实）

- 现状：preflight 结果只活在内存（`store.ts:191` 的 `lastPreflightResult`），切一次页面/重启就没了；compare 历史有 `history.json`（最近 20 条摘要：时间 + A/B 别名 + 差异数，`types.ts:113-122`），preflight 无任何持久化。
- 对比维度天然存在：`verdict` 三态/计数 + `issues[]`（有稳定 id，如 `LARGE_TABLE_INSTANT_ADD:diff-item:d01`）+ `inferences[]`，diff 可精确到"新增/消失/等级变化"三类。
- 同库约束：只有同一目标库（同 bId + database）的前后两次才有可比性，跨库对比无意义。

## Requirements

- [ ] R1 每次 preflight 跑完即持久化一份完整报告（仅同库可比：按 bId + database 分组，Q3 已定：独立历史视图，可选任意两次对比）
- [ ] R2 独立历史视图：选同一目标库的任意两次报告，对比 `verdict` 变化 + issues 新增/消失/等级变化三类
- [ ] R3 保留上限（默认最近 10 份完整报告，超出滚动淘汰；compare 历史是 20 条摘要，preflight 报告体量大故取小）
- [ ] R4 无秘密入库：沿用现有无秘密边界（node secret、密码不进历史文件）

## Acceptance Criteria

- [ ] AC1 每次 preflight 成功即存一份完整报告到 `preflight-history.json`（按 bId + database 分组，每组最近 10 份滚动）
- [ ] AC2 独立历史视图：选同一目标库任意两次，展示 verdict 变化 + issues 新增/消失/等级变化
- [ ] AC3 无秘密入库（node secret、密码不进历史文件，check 逐项扫描）
- [ ] AC4 全套 vitest 不回归；`preflight.md` 追加历史章节

## Key Decisions

- Q3 已定：独立历史视图（任意两次对比），接受新 UI + 新存储的 scope；保留上限默认每组 10 份。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
