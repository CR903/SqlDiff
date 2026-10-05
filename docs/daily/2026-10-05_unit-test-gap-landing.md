# 2026-10-05 unit-test-gap-landing

父任务 `10-05-contract-test-landing` 的子任务 A。任务文档见 `.trellis/tasks/10-05-unit-test-gap-landing/`（`prd.md` / `design.md` / `implement.md`）。

## 做了什么

给 9 个「有实现、有内部调用、但 `tests/` 里一次都没被提及」的导出函数补上直接契约测试。产品代码零改动。

| 函数 | 新增项数 | 落点 |
|---|---|---|
| `escapeDataIdent` | 12 | `tests/core/data-diff.test.ts`（追加） |
| `diffTableField` | 14 | `tests/core/diff.test.ts`（追加） |
| `isNodeMeta` / `isHistoryEntry` | 23 / 15 + 边界 | `tests/main/store-json.test.ts`（新建 364 行） |
| `nodesFilePath` / `historyFilePath` / `resolveUserDataDir` / `clearHistory` | 4 / 4 / 5 / 6 | 同上 |
| `testConnection` | 13 | `tests/main/connection.test.ts`（追加） |

高危三个：`escapeDataIdent`（表名/列名进 SQL 的必经防线，同文件其余 4 个导出都有直测唯独漏它）、`isHistoryEntry`（被 `main.ts:23` 直接 import 走 IPC）、`isNodeMeta`（8 字段反序列化守卫）。

## 修了什么

**没修产品代码——但发现了三处 PRD 事实错误，全部由实现方按实现纠正。**

我写 PRD 时没读实现就凭印象填了三句事实，全错：

| 我在 PRD 里写的 | 实现真相 |
|---|---|
| `clearHistory` "文件存在时删除" | `writeJsonFileAtomic(path, [])` —— 写空数组，不删文件 |
| `isNodeMeta` 是 "9 字段守卫" | 判 **8** 个字段（`group`/`tags`/`star` 是可选类型字段，不参与判别） |
| `diffTableField` "只补畸形输入不抛" | 解析范围是 `1..len-1`，首行 CREATE 头与末行右括号都不参与 |

实现方没照着错的 PRD 写假红断言，而是按实现锁契约并就地改正文档 + 追加勘误留痕。终审独立复核后确认三处**都是文档错、实现对**，方向正确。

## 质量

- **870 项全绿**（748 → +122，51 文件）；typecheck / lint / build 全绿
- **产品代码零改动**：`git diff --name-only -- src-core src-main src-renderer` 输出为空
- **变异测试三次全部自证「先见红」**（实现方 + 终审各独立复现一遍，主会话再独立复现一遍）：
  - 破坏 `escapeDataIdent` 的反引号加倍 → **7 failed**
  - 删掉 `isNodeMeta` 的 `id.length > 0` → **1 failed**
  - 放宽 `isHistoryEntry` 的 `diffCount` 判据 → **3 failed**
- 既有断言零改动：`git diff -U0 -- apps/desktop/tests | grep -E '^-[^-]'` 仅 2 行，均为 import 语句
- 终审另修 5 处：2 处测试注释事实错误（端口范围归属写错、ANSI_QUOTES 论证与实现硬编码反引号矛盾）、3 处任务文档漂移（含一条失效 jsonl 引用）

## 踩到的坑

**① PRD 里的事实断言，代价是两个子代理的返工。** 错的不是文档本身，而是下游会照着它写代码——implement 照着写会产出假红用例，check 要逐条反查实现才能发现。写 PRD 时凡是「X 是 Y 语义」「X 有 N 个字段」这类句子，先 grep 实现确认。

**② 安全断言的"等价类"不能随手放宽。** design 原本论证「将来改用 ANSI 双引号包裹也是合法方案，所以断言不该锁死反引号」——**这个论证本身是错的**：`ANSI_QUOTES` 默认关闭，此时 `"a"` 在 MySQL 里是字符串字面量。默认模式下反引号是**唯一合法**的标识符引号。放宽断言等于给「用双引号包裹标识符」这个真错误的实现发通行证。终审把这个判断写进测试文件头注释，防止后人当遗漏去"修"。

**③ 守卫测试要打判别矩阵，不能打快照。** 快照只记录一个形状；守卫的职责是在 IPC / 文件边界挡坏数据，只测 happy path 等于没测它的本职。必测两个易漏边界：唯一带额外约束的字段（`id.length > 0`）、`isRecord` 显式排除数组的那一层（`{}` / `[]` / `['k']` / `'str'` 四态）。

## 重要发现：generated DDL 未转义（已知边界，未修）

核实 `escapeDataIdent` 时顺带发现：**生成的 ALTER 语句不走转义 helper**。

- `src-core/diff.ts` **零 import**；`ALTER TABLE \`${name}\`` 包裹但**不做反引号加倍**；`DROP COLUMN ${c}` / `CHANGE COLUMN ${c}` 的**列名连反引号都没有**
- 缓解约束成立：生成的 `diff.sql` **从不执行**（`preflight-run.ts:16` 有 grep 硬约束；核实 `src-main/` 所有 `db.query(sql, params)` 都是元数据读）
- **残留风险**：字符串**可被复制**（`App.tsx:1215` 有复制按钮）。A 侧库上一个精心构造的表名/列名能产出粘贴进 MySQL 客户端仍语法合法的 DDL 文本。所以信任边界在**用户的粘贴**，不在应用

已把这段写进 `database-guidelines.md` 的 "Two escaping paths, only one of them is hardened"，并明确标注**不要顺手改成 `escapeDataIdent`**——输出是与历史 `mysqldiff` 语义对齐的 byte 稳定行为，关掉它需要配套版本说明，是独立任务。

## 可沉淀知识

- 已写入 [`docs/knowledge/common/best-practices/assertion-and-doc-fidelity.md`](../knowledge/common/best-practices/assertion-and-doc-fidelity.md)（并入 `common/best-practices` 现有分类，未新建分类）：
  - 文档里的事实断言必须读实现核对后再写
  - 安全断言的"等价类"要选对，放宽前先确认开关默认值
  - 守卫函数的测试要打判别矩阵，不是打快照
- 索引已更新：`docs/knowledge/common/best-practices/index.md`。`common/index.md` 与 `docs/knowledge/index.md` 列的是**分类**与**端**，本次无新增，故不动。

## 未修的产品观察（R9：只记录）

1. **`clearPreflightHistory` 注释漂移**（`store-json.ts:178-181`）：注释写「删文件即清空」，实现是 `writeJsonFileAtomic(..., [])`。与 `clearHistory` 行为一致，所以不是 bug，只是注释与实现不符。**建议单独一行修复任务。**
2. **`isNodeMeta` 的 `port` 只判 `typeof number`**：`NaN` / `Infinity` / `-1` / `70000` 全被接受。写入面 `main.ts:buildNodeMeta → normalizePort` 已保证范围合法，只有手改坏 `nodes.json` 才能触发，后果是建连失败的结构化错误（非静默出错）。**低危，可搭车修。**
3. **`isHistoryEntry` 纳 `id: ''`**（而 `NodeMeta.id` 有 `length > 0` 约束），而 `appendHistory` 用 id 去重——空 id 条目会互相顶掉。产品路径不可达。**低危，可搭车修。**

后两条建议合开一个「守卫收紧」任务，连同 generated DDL 转义一起排期。

## 验证

- `npx vitest run` → **51 文件 / 870 项全绿**（748 → +122）
- `npm run typecheck` / `lint` / `build` → 全绿
- 9 个目标函数各有直测（grep 命中文件数均 ≥ 1）
- 变异测试三次，主会话 + 终审各独立复现，均**先见红**
- 产品代码零改动（`git diff --name-only -- src-core src-main src-renderer` 空）
- 既有断言零改动（删除行仅 2 行 import）

## 后续

父任务还有子任务 B（`10-05-export-e2e-landing`）：§11.1 保密硬边界断言 + Preflight/Manifest 导出 UI E2E（真机，零产品代码改动）。按父任务 `implement.md` 的编排顺序，B 在 A 之后跑。
