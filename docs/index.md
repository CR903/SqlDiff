# 开发日志索引

唯一索引。每篇 `docs/daily/*.md` 在此占一行，按年月分表格，最近在前。

用法说明见 [`README.md`](./README.md)，日志模板见 [`template.md`](./template.md)。

## 2026-10

| 日期 | 任务 | 一句话 |
|---|---|---|
| 2026-10-05 | [contract-test-landing](./daily/2026-10-05_contract-test-landing.md) | 父任务集成复核：748 → 887 项（+139），产品代码零改动；规划期抓 5 处 spec 漂移，记录 generated DDL 未转义边界 |
| 2026-10-05 | [export-e2e-landing](./daily/2026-10-05_export-e2e-landing.md) | 补齐 §11.1 保密硬边界断言（Preflight 四产物 + Manifest，全仓首次）+ 导出按钮真机 UI E2E；终审发现 Playwright trace 不掩码密码，已默认关 trace |
| 2026-10-05 | [unit-test-gap-landing](./daily/2026-10-05_unit-test-gap-landing.md) | 补齐 9 个零直测导出（+122 项，748→870）：`escapeDataIdent` 注入防线、两个反序列化守卫判别矩阵；产品代码零改动。顺带发现生成的 ALTER 语句未转义（已知边界，不从不执行） |
| 2026-10-05 | [e2e-env-readiness](./daily/2026-10-05_e2e-env-readiness.md) | preflight 真机 E2E 环境就绪：5.7 建 `sqldiff@%` 远程账号、dotenv 自动加载 `.env.e2e`、spec 去写死 IP、8.x 单机化；真机 5.7.44 + 8.0.46 四项全过 |
| 2026-10-05 | [docs-spec-drift-cleanup](./daily/2026-10-05_docs-spec-drift-cleanup.md) | 清理 spec 里 9 处不存在的 `mysqldiff/` 引用；`docs/` 移出 `.gitignore`，建立四件套让 AGENTS.md 门禁可执行 |

## 2026-09

暂无（此前任务只记 `.trellis/workspace/*/journal-*.md`，按 R9 不追溯补写）

## 其他文档

| 文件 | 内容 |
|---|---|
| [plan.md](./plan.md) | 产品规划 |
| [README.md](./README.md) | docs 使用指南与门禁说明 |
| [template.md](./template.md) | 任务日志模板 |
| [knowledge/index.md](./knowledge/index.md) | 可复用知识沉淀 |
