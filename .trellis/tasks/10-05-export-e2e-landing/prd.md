# 补 Preflight/Manifest 导出 CDP E2E

## Goal

spec 明确要求但 e2e/ 里不存在：点导出 Preflight 报告 → 接原生保存框 → 校验 json+md 落盘 → 断言 schemaVersion===2 / source==='real' / 无凭据字段；并与 Manifest 导出断言同 harness run

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
