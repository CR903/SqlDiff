# implement.md — 历史对比

## 有序检查表

1. `src-core`：`diffPreflight` 纯函数 + 单测（新增/消失/等级变化/verdict 翻转四种）
2. `src-main/store-json.ts`：`preflight-history.json` 读写 + 分组滚动（每组 10）+ 单测
3. `preflight-run.ts`：成功后 append（失败/取消不写）
4. IPC：history list/get（参照现有 preflight IPC 模式）
5. UI：独立历史视图（分组列表 → 选两次 → diff 展示；跨组禁用）
6. `preflight.md`：追加历史章节
7. 全量验证：`vitest` + `typecheck` + `lint` + `build`

## 验证命令

```bash
cd apps/desktop && npx vitest run && npm run typecheck && npm run lint && npm run build
```

## 高风险文件/回滚点

- `preflight-run.ts`：append 失败不能影响主流程（try/catch 隔离，有日志无 throw）。
- UI 新视图：独立路由/面板，不动现有 preflight 面板逻辑。
- 回滚：删历史文件 + revert 代码，无数据迁移负担。

## start 前检查

- [ ] `implement.jsonl` / `check.jsonl` 有真实条目
- [ ] schema-v2 已归档（diff 消费 summary；可并行开发、后集成）
- [ ] 最终规划 summary 已向用户展示并获批
