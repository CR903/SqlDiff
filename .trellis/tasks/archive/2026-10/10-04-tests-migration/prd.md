# 测试迁移到 tests/

## Goal

把 41 个 co-located 单测文件迁入 `apps/desktop/tests/`，统一测试目录，同时保证 650 项用例零回归。

## Background（已确认事实）

- 现状：`src-core/`(18) + `src-main/`(15) + `src-main/converters/`(2) + `src-renderer/`(6) 共 41 个 `*.test.ts`，与被测源文件同目录。
- `vitest.config.ts` include 为 `['src-core/**/*.test.ts', 'src-main/**/*.test.ts', 'src-renderer/**/*.test.ts']`。
- 测试内 import 大量使用 `../src-main/xxx`、`./xxx` 两种相对形式；`src-core/vault.test.ts` 跨目录 import `../src-main/store-json` 与 `../src-main/vault`。
- `e2e/specs/*.spec.ts` 属 Playwright harness（`npm run e2e`），不在迁移范围。

## Requirements

- [x] R1 新建 `apps/desktop/tests/{core,main,converters,renderer}/`；41 文件按被测源所在目录归位，文件名不变
- [x] R2 `vitest.config.ts` include 改为 `['tests/**/*.test.ts']`；`tsconfig.json` 需保证 `tests/` 纳入类型检查（当前是否被 include 需实现时确认）
- [x] R3 所有测试内相对 import 深度 +1（`../` → `../../`），`./` → `../`；禁止改断言与 fixture 值
- [x] R4 `eslint` 配置若按路径限定 tests 目录，需同步更新

## Acceptance Criteria

- [x] AC1 `find src-core src-main src-renderer -name '*.test.ts'` 返回空
- [x] AC2 用例总数仍为 650（迁移前后一致，逐条比对文件数与 it 数）
- [x] AC3 `npx vitest run` 全绿；`npm run typecheck` / `lint` / `build` 全绿
- [x] AC4 `git diff` 中无任何断言行增删（仅 import 行与文件位置变化）

## Out of Scope

- e2e spec 迁移
- 测试内容重构、命名重写
- 新增用例（属 `10-04-test-gap-backfill`）
