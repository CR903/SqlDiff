# YYYY-MM-DD <task-slug>

> 复制本文件到 `docs/daily/YYYY-MM-DD_<task-slug>.md`，逐节填写，不要留占位符。
> 命名：`<task-slug>` 必须与 `.trellis/tasks/<slug>/` 的目录名一致（kebab-case）。
> 本任务日志需在 `docs/index.md` 对应年月表格追加一行。

- **Trellis 任务**：`.trellis/tasks/<task-slug>/`
- **日期**：YYYY-MM-DD
- **类型**：feature / fix / refactor / docs / chore

## 做了什么

3–5 条bullet，每条一句话说清"改了/删了/建了什么"，不要写"优化了体验"这种无法验证的表述。

## 为什么这么做

问题陈述 + 根因。要说清"不这么做会怎样"，而不是复述需求。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `path/to/file.ts` | 新建 / 修改（一句说清改了什么） |

## 踩到的坑

- **坑位**：现象是什么。
  **根因**：为什么。
  **通用解法**：下次怎么避免。
  （无坑则写"本任务未遇到坑"）

## 可沉淀知识

- [ ] 无需沉淀
- [ ] 有 → 已写入 `docs/knowledge/<端>/<分类>/<file>.md`，并更新该目录与上两级 `index.md`

对照 `docs/knowledge/common/best-practices/daily-to-knowledge.md` 的 P2 三问判断。

## 遗留 / 后续

- [ ] 本任务范围内必须做的（若为空写"无"）
- [ ] 明确不在本次范围、留给后续任务的

## 验证

列出实际跑过的命令与结果，不写"已验证"这种空话。

```text
npm run typecheck
npm run lint
npm test
```
