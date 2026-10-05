# docs/ 使用指南

根 `docs/` 是**开发日志的唯一归集地**。所有任务的开发日志都落在这里，不散落在 `.trellis/tasks/` 或对话里。

## 四件套

| 文件 | 职责 | 谁能改 |
|---|---|---|
| `daily/` | 每个 Trellis 任务一篇日志，任务产物 | 任务执行者 |
| `index.md` | **唯一索引**，按年月分表格，每篇日志一行 | 任务执行者（新增日志时同步加行） |
| `README.md` | 本文件：用法、命名、检索、门禁含义 | 少改 |
| `template.md` | 任务日志模板，复制即用 | 少改 |

`docs/` 下与 `daily/`、`index.md` 并列的还有：

- `plan.md` 产品规划
- `knowledge/<端>/<分类>/` 可复用知识沉淀（见 [P2 沉淀门禁](#p2-沉淀门禁)），**已建立**
- `domain context/`、`agents/` 按需创建，**当前不存在**，不算漂移

## 命名规则

按 **Trellis 任务一任务一日志**：

```text
docs/daily/YYYY-MM-DD_<slug>.md
```

- `<slug>` 与 `.trellis/tasks/<slug>/` 的目录名**完全一致**，kebab-case
- 例：`docs/daily/2026-10-05_docs-spec-drift-cleanup.md` 对应 `.trellis/tasks/10-05-docs-spec-drift-cleanup/`
- 历史按日日志（2026-04~05）保留原名，不重命名

**一任务一篇。** 不要为同一任务拆第二篇——那会让 `docs/index.md` 无从指向"唯一那篇"。确需补充时追加到原文件，而不是新建。

## 检索

```bash
grep -rn "关键词" docs/daily/        # 按内容找
grep -n "2026-10" docs/index.md      # 按月份定位
ls docs/daily/                       # 全部日志
```

## 门禁含义

### 归档门禁（硬性）

`task.py archive` / `/trellis:finish-work` 之前**必须**同时完成：

1. `docs/daily/YYYY-MM-DD_<slug>.md` 已写
2. `docs/index.md` 对应年月表格已追加一行

否则视为**未完成**，不允许 archive。

### P2 沉淀门禁（`trellis-check` 必检）

日志里出现"坑位"或"通用解法"时，说明内容可能值得沉淀成可复用知识。对照
[`docs/knowledge/common/best-practices/daily-to-knowledge.md`](./knowledge/common/best-practices/daily-to-knowledge.md) 的 P2 三问判断：

- 命中 → 写入 `docs/knowledge/<端>/<分类>/<file>.md`，并更新该目录与上两级 `index.md`
- 未命中 → 日志的「可沉淀知识」勾选"无需沉淀"并写明理由

**日志含坑位/通用解法但 knowledge 未更新 → 拦截 archive。**

## 与 journal 的区别

两套东西定位不同，**不合并**：

| | `docs/daily/` | `.trellis/workspace/*/journal-*.md` |
|---|---|---|
| 内容 | 任务产物：做了什么、为什么、坑 | 会话流水：过程记录 |
| 粒度 | 一任务一篇 | 一会话一篇，可多篇 |
| 是否门禁 | 是 | 否 |
| 检索价值 | 高（按任务查） | 低（按时间查） |

任务收尾时任务产物进 `docs/daily/`，会话流水照常留在 journal。

## 约束

- `docs/` 已在版本控制内（`.gitignore` 不再忽略它）
- `docs/` 下**不得出现真实凭据**：主机名、密码、私钥一律用 `fake-*` 占位
- 历史任务不追溯补写日志
