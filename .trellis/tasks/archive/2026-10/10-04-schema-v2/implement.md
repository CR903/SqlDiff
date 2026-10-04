# implement.md — Schema v2

## 有序检查表

1. `preflight-types.ts`：`summary` 字段 + `PREFLIGHT_REPORT_VERSION = 2`
2. `preflight.ts`：装配处写入 `summary`；新增 `getSummary` 回填函数并导出
3. `App.tsx`：徽标改读 `getSummary`（约 `:681,685` 两处 `deriveDecision` 调用）
4. 单测：新增 summary 写入断言 + v1 缺字段回填测试；更新序列化快照
5. `preflight.md`：追加 §15 schema v2 章节（字段、版本、兼容策略）
6. 全量验证：`vitest` + `typecheck` + `lint` + `build`

## 验证命令

```bash
cd apps/desktop && npx vitest run && npm run typecheck && npm run lint && npm run build
```

## 高风险文件/回滚点

- `preflight-types.ts`：类型改动牵全链，改完先跑单测再动 UI。
- 序列化快照：大面积更新属预期，逐项确认是"多了 summary"而非数据丢失。
- 回滚：一 revert 即回 v1；`getSummary` 可独立保留。

## start 前检查

- [ ] `implement.jsonl` / `check.jsonl` 有真实条目（见配额门禁）
- [ ] 最终规划 summary 已向用户展示并获批
