# design.md — 9 个零直测导出的契约测试

## 边界

**只新增测试文件**，`src-core/` `src-main/` `src-renderer/` 零改动。测试放 `tests/core/`（纯函数）与 `tests/main/`（主进程 / IO）。

## 放置决策

| 函数 | 归属 | 理由 |
|---|---|---|
| `escapeDataIdent` | `tests/core/data-diff.test.ts`（**追加**） | 同文件其余 4 个导出已在此测，追加保持内聚 |
| `diffTableField` | `tests/core/diff.test.ts`（追加） | 同上，`diffTable` 已在其中 |
| `isNodeMeta` / `isHistoryEntry` / `nodesFilePath` / `historyFilePath` / `resolveUserDataDir` / `clearHistory` | `tests/main/store-json.test.ts`（**新建**） | 现有测试都经 `loadNodes`/`loadHistory` 等间接触达，无专门测该文件的用例 |
| `testConnection` | `tests/main/connection.test.ts`（**追加**） | 该文件已存在且覆盖隧道配置/端口/缓存，直接追加而非新建 |

## 三类契约测试的写法

### 一、注入防线：`escapeDataIdent`

实现只有一行：`\`${String(name).replace(/`/g, '``')}\``。

契约本质是：**标识符里的反引号被加倍，使其无法逃逸出反引号包裹**。

因此断言**不写字符串等值**，而写逃逸判定：

```
标识符被完全包裹 → 去掉首尾反引号后，剩余内容里不应出现未成对的反引号
或更实用：``a`b`` → 输出应为 `` `a``b` ``，且 `` `` `` 的数量 === 输入反引号数量 × 2
```

理由：字符串等值会把测试绑死在"用反引号包裹"这个实现选择上。将来若换一种**仍然合法**的标识符引号写法，等值断言会假红，而逃逸判定仍然成立——**它测的是安全性质，不是实现细节**。

> **check 阶段补充**：本节原举例"改用 ANSI 双引号包裹也是合法方案"，这个前提不成立——`"` 只有在 `ANSI_QUOTES` 模式下才引号化标识符，而该模式默认关闭；非 ANSI_QUOTES 下 `"a"` 是字符串字面量。因此 `unwrapIdent` helper **刻意锁死反引号**，且不该放宽成"反引号或双引号都算过"（那会放进一个真错误的实现）。已把该判断写进 `tests/core/data-diff.test.ts` 的文件头注释，避免后人误当成遗漏去"修正"。

必须覆盖的输入：

| 输入 | 期望 |
|---|---|
| `users` | 原样包裹 |
| `` a`b `` | 反引号加倍 |
| ``` a``b ``` （连续两个） | 每个都加倍（4 个） |
| `` `` `` （仅反引号） | 4 个反引号 + 包裹 |
| `''` | 仍是合法包裹的空标识符 |
| 含换行 / NUL | 不破坏包裹结构 |
| 非字符串（数字 / `null` / 对象） | 走 `String()` 分支，不抛 |

### 二、守卫判别矩阵：`isNodeMeta` / `isHistoryEntry`

契约是**接受/拒绝的边界**，不是"一个形状能过"。

矩阵的构造方式：取一个全字段合法的基准对象，**逐个字段**做三态变异（删除 / 类型错 / 值为空），每态一条用例；再加四条结构性用例（非对象 / `null` / 数组 / 嵌套错误）。

`isNodeMeta` 的 **8** 个判别字段：`id`（string 且 `length > 0`）、`alias`、`host`、`user`、`database`、`port`（number）、`createdAt`、`ssh`（必须是 record）。`NodeMeta` 上另有 `group`/`tags`/`star`/`pinned`/`useCount` 五个**可选**字段，不参与判别（守卫不是白名单，需另配一条"额外字段被忽略"用例）。

特别值得单独覆盖的两条：
- `id: ''` —— 唯一有 `length > 0` 约束的字段，最容易被漏测
- `ssh: {}` vs `ssh: 'string'` vs `ssh: []` —— `isRecord` 显式排除数组，这个边界要锁

`isHistoryEntry` 的 5 个字段：`id`、`at`、`aAlias`、`bAlias`、`diffCount`（number）。

注意 `isHistoryEntry` 被 `main.ts:23` 直接 import 用于 IPC，所以它的判别矩阵**同时是 IPC 边界的安全测试**——用例命名应体现这一点。

### 三、路径与破坏性操作

三个路径函数的契约是**拼接规则**：

- `nodesFilePath(userDataDir?)` → `<dir>/nodes.json`
- `historyFilePath(userDataDir?)` → `<dir>/history.json`
- `resolveUserDataDir()` → 显式参数 > `SQLDIFF_USER_DATA_DIR` 环境变量 > 回落路径

注意这几个函数**接受可选参数**（`userDataDir?`），所以要覆盖"不传参时读环境变量"这条路径。测试用 `vi.stubEnv` 隔离环境，避免受开发者本机环境影响——这正是它们需要直测的原因：`resolveUserDataDir` 的环境变量优先级如果写反，E2E 会把节点写到错误的目录，而任何现有断言都不会发现。

`clearHistory` 覆盖两条：**文件存在 → 写空数组**（`store-json.ts:122-124`，不是删文件）；文件不存在 → **不抛**（幂等，且顺带建目录）。判别口径用"读回为空"而非"文件是否还在"，这样断言的是调用方可观察的语义。

## 变异测试自证（AC7）

三个高危目标各做一次：

| 变异 | 期望 |
|---|---|
| `escapeDataIdent` 的 `replace(/`/g, '``')` → `replace(/`/g, '')` | 注入防线用例变红 |
| `isNodeMeta` 删掉 `id.length > 0` | 对应用例变红 |
| `isHistoryEntry` 把 `typeof v.diffCount === 'number'` 改成 `!== undefined` | 对应用例变红 |

只跑绿不算验证过——必须看到红。

## 风险

- **`vi.stubEnv` 忘记清理会污染同文件后续用例**：每个涉及 env 的 `describe` 配 `afterEach(() => vi.unstubAllEnvs())`
- **`testConnection` 可能真连网**：必须 mock 掉连接层，不能让测试尝试真实 TCP 连接（会慢且不稳定）
- **给已有测试文件追加用例时误改既有断言**：只追加，不修改现有内容

## 权衡

**不给 `diffTableField` 补大而全的 DDL 语料**：它的解析矩阵很大（17 种 `DdlOp` 已由 `classifyDdl` 的测试覆盖）。本任务只补**畸形输入不抛**这条边界——因为那才是 `diffTable` 间接覆盖不到的部分。补全语料属于"追认历史覆盖"，是本仓库明确排除的低价值工作。
