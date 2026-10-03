# Implementation Plan：Preflight Report v2 结论式渲染

## 阶段 1：数据工具层（无外部依赖，最先落地）

- [ ] 在 `apps/desktop/src-core/preflight.ts` 顶部新增内部工具：
  - `parseInferenceStatement(s: string): InferenceStatement` —— 从 `d01: ADD_COLUMN on users_big → INSTANT/SHARED` 解析出 `{op, tableName, algorithm, lockMode, rebuilds}`
  - `fmtRows(n: number | null): string` —— `891 K` / `1.2 M` / `0`
  - `fmtSize(bytes: number | null): string` —— `16 KB` / `46.7 MB` / `1.2 GB`
  - `deriveDecision(m: PreflightReport): Decision` —— 三态决策语
  - `groupDdlByRisk(inferences): {exclusive, inplaceShared, instant}` —— 按锁/重建分组
  - `buildTableHeatmap(facts, inferences): TableRow[]` —— 表级聚合
  - `buildDeveloperView(m): {...}` —— 开发视角装配
  - `buildOpsView(m): {...}` —— 运维视角装配
- [ ] 内部类型 `InferenceStatement`、`Decision`、`TableRow`、`DeveloperView`、`OpsView` 定义在 preflight.ts 内部（`export interface` 供测试引用）
- [ ] 校验点：写 3 条最小单测覆盖 `parseInferenceStatement` 三种典型 statement（INSTANT/SHARED、INPLACE/EXCLUSIVE、INPLACE/SHARED (rebuild)），跑通后进下一步

## 阶段 2：结论 Markdown 渲染

- [ ] 新增 `preflightToExecutiveMarkdown(m: PreflightReport): string`
- [ ] 结构：
  - `# Preflight Executive Summary`
  - `## 决策 · {GO|DEGRADED|BLOCK}` + 一句话依据
  - 元数据行（目标 / 版本 / 时间）
  - `## 开发视角` → 分类成功率、DdlOp 分布、unparsed 表、表结构隐患
  - `## 运维视角` → 建议动作、DDL 风险分组、表热图、环境状态
  - `## 详情` → 底部链接到 detail 文件（`./xxx-detail.md`，文件名由 `preflightFileNames` 提供）
- [ ] 复用现有 `mdCell` / `mdValue` 处理表格转义与 null 值
- [ ] 校验点：手动跑一次现有 dump 报告，肉眼检查输出结构

## 阶段 3：细节 Markdown 渲染

- [ ] 新增 `preflightToDetailMarkdown(m: PreflightReport): string`
- [ ] 结构：沿用旧 `preflightToMarkdown` 输出，仅改：
  - 标题从 `# Preflight Report` → `# Preflight Detail Report`
  - 顶部加 `← [返回结论](./xxx.md)` 链接
  - 其他 5 段（Facts/Inferences/Unknowns/Issues/Verdict）原样保留
- [ ] 删除旧 `preflightToMarkdown` 前的检查：确认无调用点（除单测外），或明确标记为 legacy 保留
- [ ] 校验点：dump 报告对比新旧细节输出，确认内容一致

## 阶段 4：API 扩展与主流程装配

- [ ] 扩展 `PreflightFileNames` 接口：新增 `detailMarkdownFileName`
- [ ] 修改 `preflightFileNames(checkedAt)` 生成第三个文件名 `sqldiff-preflight-{ts}-detail.md`
- [ ] 扩展 `PreflightExportResult` 接口：新增 `detailMarkdownFileName` + `detailMarkdownContent`（可选字段，保持向后兼容）
- [ ] 修改 `preflight-run.ts` 中 `exportBundle()`：调用两个新渲染函数，装配两个 markdown 字段
- [ ] 修改 `apps/desktop/src-renderer/App.tsx:2228-2245` 的 `handleExportPreflight`：
  - import 从 `preflightToMarkdown` 换成 `preflightToExecutiveMarkdown` + `preflightToDetailMarkdown`
  - `saveTextFiles` 数组从 2 项 → 3 项（json + exec md + detail md）
  - toast 文案更新为「JSON + 结论 Markdown + 详细 Markdown」
- [ ] 检查 `PreflightExportResult` 消费方（IPC 端）：确认新字段不 break 显示
- [ ] 校验点：`npm run typecheck` 通过；旧单测不 fail

## 阶段 5：单元测试

- [ ] 新建 `apps/desktop/src-core/preflight-exec.test.ts`
- [ ] 10 项测试用例（见 design.md §10 表格）
- [ ] 每项测试构造最小 `PreflightReport` 对象（不依赖真实 MySQL）
- [ ] 断言要点：决策语、分组数量、表格行数、交叉引用链接、优雅降级
- [ ] 校验点：`npm test` 全绿；新增测试 ≥ 10 项；原 558 项不回归

## 阶段 6：真实 e2e 验证

- [ ] 复用 `10-03-preflight-e2e-mysql-8` 已建立的 harness
- [ ] 在 8.0.46 与 8.0.26 两台机器上跑 preflight，dump 三个文件（json + md + detail.md）
- [ ] 人工对比：
  - `report.md` 首屏（前 40 行）包含决策语 + 开发视角 + 运维视角
  - `report-detail.md` 保留完整 5 段结构
  - 两个文件互相有导航链接
  - 结论内容与 JSON 数据一致（如 issues 数量、inferences 分组）
- [ ] 校验点：e2e 3/3 通过，dump 文件对比 OK

## 阶段 7：规格文档更新

- [ ] 在 `.trellis/spec/backend/preflight.md` 末尾追加 §9 章节：「v2 结论式渲染」
- [ ] 内容：三态决策定义、双视角信息映射、文件名约定、扩展字段列表
- [ ] 校验点：文档可读，与实现一致

## 阶段 8：全量验证

- [ ] `npm run typecheck` 全绿
- [ ] `npm run lint` 全绿
- [ ] `npm test` 全绿（原 558 + 新增 ≥10）
- [ ] `E2E_RUN_PREFLIGHT_MYSQL=1 npm run e2e` 在双机上跑通
- [ ] `git diff -- apps/desktop/src-core/ apps/desktop/src-main/` 检查改动范围（应仅涉及 preflight.ts / preflight-run.ts / preflight.test.ts / preflight-exec.test.ts / main.ts / save-file.ts）

## 验证命令

```bash
cd apps/desktop
npm run typecheck
npm run lint
npm test

# e2e（需要环境变量）
E2E_RUN_PREFLIGHT_MYSQL=1 \
E2E_MYSQL_9_PASSWORD='<pw9>' \
E2E_MYSQL_15_PASSWORD='<pw15>' \
npm run e2e:preflight:mysql

# 手动 dump 报告验证
node /tmp/verify-preflight-v2.mjs
```

## 风险与回滚点

| 风险 | 缓解 | 回滚点 |
|---|---|---|
| `parseInferenceStatement` 正则不覆盖所有 statement 格式 | 单测覆盖 3 种典型格式 + fallback 到「unknown」 | 单文件回退，改 preflight.ts 即可 |
| 结论文件与细节文件重复内容 | 渲染时明确排除：结论不含 facts 表；细节不含决策语 | 检查渲染函数分支，删掉重复段 |
| `PreflightExportResult` 新增字段导致旧 UI 崩溃 | 新增字段为可选（optional），旧消费方未读取也不受影响 | 移除新增字段 |
| 命名冲突：`sqldiff-preflight-{ts}.md` 语义变化 | 文件名不变、内容变；文档明确「v2 起 .md 是结论」 | 回滚 exportBundle，改回调用旧函数 |
| UI 保存逻辑未同步支持双 md | 阶段 4 明确检查 save-file.ts，若不支持先扩展 | 移除 detail markdown 保存，先只保存结论 md |

## Review Gates

1. **阶段 1 后**：工具函数单测通过，可以进入阶段 2
2. **阶段 3 后**：新旧细节输出内容一致（diff 只应差标题与链接），可以进入阶段 4
3. **阶段 5 后**：所有单测通过（原 + 新），可以进入阶段 6
4. **阶段 6 后**：e2e 跑通，dump 文件人工比对通过，可以进入阶段 7
5. **阶段 8 后**：全绿，进入 `/trellis:finish-work`

## Before `task.py start`

- [ ] 用户已批准 PRD + Design + Implement
- [ ] MySQL 密码（如需 e2e）已放入 `.env.e2e`（不入库）
- [ ] 已确认不修改产品代码 schema（仅渲染层）
