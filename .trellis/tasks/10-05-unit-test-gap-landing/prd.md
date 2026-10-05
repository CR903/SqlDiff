# 补齐 9 个零直测导出函数

## Goal

给 9 个「有实现、有内部调用、但 `tests/` 里一次都没被提及」的导出函数补上**直接契约测试**，其中 `escapeDataIdent` 是 SQL 标识符注入防线，优先级最高。

父任务：[10-05-contract-test-landing](../contract-test-landing/)

## 背景（已核实 · 2026-10-05 代码面扫描）

判据：`grep -rn "\b<fn>\b" tests/` 命中文件数 = 0。以下 9 个全部为 0。

### 高危（安全 / 正确性边界）

| 函数 | 位置 | 为什么危险 |
|---|---|---|
| `escapeDataIdent` | `src-core/data-diff.ts:37` | 注释明写「表名/列名进 SQL 前必经此函数」；实现是反引号加倍。失效 = **静默 SQL 注入**。同文件其余 4 个导出（`addslashes` / `getDataPKV` / `sqlLiteral` / `diffDataRows`）都有直测，**唯独漏它** |
| `isHistoryEntry` | `src-main/store-json.ts:79` | 5 字段守卫，挡住损坏/伪造的 `history.json`；被 `src-main/main.ts:23` **直接 import** 用于 IPC 入口校验 |
| `isNodeMeta` | `src-main/store-json.ts:64` | 9 字段守卫，挡住损坏的 `nodes.json`；`loadNodes` 用它 `filter`，一个字段判错就会静默丢节点 |

### 中低危

| 函数 | 位置 | 契约 |
|---|---|---|
| `nodesFilePath` | `store-json.ts:30` | `userDataDir` 参数是路径构造面（穿越风险） |
| `historyFilePath` | `store-json.ts:34` | 同上 |
| `resolveUserDataDir` | `store-json.ts` | 环境变量 `SQLDIFF_USER_DATA_DIR` 优先 + 回落 |
| `clearHistory` | `store-json.ts` | 破坏性操作：删文件 / 文件不存在时不抛 |
| `testConnection` | `connection.ts` | 连接冒烟，4 处内部引用，失败路径无直测 |
| `diffTableField` | `src-core/diff.ts:82` | 核心 diff 引擎，解析 `SHOW CREATE TABLE` 生成 ALTER 串；经 `diffTable` 间接覆盖，但解析边界（畸形 DDL / 空输入）无直测 |

## Requirements

- [ ] R1 `escapeDataIdent` 必须覆盖：正常标识符、含反引号、连续多个反引号、空字符串、非字符串输入（`unknown`）
- [ ] R2 `isNodeMeta` / `isHistoryEntry` 必须有**逐字段判别矩阵**：每个字段缺失 / 类型错各一条，且覆盖非对象、`null`、数组
- [ ] R3 三个路径函数必须覆盖：`userDataDir` 显式传入、环境变量存在、环境变量缺省三条路径；断言路径拼接正确
- [ ] R4 `clearHistory` 必须覆盖：文件存在时删除、文件不存在时不抛
- [ ] R5 `testConnection` 必须覆盖成功与失败路径（用现有 mock 手段，不引入新依赖）
- [ ] R6 `diffTableField` 必须覆盖畸形输入（空串 / 非 DDL 文本 / 残缺 `SHOW CREATE TABLE`）不抛且返回可解析结果
- [ ] R7 全部测试放 `apps/desktop/tests/` 下对应子目录：纯函数 → `tests/core/`，主进程/IO → `tests/main/`
- [ ] R8 不引入新依赖；Node API 用 `vi.mock` / `vi.stubGlobal`
- [ ] R9 发现产品 bug 只记录、另开任务，不在本任务改产品代码

## Acceptance Criteria

- [ ] AC1 9 个函数各自在 `tests/` 至少有 1 项直测（用父任务的 grep 脚本验证）
- [ ] AC2 `escapeDataIdent` 含反引号的用例存在，且能证明注入被阻断（断言输出里的标识符不可逃逸出反引号包裹）
- [ ] AC3 两个守卫各有逐字段矩阵用例，不是只测 happy path
- [ ] AC4 `npx vitest run` 全绿且项数净增（父任务基线 748 项）
- [ ] AC5 `npm run typecheck` / `lint` / `build` 全绿
- [ ] AC6 产品代码 `src-core/` `src-main/` `src-renderer/` 零改动
- [ ] AC7 每条新断言经变异测试自证非空转（至少对 `escapeDataIdent` 与两个守卫各做一次）

## Out of Scope

- 覆盖率工具接入（不引入新依赖）
- `src-core/data-diff.ts` 里 `escapeDataIdent` 的**实现改动**——即使发现边界缺陷也只记录
- `preflight` / `manifest` 的无秘密属性断言（属子任务 B）
- React 组件渲染测试

## Key Decisions

- **"零直测"而非"零覆盖"**：多数函数有间接覆盖（经调用方），本任务补的是字段级/边界级契约。PRD 用词已对齐，避免夸大缺口。
- **守卫测试用判别矩阵而非快照**：快照只能记录一个形状，矩阵才能表达"哪些被接受、哪些被拒绝"这个真正的契约。
- **`escapeDataIdent` 用"不可逃逸"表述断言**：直接断言字符串等值容易被实现细节绑死（万一将来改用双引号包裹）；断言"反引号成对且标识符被完全包裹"更贴近安全契约本身。

## Open Questions

无。
