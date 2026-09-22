# 小增强：UNIQUE等价PK+阈值可调

## Goal

补齐数据对比二期遗留的两处保守项：有 UNIQUE 无 PK 的表可比，分页批量与阈值在 UI 可调。不改变只读、不执行原则。

## Background

- 现状（`data-pk.ts`/`data-run.ts`）：只认 `PRIMARY KEY`；有 UNIQUE 无 PK 的表一律 `skipped:'no-pk'`（check 确认属保守安全行为）。
- 现状（`data-fetch.ts`）：`batch` 默认 1000、`threshold` 默认 10 万、`insertBatch` 默认 500，后端 `dataOptions` 已可配，UI 无入口（check 遗留）。

## Requirements

- R1 UNIQUE 等价：符合资格的 UNIQUE 键可做行身份（分页+拼 key），资格规则见 Q1；不符合仍跳过并给出来由（哪列可空/哪键复合含空）。
- R2 UI 可调：数据对比面板加数字输入——分页批量（100-5000）、阈值（1万-100万，超阈仍需二次确认）、INSERT 分批（100-2000）；非法值回落默认+提示。
- R3 单测：资格判定各情形 + UI 默认值/越界回落；三件套绿。

## Acceptance Criteria

- [ ] 单列 NOT NULL UNIQUE 表可跑出行级 diff（单测+真库如有）。
- [ ] UI 改批量/阈值后生效，非法输入回落默认。
- [ ] 三件套全绿，`mysqldiff/` 零改动。

## Out of Scope

- 可空 UNIQUE 做身份；BLOB 大字段优化。

## Open Questions

- [x] Q1 UNIQUE 资格线：已定 **仅 NOT NULL**（单列或全非空复合；2026-09-23用户确认，可空唯一表仍跳过并给理由）。
