# 生成结构DDL转义硬化

## Goal

`src-core/diff.ts` 生成的结构 DDL 消除标识符注入面（调用方传入的表名/例程名/DEFINER 用户名含反引号时不再能跳出引用），并留下版本说明；`tests/` 补对抗用例。常规标识符输出保持 byte-stable。

## 已确认事实（代码面证据）

- 输出点共 11 处裸插值（`diff.ts:60,142,146,149,152-155,164,169,202,234,241`）：`name` 被包反引号但**未做反引号加倍**；`targetUser`（`:202`）同样未转义。表名含反引号即可跳出引用，经 `App.tsx:1215` 复制粘贴进客户端仍语法合法（信任边界在用户粘贴，不在应用不执行）。
- 列/主键/索引片段（`c/c1/pk/k`）来自 SHOW CREATE 服务端已加引号的原文，原样回填即保留服务端转义；**不可**对其整体做反引号加倍（会破坏服务端已正确的 ` `` ` 转义）。硬化范围 = 调用方输入（`name`、`targetUser`），服务端片段保持原样。
- 口径先例：`data-diff.ts:37 escapeDataIdent`（反引号加倍），注释明写「表名/列名进 SQL 前必经此函数」。
- 常规标识符 byte-stable：`name` 不含反引号时加倍前后输出逐字节一致，既有 `tests/core/diff.test.ts` 硬编码期望（`:126,342,364`）不受影响。
- spec 已预告本任务：`database-guidelines.md:10,108-122` 明确「关掉它需要 escaping + 生成 DDL 上的版本说明」，且此前要求测试**不得**把转义当已保证来断言——本任务落地后该约束解除。

## Requirements

- R1 `diff.ts` 所有 `name` 入引用处改走反引号加倍转义（含 `DROP TABLE`、6 处 ALTER、2 处 DROP INDEX/PK、3 处 `DROP ${ex}`）；`changeProcedure` 的 `targetUser` 同理。
- R2 转义实现复用口径：与 `escapeDataIdent` 同语义（反引号加倍）；`diff.ts` 现零 import，直接 import `data-diff.ts` 还是内联小函数由实现时定（import 则同步更新文件头注释）。
- R3 版本说明 = spec + 日志（D3）：更新 `database-guidelines.md` 转义章节（解除「不得断言转义」约束，记录硬化口径与 byte-stable 边界）+ 本任务 `docs/daily` 日志；`diff.sql` 输出格式零额外改动。

## Acceptance Criteria

- [ ] AC1 含反引号的表名（如 `` `a``b` `` 应输出 `` `a```b` `` 包裹）经 `diffTable`/`diffTableField`/`diffProcedure` 全输出点不再跳出引用；`targetUser` 含反引号同理。
- [ ] AC2 常规标识符输出 byte-stable：全量既有 `tests/core/diff.test.ts` 零改动通过。
- [ ] AC3 新增对抗用例：反引号表名/列名/索引名的 ADD/DROP/CHANGE/DROP INDEX/DROP TABLE/DROP VIEW 输出断言 + 常规名 byte-stable 锁定断言。
- [ ] AC4 `database-guidelines.md` 转义章节更新（硬化口径 + byte-stable 边界 + 解除旧约束）；`docs/daily` 日志 + `docs/index.md` 更新。
- [ ] AC5 产品代码只动 `src-core/diff.ts`；`data-diff.ts`、mysqldiff 语义、IPC/写侧/读侧守卫零改动；秘密零入库。

## Key Decisions

- D1 硬化范围 = 调用方输入（`name`、`targetUser`），服务端片段保持原样（整体加倍会破坏服务端已正确的转义）。
- D2 转义口径与 `escapeDataIdent` 同语义（反引号加倍）；是否 import 复用还是内联，实现时按 `diff.ts` 零 import 现状定（import 即破零依赖注释，需同步更新文件头说明）。
- D3 版本说明仅 spec + 日志（用户已选 A），不碰输出格式。

## Risks / Deferred

- 含反引号/特殊字符的标识符输出与历史 mysqldiff 逐字节不一致——属本任务要修复的语义，常规标识符不受影响。
- DEFINER 正则健壮性、服务端片段重解析不在本任务范围。

## Out of Scope

- 服务端片段（列定义/主键/索引原文）的重解析转义——会破坏服务端正确转义。
- `diff.sql` 从不执行的现状不变；本任务只收紧粘贴面的字符串安全性。
- DEFINER 正则本身的健壮性（无 DEFINER 时降级等既有语义不动）。

