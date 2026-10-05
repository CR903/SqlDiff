# 2026-10-05 docs-spec-drift-cleanup

- **Trellis 任务**：`.trellis/tasks/10-05-docs-spec-drift-cleanup/`
- **日期**：2026-10-05
- **类型**：docs / chore

## 做了什么

- 删掉 `.trellis/spec/` 里 9 处对一个**本仓库不存在**的 `mysqldiff/` 目录的引用，分布在 5 个 spec 文件
- `.gitignore` 移除 `docs/` 忽略规则，让开发日志能真正入库
- 建立 `docs/` 四件套：`daily/`、`index.md`、`README.md`、`template.md`，并把原有的 `plan.md` 一起纳入版本控制
- 按 AGENTS.md 的 P2 门禁引用路径建立 `docs/knowledge/common/best-practices/daily-to-knowledge.md`（含 P2 三问 + PR Checklist + 拦截条件）与两级 `index.md`

## 为什么这么做

两处文档描述与仓库现实脱节，而且都是**门禁失效**级别的：

**问题一 · spec 引用了不存在的目录。** `ls -d mysqldiff` 不存在、`git ls-files mysqldiff` 为空、`.gitignore` 里有两条规则双重忽略它——但 spec 里 9 处把它当既有契约引用（"保持不动"、"未改"、"是参考实现"）。后果不是文档不准确，而是**门禁空转**：近三次 check 报告都在同一处重新发现这条、各自花时间解释一遍，最后结论还是"没问题"。一个每次都要重新解释的门禁等于没有门禁。

**问题二 · docs 门禁 100% 无法执行。** AGENTS.md 开头用四大段规定"归档前必须写 `docs/daily/YYYY-MM-DD_<slug>.md` + 更新 `docs/index.md`"，还引用了 `docs/knowledge/common/best-practices/daily-to-knowledge.md` 做 P2 沉淀拦截。但 `.gitignore:6` 是整条 `docs/`，`git log --all -- 'docs/daily'` 为空——**git 全历史从未存在过 `docs/daily/`**，被引用的四个文件全部不存在。规则写得再细也执行不了。

不清理的话，每次 check 都要重新判断"这条 mysqldiff 引用算不算漂移"，而归档流程会一直卡在一个没人能完成的前提上。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `.trellis/spec/backend/quality-guidelines.md` | 删 2 处引用（Security Invariants 一条、Review Checklist 末条） |
| `.trellis/spec/backend/directory-structure.md` | 删 Reference-Only Areas 里 `mysqldiff/` 一条 |
| `.trellis/spec/backend/index.md` | 删 Pre-Development Checklist 里 `mysqldiff/` 一条 |
| `.trellis/spec/backend/manifest-export.md` | 删 2 处引用（`:49` 契约、`:160` 边界约束） |
| `.trellis/spec/backend/preflight.md` | 删 3 处引用（`:452` 表格行、`:689` / `:779` 回滚说明） |
| `.gitignore` | 删 `:6` 的 `docs/`；保留 `mysqldiff/` 两条忽略规则 |
| `AGENTS.md` | 微调一行：把 `domain context/`、`agents/` 标注为"按需创建、不存在不算漂移"，避免再产生新的悬空引用 |
| `docs/README.md` | **新建**：四件套用法、命名规则、检索命令、门禁含义、journal 区别 |
| `docs/template.md` | **新建**：可复制填写的任务日志模板 |
| `docs/index.md` | **新建**：按年月分表格的唯一索引 |
| `docs/daily/2026-10-05_docs-spec-drift-cleanup.md` | **新建**：本日志 |
| `docs/knowledge/index.md` | **新建**：知识库根索引 |
| `docs/knowledge/common/index.md` | **新建**：端索引 |
| `docs/knowledge/common/best-practices/index.md` | **新建**：分类索引 |
| `docs/knowledge/common/best-practices/daily-to-knowledge.md` | **新建**：P2 三问 + PR Checklist + 拦截条件 |
| `docs/plan.md` | 补 H1 标题（原文件无标题，是 `docs/` 里唯一无标题的文档）；随 `docs/` 移出版本控制忽略 |

产品代码零改动（AC7）。

## 9 处引用的逐条处置

| 位置 | 原内容 | 处置 |
|---|---|---|
| `quality-guidelines.md:26` | Security Invariants 末条「Keep `mysqldiff/` unchanged. Compatibility work belongs in `src-core` and must be justified by...」 | **改写保留语义**：先改成「Behavior-compatibility work belongs in `src-core`...」，再判断该条在 Security Invariants 段里其实是错位的（不是安全不变量），**最终整条删除**。理由：`src-core` 的归属规则已在 `directory-structure.md` Ownership Rules 与 `index.md` Pre-Development Checklist 里各表述一次，这里是第三份重复，删掉不丢信息 |
| `quality-guidelines.md:93` | Review Checklist 末条「`mysqldiff/` has no task-authored diff (compare with the task baseline...)，and generated `dist-*` / `release/` files were not edited.」 | **删前半保后半**：`dist-*` / `release/` 未被编辑这条检查仍然有效，改写成独立一条 |
| `directory-structure.md:60` | Reference-Only Areas 首条整行 | **删整条**（该段删后仍剩 2 条，不空） |
| `index.md:24` | Pre-Development Checklist 第 4 条整行 | **删整条**，并合掉删除留下的多余空行 |
| `manifest-export.md:49` | 「never touch Vault. `mysqldiff/` is untouched.」 | **删后半句**，保留 Vault 边界表述 |
| `manifest-export.md:160` | 「两个模块都不新增 SQL 执行入口、都不动 `mysqldiff/`。」 | **删分号后半**，句子仍通顺 |
| `preflight.md:452` | 「明确不做」表格的 `| mysqldiff/ 改动 | 保持不动 |` 一行 | **删整行**，表格结构完好 |
| `preflight.md:689` | 「无 schema 变更（...）；`mysqldiff/` 未改；」 | **删分号并列项**，前半句独立成立 |
| `preflight.md:779` | 「删 `preflight-history.json` 即清空历史，无迁移脚本；`mysqldiff/` 未改；」 | 同上 |

## 踩到的坑

- **坑位**：删 `index.md:24` 那一行后，原本列表中间多出一个空行，把 Pre-Development Checklist 从 4 条断成 3+1 两段。`directory-structure.md` 的 Reference-Only Areas 也出现了连续两个空行。
  **根因**：删除的是列表**中间**的一条，不是末尾一条。行内容删掉了，但它前后的空行分隔符留了下来。
  **通用解法**：删列表项后必须回读被删位置**前后各两行**，确认没有留下多余空行或孤立段落。列表首项 / 末项删除不会暴露这个问题（首项前的空行是标题分隔、末项后的空行是段落分隔，本就该有），只有中间项会。

- **坑位**：`.gitignore` 最后一行 `.mnemon/` 没有换行符（`cat -n` 显示 `6 docs/` 和 `7 .mnemon/---GITIGNORE---` 粘在一起）。如果按"删掉 `docs/` 那一行"的直觉去匹配整块文本，容易连带改错末行。
  **根因**：文件末尾缺少 trailing newline，编辑时对"文件末尾"的判断不可靠。
  **通用解法**：改动 `.gitignore` / 配置文件前先确认末尾是否有换行；用 `edit` 精确匹配**单行 + 唯一上下文**，不要用跨越文件末尾的多行块。

- **坑位**：本任务新写的 9 个 `docs/*.md` 里，**8 个没有 trailing newline**——包括专门记录"文件末尾缺换行"这条坑的那篇日志本身。
  **根因**：**知道坑不等于避开坑**。`.gitignore` 那次踩坑发生在"读别人的文件"时，而新建文件走的是 `write` 工具，内容正确就收工，没有任何环节去校验末尾。而这类缺陷肉眼和 `read` 都看不出来（只有 `cat -n` 才会把两个文件粘在一起暴露它）。
  **通用解法**：对**自己新建的**文件同样跑机械校验，不要因为"我知道这个坑"就跳过——`tail -c 1 <file> | wc -c` 为 0 才是通过。文档类任务收尾固定跑三条：`trailing newline`、`markdown 相对链接逐条解析`、`git status` 文件计数对不对。

## 可沉淀知识

- [ ] 无需沉淀
- [x] 有 → 已写入 `docs/knowledge/common/best-practices/daily-to-knowledge.md`，并更新 `docs/knowledge/common/best-practices/index.md`、`docs/knowledge/common/index.md`、`docs/knowledge/index.md` 三级索引

对照三问判断：上面两个坑都是"任何写文档 / 改配置的人都会踩"的坑（问一 yes），都能写成规则而非本次特例（问二 yes）。问三的答案不是"并入现有分类"——`common/best-practices/` 在本任务前并不存在（`docs/` 整条被 gitignore，git 全历史无此目录），它是本任务为承载 `AGENTS.md` 的 P2 引用而同时新建的。真正成立的是另一层判断：这两个坑的**内容**不足以单独开一篇（新文件成本高于收益），因此归并进 `daily-to-knowledge.md` 的「清理与改写门禁」一节，而不是再为 markdown 空行、`.gitignore` 末行各开一个文件。

## 遗留 / 后续

- [ ] 本任务范围内必须做的：无
- [x] ~~`docs/domain context/` 与 `docs/agents/` 被 AGENTS.md 列为 docs 结构的一部分但不存在~~ → 已在 `AGENTS.md:8` 标注为"按需创建、不存在不算漂移"，AC5 路径全部闭合
- [ ] 历史任务日志不追溯补写（PRD Out of Scope 明确排除）
- [ ] `.trellis/spec/` 之外的文档（`apps/desktop/README.md`、`.trellis/handoffs/`、归档任务 prd）里仍有 `mysqldiff/` 引用，本次按 AC1 只清理 spec；这些是历史记录与产品 README，性质不同，未动
- [ ] `apps/desktop/src-*/` 的源码注释里也提到 mysqldiff 兼容性行为，删除 spec 引用后这些注释失去 spec 侧的对应说明；属产品代码，本次零改动约束下未处理
- [ ] `preflight.md:508` 举例说明交叉引用形态时用了 `./xxx-detail.md` / `./xxx.md` 两个占位文件名，链接检查会当断链报出。它是**举例**不是真实路径，且早于本任务存在；改成反引号代码片段而非 markdown 链接更准确，未动

## 验证

```text
$ grep -rn "mysqldiff" .trellis/spec/
（无输出，exit=1）                                        # AC1 ✓

$ git check-ignore docs/
（无输出）                                              # AC3 ✓ docs/ 已移出忽略

$ ls docs/ docs/daily/ docs/knowledge/common/best-practices/
docs/          → daily/  index.md  knowledge/  plan.md  README.md  template.md
docs/daily/    → 2026-10-05_docs-spec-drift-cleanup.md   # AC4 ✓ AC6 ✓
best-practices/ → daily-to-knowledge.md  index.md        # AC5 ✓

$ grep -o 'docs/[a-zA-Z0-9_/ -]*' AGENTS.md | sort -u
docs/                                     → 存在 ✓
docs/README                               → docs/README.md 存在 ✓
docs/daily/                               → 存在（含本任务日志）✓
docs/daily/YYYY-MM-DD_<slug>.md           → 命名格式示例 ✓
docs/index                                → docs/index.md 存在 ✓
docs/knowledge/                           → 存在 ✓
docs/knowledge/common/best-practices/daily-to-knowledge.md → 存在 ✓
docs/template                             → docs/template.md 存在 ✓

（AGENTS.md:8 原先把 docs/domain context/ 与 docs/agents/ 列为并列结构，
  两者均不存在 → 已在 AGENTS.md:8 标注"按需创建、不存在不算漂移"）  # AC5 ✓

$ git status --short
?? docs/        → docs/ 下 9 个文件（8 新建 + plan.md）全部出现在待提交列表  # AC3 ✓ AC6 ✓

$ git diff --name-only
.gitignore
AGENTS.md
.trellis/spec/backend/{directory-structure,index,manifest-export,preflight,quality-guidelines}.md
（不含 apps/desktop/）                                    # AC7 ✓
```

未跑 `npm run typecheck / lint / test / build`——本任务产品代码零改动，spec 与 docs 变更不进入 TypeScript 编译路径。
