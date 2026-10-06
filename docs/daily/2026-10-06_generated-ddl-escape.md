# 2026-10-06 generated-ddl-escape

- **Trellis 任务**：`.trellis/tasks/10-06-generated-ddl-escape/`（归档后见 `archive/2026-10/`）
- **日期**：2026-10-06
- **类型**：fix（安全硬化）

## 做了什么

- `src-core/diff.ts`：import `escapeDataIdent`，11 处调用方标识符（表名/例程名/`targetUser`）入引用前反引号加倍；服务端片段保持原文回填。
- `tests/core/diff.test.ts`：新增「标识符转义硬化」describe（9 项）+ 把 1 处旧弱断言改强；常规名 byte-stable 锁定。
- `database-guidelines.md`：转义章节更新为双路径已硬化，解除「不得断言转义」旧约束。

## 为什么这么做

遗留已知边界（`2026-10-05_contract-test-landing.md` §重要发现）：`name` 包反引号但不加倍，含反引号的表名可跳出引用；`diff.sql` 从不执行但可复制粘贴（`App.tsx:1215`），信任边界在用户粘贴。关掉它需 escaping + 版本说明，即本任务。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `apps/desktop/src-core/diff.ts` | import + 11 处转义 |
| `apps/desktop/tests/core/diff.test.ts` | +9 新用例，1 处旧用例改强并修正实错注释 |
| `.trellis/spec/backend/database-guidelines.md` | 转义章节更新（版本说明落点：仅 spec+日志，不碰输出格式） |

## 踩到的坑

- **坑位**：终审发现旧测试标题写了 `/ VIEW` 实际只测 PROCEDURE，且 457 行注释「此处是 legacy 插值」在硬化后变实错。
  **根因**：标题与断言脱节；注释描述实现机制，实现变了注释没跟。
  **通用解法**：测试标题必须能被其断言逐字兑现；描述机制的注释随机制一起改。

## 质量证据

- 四门禁全绿：typecheck / lint / 52 文件 907 项 / build
- 变异自证：恢复旧 `diff.ts` → 5 项变红（恰为转义行为断言；byte-stable 与片段原文断言双侧通过，符合设计）
- 终审（trellis-check）通过，3 处缺口已补（DROP VIEW / 独立 ADD-DROP PK / 457 行注释）
