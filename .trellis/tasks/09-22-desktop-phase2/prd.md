# 桌面版二期增强（父任务）

## Goal

落地首版 Out of Scope 中排期靠前的三项：客户端兼容转换器、小增强合集、全面深度测试。

## Task Map（顺序执行，验收独立）

1. `09-22-converters` — DBeaver/DataGrip 兼容转换器（先做，可独立闭环）。
2. `09-22-small-enhance` — UNIQUE 等价 PK + 分页阈值/batch UI 可调（先做，可独立闭环；与1无依赖，可并行，顺序做）。
3. `09-22-deep-e2e` — 全面深度测试含 e2e（后做，依赖1+2完成）。

## Cross-child Acceptance

- 三子任务全部 `in_progress→archive` 且三件套绿，即父任务可归档。
- `mysqldiff/` 全程零改动；凭证不落库。
