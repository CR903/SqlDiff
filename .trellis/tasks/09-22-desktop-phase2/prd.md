# 桌面版二期增强（父任务）

## Goal

落地首版 Out of Scope 中排期靠前、现在具备交付条件的三项：DBeaver 兼容导出、小增强合集、全面深度测试。DataGrip 兼容导出因缺真实 fixture 拆为独立后续任务，不阻塞本父任务收口。

## Task Map（按验收独立）

1. `09-22-converters` — DBeaver 兼容节点导出（当前执行；DataGrip 已拆分）。
2. `09-22-small-enhance` — UNIQUE 等价 PK + 分页阈值/batch UI 可调（已归档）。
3. `09-22-deep-e2e` — 全面深度测试含 e2e（已由 `09-24-e2e-icon-release` 接管并归档）。
4. `09-22-ddl-dml-index` — DDL/DML/INDEX 过滤增强（已归档）。

独立后续：`09-24-datagrip-converter`，等待真实 DataGrip XML fixture。

## Cross-child Acceptance

- 本父任务直接负责的 4 个子任务均已 `in_progress→archive`，且对应验证门禁通过。
- DBeaver 导出必须保持拓扑-only、无秘密、无 `mysqldiff/` 改动；DataGrip 后续任务不计入本父任务的完成条件。
- 父任务归档前运行一次全量 typecheck/lint/test/build 或记录明确豁免。
