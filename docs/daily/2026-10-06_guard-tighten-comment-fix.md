# 2026-10-06 guard-tighten-comment-fix

- **Trellis 任务**：`.trellis/tasks/10-06-guard-tighten-comment-fix/`
- **日期**：2026-10-06
- **类型**：fix

## 做了什么

- `isNodeMeta.port` 从 `typeof number` 收紧为 `Number.isInteger + 1–65535`，与写侧 `normalizePort` 同口径。
- `isHistoryEntry` 加 `id.length > 0`，`diffCount` 改 `Number.isFinite`，堵住空串 id 折叠 `appendHistory` 去重。
- `clearPreflightHistory` 注释「删文件即清空」改为写空数组语义，与 `clearHistory` 对齐；实现零改动。
- `tests/main/store-json.test.ts` 改判据 + 重写 rationale，新增 16 项边界用例；全量 899 项全绿。

## 为什么这么做

遗留项（`2026-10-05_contract-test-landing.md` §遗留 3–4）：读侧守卫放过 NaN/Infinity/-1/70000 与空串 id。写侧与 IPC 面已有强守卫，风险只剩手改坏的 json 文件在读侧被当合法加载。

## 改了哪些文件

| 文件 | 改动 |
|---|---|
| `apps/desktop/src-main/store-json.ts` | 两处守卫收紧 + 一处注释修正 |
| `apps/desktop/tests/main/store-json.test.ts` | 改 4 项旧判据，新增 16 项边界用例 |

## 踩到的坑

本任务未遇到坑。终审抓到 1 处 PRD 自相矛盾（Out of Scope 与 D2 对 diffCount 口径不一），archive 前已修；教训：D2 类"搭车"决策落地时同步清理 Out of Scope。

## 质量证据

- 四门禁全绿：typecheck / lint / 52 文件 899 项 / build
- 变异自证：临时恢复旧守卫 → 12 项变红（8 port + 3 diffCount + 1 id），恰为本次改动断言
- 终审（trellis-check）通过，可归档
