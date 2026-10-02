# DROP / CHANGE Tab 按切面分子标签

## Goal

让用户在 DROP / CHANGE Tab 内按「改的是什么」进一步细分，直接解决真实场景中
`勾选 DROP + 表` 却把 `DROP TABLE` 与 `ALTER TABLE … DROP PRIMARY KEY, ADD PRIMARY KEY(…)`
混在一起、范围模糊且无从区分的问题。

同时对 CHANGE Tab 做对称细分，使「先选变更类型、再选对象类别」成为一致的筛选路径。

## Background（仓库证据）

### 引擎只会生成 10 种语句形态

来源 `apps/desktop/src-core/diff.ts:60,142,146,149,152,153,155,164,169,234`。实测逐条判定：

| # | 形态（逐字取自 diff.ts） | Tab | 切面 | 风险 | 动词 | 执行后果 |
|---|---|---|---|---|---|---|
| 1 | `DROP TABLE \`t\`;` | DROP | table | high | DROP | 删表 + 全数据 |
| 3 | `ALTER TABLE \`t\` DROP COLUMN \`c\`;` | DROP | column | high | ALTER | 丢该列数据 |
| 4 | `ALTER TABLE \`t\` CHANGE COLUMN …` | CHANGE | column | medium | ALTER | 类型变更 |
| 5 | `ALTER TABLE \`t\` ADD PRIMARY KEY …` | CHANGE | primary | low | ALTER | 新增约束 |
| 6 | `ALTER TABLE \`t\` DROP PRIMARY KEY;` | DROP | primary | high | ALTER | 表与数据在，仅失去主键约束 |
| 7 | `ALTER TABLE \`t\` DROP PRIMARY KEY,ADD PRIMARY KEY (…);` | DROP | primary | high | ALTER | 原子换主键，无任何损失 |
| 8 | `ALTER TABLE \`t\` ADD INDEX …` | CHANGE | index | low | ALTER | 新增索引 |
| 9 | `ALTER TABLE \`t\` DROP INDEX \`idx\`;` | DROP | index | low | ALTER | 仅影响性能 |
| 10 | `DROP VIEW/PROCEDURE/FUNCTION \`x\`;` | DROP | routine | medium | DROP | 删对象 |
| 10 | `DROP+CREATE` 例程重建 | CHANGE | routine | medium | DROP | 重建，可回滚 |
| — | `INSERT/UPDATE/DELETE` 数据行 | CHANGE | data | — | INSERT/… | 行级差异 |

### 方案地基：`aspects` 恒为单元素，(Tab, 切面) 是无歧义分区

- `src-core/compare.ts:42`：`aspects: [aspectOf(sql, …)]` —— 永远只放一个切面；
- `src-core/diff.test.ts:268` 已断言 `expect(item.aspects).toHaveLength(1)`；
- 数据行固定 `aspects: ['data']`（`aspect-index.test.ts:134`）。

实测 (Tab × 切面) 矩阵：

```
DROP   → { table, column, primary, index, routine }
CHANGE → { column, primary, index, routine, data }
```

每个 Tab 内的切面构成完整分区，因此「Tab 内按切面分子标签」不会产生歧义或遗漏。

### 过滤链已存在，本任务不改核心

`src-renderer/App.tsx:1827-1838` 已有 `aspSet → byAspect → counts` 完整链路，
`postFilterResult` 也已支持 `aspects` 选项。缺的只是「把切面筛选的入口按 Tab 作用域化」。

### 前置已完成与需撤回的部分（commit 1050e1a）

1050e1a 补了全局切面 chip（`INDEX / 主键 / 列`，跨 Tab 生效），
并抽出纯函数 `countAspects`（`src-core/compare-filter.ts`）。

本次决策：**删除那三个全局 chip**（与子标签功能重叠，共存会让人不知该点哪个），
**保留 `countAspects`**（改为按当前 Tab 作用域计数，正是子标签所需的）。

### 一处需要撤回的先前判断

上一轮我称「`DROP INDEX` 归 DROP 但 `DROP KEY` 归 CHANGE，是硬伤」。
实测证明**引擎从不生成 `DROP KEY`**（`diff.ts:169` 只产 `DROP INDEX`），
该不一致仅对手写 SQL 存在，不影响本产品输出。不在本次范围。

## Requirements

- **R1**：选中 `DROP` Tab 时，显示该 Tab 的切面子标签：表 / 列 / 主键 / 索引 / 例程。
- **R2**：选中 `CHANGE` Tab 时，显示该 Tab 的切面子标签：列 / 主键 / 索引 / 例程 / 数据。
- **R3**：选中 `全部` 或 `CREATE` Tab 时**不显示**子标签行。
  （实测 CREATE Tab 的切面只有 `table` 与 `routine`，细分收益低，本次不做。）
- **R4**：子标签计数必须反映**当前其他过滤条件**（对象 chips / 动词 / 关键字）下的结果，
  且**不以自身为基数**——否则数字无法回答「我点了会得到几条」。
- **R5**：删除 1050e1a 引入的全局 `INDEX / 主键 / 列` chip 及其渲染分支。
- **R6**：保留 `countAspects` 纯函数，改为接受作用域内的条目列表；
  新增「按 Tab 作用域筛选可用切面」的能力。
- **R7**：子标签为多选 OR（组内任一命中即保留），与既有 chips 语义一致；
  空选或全选等同 `ALL`。
- **R8**：**切换 Tab 时必须清理不可用的切面选择**。例如在 `DROP` 下选了「表」，
  再切到 `CHANGE`（无 `table` 切面），若不清理会出现「结果为空且无任何可见筛选指示」的静默空列表。
- **R9**：不改动 `classify` / `aspectOf` / `assessRisk` / `verbOf` 任何核心分类或风险判定；
  统计口径（各 Tab 条数）保持与改动前完全一致。
- **R10**：子标签与对象 chips、动词 chips 正交，筛选行为沿用既有 `byObj → byAspect` 链。

## Acceptance Criteria

| ID | 验收项 | 判定方式 |
|---|---|---|
| AC1 | 选中 DROP Tab 时显示 5 个子标签：表/列/主键/索引/例程 | 单测断言渲染出的标签集合 |
| AC2 | 选中 CHANGE Tab 时显示 5 个子标签：列/主键/索引/例程/数据 | 单测断言渲染出的标签集合 |
| AC3 | 选中 全部 / CREATE Tab 时不显示子标签行 | 单测断言该行不渲染 |
| AC4 | `DROP + 表` 只剩 `aspects` 含 `table` 的条目（形态 1），换主键/删索引不再混入 | 单测断言 `DROP TABLE` 在内、`SWAP PRIMARY KEY` 与 `DROP INDEX` 不在内 |
| AC5 | 子标签计数随对象/动词/关键字过滤变化，且自身不参与计数基数 | 单测：加对象过滤后某子标签计数下降 |
| AC6 | 切换到不含该切面的 Tab 时，不可用选择被清理，不产生静默空列表 | 单测：DROP·表 → 切 CHANGE 后结果非空且无残留过滤 |
| AC7 | 删除全局 INDEX/主键/列 chip 后，切面筛选入口仅剩子标签 | 单测 + 人工确认 UI 无重复入口 |
| AC8 | 改动前后各 Tab 的条目数完全一致（R9：不改统计口径） | 单测锁定 `recountStats` 输出不变 |
| AC9 | typecheck / lint / test / build 通过 | 命令实跑 |

## Key Decisions

- **D1（用户决策，2026-10-01）**：采用「Tab 内按切面分子标签」，
  **放弃**先前规划中的「重定义 DROP 语义为破坏性操作」。
  理由：不动核心分类、不改统计口径、不隐藏任何条目，且 DROP 与 CHANGE 对称。
- **D2（用户决策）**：删除 1050e1a 的全局切面 chip，避免与子标签功能重叠造成困惑。
  已知代价：`全部` / `CREATE` Tab 下不再有切面筛选入口，需切到具体 Tab 查看。
- **D3（用户决策）**：DROP 子标签列出全部 5 种切面（表/列/主键/索引/例程），
  不遗漏主键与例程。
- **D4**：子标签仅作用于 `DROP` 与 `CHANGE`；`CREATE` 的切面只有 table/routine，
  细分收益低，本次不做（见 R3）。
- **D5**：子标签为多选 OR，与既有 chips（对象/动词/切面）语义统一，避免引入第二套交互模型。

## Out of Scope

- `classify` / `aspectOf` / `assessRisk` / `verbOf` 任何改动——本方案刻意不动核心。
- 各 Tab 的统计口径——刻意保持不变。
- `DROP KEY` vs `DROP INDEX` 正则不一致——引擎不产该 SQL，见 Background。
- 审查报告（manifest）schema——`aspects` 字段已在导出物中，无需变更。
- `全部` / `CREATE` Tab 的子标签——见 D4。
- Tab 能否多选（当前单选）——本次不引入多 Tab。

## Risks

- **静默空列表**：若不做 R8 的切面清理，用户会遇到「结果为空但看不到为什么」。
  这是本任务最主要的失败模式，已列为独立需求与验收项。
- **筛选器行数变化**：删除全局 chip 后行数减少，但 DROP/CHANGE 下多出一行子标签，
  整体高度基本持平。
- **认知切换**：原先 chip 行位置现在只在 DROP/CHANGE 时有内容，用户需适应
  「同一行在不同 Tab 显示不同标签」。缓解：子标签行带 `Tab 名 + 切面名` 的 tooltip 说明作用域。
- **能力回退（D2 已接受）**：`全部` Tab 下无法按切面过滤。

## Open Questions

无。阻塞性产品决策已全部关闭（D1–D5）。