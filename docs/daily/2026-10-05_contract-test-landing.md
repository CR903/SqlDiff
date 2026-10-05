# 2026-10-05 contract-test-landing

父任务。两个子任务已分别完成归档：`10-05-unit-test-gap-landing`（`7975810`）、`10-05-export-e2e-landing`（`ae54fe4`）。

## 做了什么

把**代码或 spec 已经声明、但至今没有任何测试兑现**的契约补上。两个来源，都用代码面证据扫出来，不凭记忆：

| 来源 | 内容 | 子任务 | 产出 |
|---|---|---|---|
| 代码声明了但没测 | 9 个导出函数测试零引用 | A | +122 项（748 → 870） |
| spec 要求了但没测 | §11.1 保密硬边界全仓零断言 | B1 | +17 项（870 → 887） |
| spec 要求了但没测 | 导出按钮 UI E2E 不存在 | B2 | 真机 2 项 |

**最终：887 项 / 52 文件全绿，产品代码零改动。**

## 高危项（值得单独记）

`escapeDataIdent`（`data-diff.ts:37`）—— 注释明写「表名/列名进 SQL 前必经此函数」，而同文件其余 4 个导出都有直测，**唯独漏它**。它的失效是**静默的 SQL 注入**，不会被任何现有断言捕获。

## 规划期就抓到的 spec 漂移（本轮共 5 处）

连续发现同一个规律：**任务新增能力时只更新自己那一节，交叉引用留旧**。

| # | 漂移 | 修在哪 |
|---|---|---|
| 1 | §14.10 四条 follow-up 里三条早已落地但没回填 | `ec9bd1c` |
| 2 | `schemaVersion` 口径整体停在 v1，常量已是 2（含一条会让未来 UI 测试必然失败） | `c99c792` |
| 3 | Preflight 导出文件数 spec 写 2 份、代码是 3 份 | `6818043` |
| 4 | `clearPreflightHistory` 注释写「删文件即清空」，实现是写空数组 | 记录（属产品注释，R9 不在本轮改） |
| 5 | 生成 DDL 未转义的边界在 spec 里只有半句含糊描述 | 补 `database-guidelines.md` 完整章节 |

## 我犯的错（值得记）

**写 PRD 时没读实现就凭印象填了三句事实，全错**：`clearHistory` 语义、`isNodeMeta` 字段数（9→8）、`diffTableField` 解析范围。代价是两个子代理的返工。已沉淀为规则。

**design 里关于 ANSI 双引号的一条论证本身是错的**：我写「将来改用 ANSI 双引号包裹也是合法方案，所以断言不该锁死反引号」。终审推翻——`ANSI_QUOTES` 默认关闭，此时 `"a"` 是字符串字面量，反引号是**唯一合法**的标识符引号。放宽断言等于给真错误的实现发通行证。

## 重要发现：生成 DDL 未转义（已知边界，未修）

`src-core/diff.ts` **零 import**，ALTER 语句裸插值，`DROP COLUMN ${c}` 的列名**连反引号都没有**。

缓解约束成立：`diff.sql` **从不执行**（grep 硬约束，已核实 `src-main/` 所有 `db.query` 都是元数据读）。但字符串**可被复制粘贴**（`App.tsx:1215`），A 侧一个精心构造的表名能产出粘贴进客户端仍语法合法的 DDL。信任边界在**用户的粘贴**，不在应用。

已写入 `database-guidelines.md` 的 "Two escaping paths, only one of them is hardened"，并明确标注**不要顺手改成 `escapeDataIdent`**——输出是与历史 `mysqldiff` 语义对齐的 byte 稳定行为。

## 终审的独立发现

**Playwright 1.63 不对 `type=password` 掩码**——B2 需把真实密码打进 UI 表单，明文原样进 `trace.zip`，而 config 是 `retain-on-failure`。处置：本 spec 默认 `trace: 'off'`，排查时 `E2E_TRACE=1` 临时打开。这是「秘密不落盘」与「失败可诊断」的显式取舍，偏向安全。

## 质量证据

- **887 项全绿**（748 → +139，52 文件）；四门禁全绿
- **产品代码零改动**：`git diff cd028b9..HEAD -- src-core src-main src-renderer` 为空
- **变异测试全部自证「先见红」**，且多处由主会话独立复现（不信子代理自报）：
  - 破坏 `escapeDataIdent` 转义 → 7 failed
  - 删 `isNodeMeta` 的 `id.length > 0` → 1 failed
  - 放宽 `isHistoryEntry` 的 `diffCount` → 3 failed
  - 哨兵值拼进 `inferences[].statement` → 1 failed
- **秘密零入库**：`git grep -i "DB.smarterlab"` 除检查命令记录外 0 命中；`.env.e2e` 未入库
- 既有断言零改动：`git diff -U0 -- apps/desktop/tests | grep -E '^-[^-]'` 仅 2 行 import

## 可沉淀知识

- [`assertion-and-doc-fidelity.md`](../knowledge/common/best-practices/assertion-and-doc-fidelity.md)：PRD 事实断言先读实现 / 安全断言的等价类别乱放宽 / 按产物类型分层而非按标签猜 / 守卫测试打判别矩阵
- [`e2e-env-config.md`](../knowledge/common/best-practices/e2e-env-config.md)（上一任务）：dotenv 加载优先级 / 动态目标机不给默认地址 / lint ignore 与 .gitignore 同步

索引已更新至 `docs/knowledge/common/best-practices/index.md`。

## 集成复核（父任务 implement.md 清单）

| AC | 结论 |
|---|---|
| AC1 项数净增且全绿 | 748 → 887（+139）✅ |
| AC2 四门禁 | 全绿 ✅ |
| AC3 9 个函数各有直测 | grep 全部 ≥1 ✅ |
| AC4 §11.1 覆盖三格式 + Manifest，变异自证 | 5 个哨兵引用 + E2E 2 处断言 ✅ |
| AC5 UI E2E 真机真实执行 | 2 passed（7.9s）非 skip ✅ |
| AC6 秘密零入库 | ✅ |
| AC7 产品代码零改动 | ✅ |
| AC8 spec 口径一致 | schemaVersion 2 / 3 文件 ✅ |

## 遗留 / 后续

1. **5.7 真机不可达**：`192.168.2.84` socket 超时，`e2e:preflight:mysql` 两项 5.7 用例失败。经独立核实为**虚拟机环境问题非代码回归**（`.115` 正常，同次运行 8.x 通过）。**机器恢复后需重跑确认。**
2. **生成的 ALTER 语句未转义**（见上）——独立立项，因为关掉它需要配套版本说明。
3. **守卫收紧**（低危，可搭车）：`isNodeMeta` 的 `port` 只判 `typeof number`（`NaN`/`-1`/`70000` 全被接受）；`isHistoryEntry` 纳 `id: ''` 而 `appendHistory` 按 id 去重。
4. **`clearPreflightHistory` 注释漂移**——单独一行修复任务。
5. **8.0.12–8.0.28 中间版本真机覆盖**仍缺（需新机器）。
6. **两层 §11.1 判据刻意不共享**（`tests/` 不能 import `e2e/`）——代价是 `CONFIDENTIALITY_NOTES` 两处要同步改，已在注释里互相指认。
