# implement.md — 测试补齐总执行计划

## 顺序

1. **`10-04-tests-migration` 先做**（`task.py start` + dispatch `trellis-implement`）
   - 建 `tests/{core,main,converters,renderer}/`
   - `git mv` 41 个测试文件，逐个修正 import 深度
   - 改 `vitest.config.ts` include 为 `['tests/**/*.test.ts']`
   - 检查 `tsconfig.json` / `tsconfig.main.json` 的 include 是否覆盖 `tests/`
   - 跑 `npx vitest run` 确认 650 项不变

2. **`10-04-test-gap-backfill` 后做**（依赖第 1 步的目录结构）
   - 按 design.md 清单新建 7 个测试文件
   - 补 40 项左右用例
   - 验证 grep 计数全部 ≥ 2

3. **父任务集成复核 + spec 沉淀**
   - `.trellis/spec/backend/quality-guidelines.md` 追加「测试目录与命名规则」章节
   - 归档三任务 + journal

## 验证命令

```bash
cd apps/desktop
npx vitest run
npm run typecheck
npm run lint
npm run build
find src-core src-main src-renderer -name '*.test.ts'   # 期望空
```

## 高风险点与回滚

- 迁移 import 路径：`src-core/vault.test.ts` 跨目录引用 `src-main`，是最易错的一条，迁移后立即单跑该文件
- `preflight-run.test.ts` 含 `vi.mock('./store-json')` 相对路径 mock，迁移后 mock 目标路径需同步
- 任一步 vitest 不绿就停下排查，不要继续叠加改动

## start 前检查

- [ ] 三个任务的 `implement.jsonl` / `check.jsonl` 已填真实条目
- [ ] 用户已批准规划 summary
