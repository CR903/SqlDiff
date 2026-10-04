# implement.md — SQL 生成联动

## 有序检查表

1. `preflight.ts`：新增 `deriveSuggestedEdits` 纯函数 + 单测（命中/未命中/归一化三种）
2. executive 渲染：新增"可应用的加速建议"一节 + 单测
3. UI：预览 diff → 确认应用 → 可撤销（交互细节实现时对照 App 现有导出链路）
4. `preflight.md`：追加联动章节
5. 全量验证：`vitest` + `typecheck` + `lint` + `build`

## 验证命令

```bash
cd apps/desktop && npx vitest run && npm run typecheck && npm run lint && npm run build
```

## 高风险文件/回滚点

- 待导出 DDL 文本链路：先读后改，应用动作必须可预览、可撤销；默认关闭。
- 归一化匹配：宁可漏建议，不可错改写；匹配失败走静默丢弃 + unknown。

## start 前检查

- [ ] `implement.jsonl` / `check.jsonl` 有真实条目
- [ ] schema-v2 已归档（消费其结构；可并行开发、后集成）
- [ ] 最终规划 summary 已向用户展示并获批
