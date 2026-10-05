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
| `isNodeMeta` | `src-main/store-json.ts:64` | 8 字段守卫，挡住损坏的 `nodes.json`；`loadNodes` 用它 `filter`，一个字段判错就会静默丢节点 |

### 中低危

| 函数 | 位置 | 契约 |
|---|---|---|
| `nodesFilePath` | `store-json.ts:30` | `userDataDir` 参数是路径构造面（穿越风险） |
| `historyFilePath` | `store-json.ts:34` | 同上 |
| `resolveUserDataDir` | `store-json.ts` | 环境变量 `SQLDIFF_USER_DATA_DIR` 优先 + 回落 |
| `clearHistory` | `store-json.ts` | 破坏性操作：**写空数组**（非删文件），且文件不存在时不抛 |
| `testConnection` | `connection.ts` | 连接冒烟，4 处内部引用，失败路径无直测 |
| `diffTableField` | `src-core/diff.ts:82` | 核心 diff 引擎，解析 `SHOW CREATE TABLE` 生成 ALTER 串；经 `diffTable` 间接覆盖，但解析边界（畸形 DDL / 空输入）无直测 |

## Requirements

- [ ] R1 `escapeDataIdent` 必须覆盖：正常标识符、含反引号、连续多个反引号、空字符串、非字符串输入（`unknown`）
- [ ] R2 `isNodeMeta` / `isHistoryEntry` 必须有**逐字段判别矩阵**：每个字段缺失 / 类型错各一条，且覆盖非对象、`null`、数组
- [ ] R3 三个路径函数必须覆盖：`userDataDir` 显式传入、环境变量存在、环境变量缺省三条路径；断言路径拼接正确
- [ ] R4 `clearHistory` 必须覆盖：**文件存在时写空数组**、文件不存在时不抛（幂等）
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

---

## 勘误（2026-10-05 · check 阶段核对实现后补记）

本 PRD 初稿未读实现，以下三处**事实断言有误**（已在上文正文就地改正，此处留痕）。
实现均正确，是文档凭印象写错；`implement` 按实现写断言的方向是对的。

| 位置 | 原断言 | 实际实现 |
|---|---|---|
| 背景表 `isNodeMeta` | 9 字段守卫 | **8** 个判别字段：`id`(含 `length>0`)/`alias`/`host`/`user`/`database`/`port`/`createdAt`/`ssh`。`group`/`tags`/`star`/`pinned`/`useCount` 是 `NodeMeta` 上的**可选**字段，不参与判别 |
| R4 + 背景表 `clearHistory` | 文件存在时**删除** | `store-json.ts:122-124` 写 `writeJsonFileAtomic(historyFilePath(dir), [])`，即**写空数组**。与 `clearPreflightHistory`（`:179-181`）同语义 |
| design.md `diffTableField` | 隐含"整段 DDL 都解析" | 循环是 `for (i = 1; i < t1.length - 1; i++)`：**首行 CREATE 头与末行右括号都不参与解析**，且两侧任一 `< 3` 行直接返回 `''` |

第三点的延伸勘误：`clearHistory` 写 `[]` 与 `loadHistory` 的读取语义**自洽**（缺文件回落 `[]`，读到 `[]` 也得 `[]`），
对所有 reader 与删文件**观察等价**，唯一副作用是顺带 `mkdirSync` 出目录。所以实现不算缺陷，无需另开任务。

