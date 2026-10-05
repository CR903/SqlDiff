# 测试补齐：迁入 tests/ + 补历史功能缺口

## Goal

两条并行交付：①把全部单测从 co-located（`src-core/*.test.ts` 等）迁入 `apps/desktop/tests/` 统一目录；②给历史上所有功能点与优化点补齐缺失的测试用例（当前零覆盖/弱覆盖模块）。

## Task Map

| 子任务 | 交付 | 依赖 |
|---|---|---|
| `10-04-tests-migration` | 41 个 `*.test.ts` 迁入 `tests/`，改 `vitest.config.ts` include 与所有相对 import，650 项零回归 | 先行 |
| `10-04-test-gap-backfill` | 补齐零覆盖模块的测试（见 Background 缺口清单） | 依赖迁移完成（避免 import 路径双写） |

父任务无直接实现工作，只做集成复核 + 沉淀「测试目录与命名规则」到 spec。

## Requirements

- [ ] R1 全部单测位于 `apps/desktop/tests/`，`vitest.config.ts` include 指向该目录
- [ ] R2 迁移只改文件位置与 import 路径，**不改任何断言逻辑**；650 项全绿用例数量不减
- [ ] R3 补齐清单中所有零覆盖函数，每函数至少 2 项用例（正常 + 边界/异常）
- [ ] R4 补测不修改产品代码（纯测试任务）；若补测过程中发现产品 bug，只记录、另开任务
- [ ] R5 无秘密入库：测试夹具中的凭据一律用假值

## Acceptance Criteria

- [ ] AC1 `tests/` 下无 co-located 残留（`src-*/**.test.ts` 数量为 0）
- [ ] AC2 用例总数 ≥ 650 + 新增数，且无一条原有断言被弱化或删除
- [ ] AC3 缺口清单每项均有对应测试文件，`npx vitest run` 全绿
- [ ] AC4 `npm run typecheck` / `lint` / `build` 全绿
- [ ] AC5 测试目录与命名规则写入 `.trellis/spec/backend/quality-guidelines.md`

## Key Decisions

- 目录结构：全部迁入 `tests/`，按被测模块分二级子目录（见 design.md）
- `e2e/specs/*.spec.ts` 不属本次范围（Playwright harness，独立生命周期）
- 补测范围：以代码面扫描出的零覆盖函数为客观依据，不按任务历史逐条追认

## Risks

- 迁移面 41 文件、import 路径全变，回归风险集中在 typecheck 与 vitest include 路径
- 补测过程中可能暴露真实产品 bug：按 R4 只记录不改

## Open Questions

无。
