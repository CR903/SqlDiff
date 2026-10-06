# 守卫收紧与clearPreflightHistory注释修复

## Goal

收紧读侧守卫（`isNodeMeta.port`、`isHistoryEntry.id`），修复 `clearPreflightHistory` 注释漂移；`tests/` 补判别用例。产品行为（写侧、IPC）不动。

## 已确认事实（代码面证据）

- 写侧已有强守卫：`main.ts:88-95 normalizePort` 要求 1–65535 整数，否则 throw。产品自身写出的 `nodes.json` 端口必然合法。
- 读侧守卫宽松：`store-json.ts:64-77 isNodeMeta` 只判 `typeof port === 'number'`，NaN / Infinity / -1 / 70000 全过 `loadNodes` 过滤；下游 mysql2 建连即报结构化错误，不静默（既有测试 `store-json.test.ts:100-109` 把该宽松锁死并写了 rationale）。
- `isHistoryEntry`（`store-json.ts:79-88`）纳 `id: ''`（既有测试 `:192-194` 锁死为接受）；`appendHistory`（`:116`）按 id 去重置顶，空串 id 会把所有空 id 条目折叠成一条。
- IPC 面已兜底：`main.ts:277-286 history.append` 对空 id/at 用 randomUUID/now 回填后再过守卫，空 id 经 IPC 到不了 `appendHistory`；风险只剩手改 `history.json` 文件。
- 注释漂移：`clearPreflightHistory`（`store-json.ts:178-181`）注释写「删文件即清空」，实现是写 `[]`；同文件 `clearHistory`（`:121-124`）同语义且有测试 `:329-334` 把「写空数组而非删文件」锁死。修注释与实现对齐即可，不动实现。

## Requirements

- R1 `isNodeMeta` 拒收非法 port：`Number.isInteger + 1–65535`（D1）。
- R2 `isHistoryEntry` 拒收 `id: ''`（与 `isNodeMeta.id` 的 `length > 0` 对齐；`appendHistory` 去重语义不再被空串破坏）。
- R3 `clearPreflightHistory` 注释改成写空数组语义，与 `clearHistory` 口径一致。
- R4 `tests/main/store-json.test.ts` 同步更新：原来锁死宽松行为的用例（port NaN/Infinity → true、id '' → true）改判据，注释 rationale 同步改写；新增边界用例（-1 / 0 / 65536 / 70000 / 非整数 / NaN / Infinity）。
- R5 产品代码只动两处守卫 + 一处注释；写侧 `normalizePort`、IPC 回填逻辑不动。

## Out of Scope

- 生成 DDL 未转义（另独立立项，需版本说明）。
- `ssh` 对象深层校验、8.x 中间版本真机覆盖。

## Acceptance Criteria

- [ ] AC1 `isNodeMeta({port: NaN / Infinity / -1 / 0 / 65536 / 70000 / 1.5})` 均为 false；`port: 1 / 22 / 3306 / 65535` 为 true。
- [ ] AC2 `isHistoryEntry({id: ''})` 为 false；`id: 'x'` 仍为 true；`appendHistory` 不再被空串 id 折叠。
- [ ] AC3 `clearPreflightHistory` 注释与实现一致（写空数组），与 `clearHistory` 口径相同；实现零改动。
- [ ] AC4 既有锁死宽松行为的用例已改判据、rationale 重写；全量 `tests/` 无回归（四门禁全绿）。
- [ ] AC5 产品代码只动 `src-main/store-json.ts` 两处守卫 + 一处注释；`normalizePort`、IPC 回填逻辑零改动。

## Key Decisions

- D1 port 口径与写侧对齐 `Number.isInteger + 1–65535`（用户已选 A）：读写同口径，手改坏文件在读侧即被过滤。
- D2 `diffCount: NaN` 搭车改为有限数判别（`Number.isFinite`），与 port 同类收紧，无异议顺手做。
- D3 `clearPreflightHistory` 只修注释不动实现（删文件→写空数组是语义变更，另立项才做）。

## Risks / Deferred

- 手改 `nodes.json` 塞非法端口的老文件：以前能加载（连库时才报错），现在读侧直接过滤。属预期行为变更，写侧产品永不产出此类文件。
- 生成 DDL 未转义仍另独立立项，不在本任务动。
