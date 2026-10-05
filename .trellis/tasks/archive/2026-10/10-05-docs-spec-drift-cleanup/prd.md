# 清理 spec 漂移 + docs 门禁落地

## Goal

两处"文档/配置描述与仓库现实脱节"的清理，让门禁回到可执行状态：

1. spec 里 9 处引用一个**本仓库不存在且被 gitignore** 的 `mysqldiff/` 目录——删除这些引用（用户已定）
2. `AGENTS.md` 的 `docs/daily/` 四件套门禁因 `docs/` 被 `.gitignore` 整条忽略而 100% 无法执行——把 `docs/` 移出版本控制忽略并真正建立四件套（用户已定）

## Background（已确认事实 · 2026-10-05 实测）

### 问题 1：mysqldiff/ 引用漂移

- `ls -d mysqldiff` → 不存在；`git ls-files mysqldiff` → 空
- `.gitignore:2-3` 有 `mysqldiff/` 与 `mysqldiff/*` 两条忽略规则
- 但 spec 里有 **9 处**把它当既有契约引用，分布在 5 个文件：
  - `backend/directory-structure.md:60` —「Its `DB.js`, `Tools.js`, and `mysqldiff` script define compatibility behavior referenced by comments and tests」
  - `backend/index.md:24` —「Treat `mysqldiff/` as read-only historical behavior」
  - `backend/quality-guidelines.md:26` —「Keep `mysqldiff/` unchanged」（Security Invariants 段）
  - `backend/quality-guidelines.md:93` — Review Checklist 末条，含「its standalone working tree may already be dirty」
  - `backend/manifest-export.md:49` / `:160`
  - `backend/preflight.md:452`（§11 表格行）/ `:689` / `:779`（章节回滚说明）
- 后果：每个 check agent 都会重新发现这条，然后各自花时间解释一遍（近三次 check 报告都提到），门禁形同虚设

### 问题 2：docs/ 门禁被阻断

- `.gitignore:6` 是 `docs/`，整条忽略
- `git ls-files docs` → 空；`git log --all -- 'docs/daily'` → 空（**git 全历史从未存在过 `docs/daily/`**）
- `docs/` 实际只有 `plan.md`（3113 字节，未入库）
- `AGENTS.md` 开头四条大标题规定了四件套（`docs/daily/` + `docs/index.md` + `docs/README.md` + `docs/template.md`）+ archive 硬门禁 + P2 沉淀拦截（引用 `docs/knowledge/common/best-practices/daily-to-knowledge.md`）
- 被引用的 `docs/knowledge/...`、`docs/README.md`、`docs/template.md`、`docs/index.md` **全部不存在**

## 用户决策

- **Q1（已定）**：mysqldiff 的 9 处引用**全部删掉**，不保留"外部/历史参考"的前提声明
- **Q2（已定）**：`docs/` **移出 `.gitignore`**，真正建立四件套并执行 AGENTS.md 门禁

## Requirements

- [ ] R1 删除 9 处 `mysqldiff/` 引用；删除后不得留下悬空引用（如「保持不动」变成孤立表格行、段落语义断裂）
- [ ] R2 `quality-guidelines.md:26` 删除后，Security Invariants 段需保持段落连贯（该条独立成段，删掉即可）
- [ ] R3 `preflight.md:452` 是「明确不做」表格的一行，删除该行不破坏表格；`:689`/`:779` 是回滚说明中的分号并列项，删除后句子需通顺
- [ ] R4 `.gitignore` 移除 `docs/`（`:6`）；`mysqldiff/` 的两条忽略规则**保留**（避免误提交外部目录）
- [ ] R5 建立四件套：`docs/daily/`（含本任务日志）、`docs/index.md`、`docs/README.md`、`docs/template.md`
- [ ] R6 `docs/plan.md` 随 `docs/` 入库（它本来就在那，属产品规划文档）
- [ ] R7 `docs/index.md` 按年月表格组织，含本任务首行；命名遵循 AGENTS.md 的 `YYYY-MM-DD_<slug>.md`
- [ ] R8 `docs/knowledge/common/best-practices/daily-to-knowledge.md` 被 AGENTS.md 的 P2 门禁引用——要么建立该文件并写入 P2 三问 + PR Checklist，要么改 AGENTS.md 引用。**需在规划时确认**
- [ ] R9 后续任务的开发日志落到 `docs/daily/`；`.trellis/workspace/*/journal-*.md` 的 session 记录**继续保留**（两者定位不同：前者是任务产物、后者是会话流水），不合并

## Acceptance Criteria

- [ ] AC1 `grep -rn "mysqldiff" .trellis/spec/` 返回空
- [ ] AC2 删改后 spec 每个受影响段落/表格语义通顺，无悬空引用、无孤立表格行
- [ ] AC3 `git check-ignore docs/` 不再命中；`docs/plan.md` 与新建四件套出现在 `git status`
- [ ] AC4 四件套齐备且内容自洽：`index.md` 有表格且有首行、`README.md` 说明用法、`template.md` 可直接复制填写
- [ ] AC5 AGENTS.md 的所有被引用路径真实存在（或引用已改）；`docs/knowledge/common/best-practices/daily-to-knowledge.md` 有明确处置
- [ ] AC6 本任务的 `docs/daily/2026-10-05_docs-spec-drift-cleanup.md` 已写 + `docs/index.md` 已加行
- [ ] AC7 产品代码零改动（`git diff --name-only` 不含 `apps/desktop/`）

## Out of Scope

- `.trellis/workspace/*/journal-*.md` 的现有内容改写或迁移
- 历史任务的日志补写（此前任务只记 journal，本次不追溯）
- `docs/knowledge/` 的完整分类体系（只按 R8 建立被引用的那一个文件）
- `.gitignore` 里 `mysqldiff/` 两条规则的删除

## Open Questions

无（Q1/Q2 已定，R8 的处置在实现时按"建立被引用文件"执行——它被 AGENTS.md 明确引用为 P2 门禁依据，删除引用会让门禁失去判据）。
