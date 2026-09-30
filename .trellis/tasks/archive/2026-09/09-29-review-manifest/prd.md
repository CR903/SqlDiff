# P0 Review Manifest v1（版本化无秘密）

- 父任务：`.trellis/tasks/09-29-review-evidence-chain`
- 前置：`09-29-result-source-state`（source/coverage 契约）、`09-29-grant-blindness-false-drop`（visibility 契约）均已归档
- 后续：`09-29-compare-service-integration-tests` 依赖本任务定稿的产物形状

## Goal

把一次「真实比较」变成**可保存、可复比、可交接、可追责**的审查证据：定义并实现 versioned、无秘密的 run manifest，含覆盖状态分类与脱敏 JSON/Markdown 导出，不提供 SQL 执行入口。

对应路线图 `roadmap.md` §5.1 步骤 3 与 Phase 1 最小闭环：用户能完成「保存 → 复比 → 交接」，能解释 skipped / unknown 的含义。

## Background / Confirmed Facts

### 1. 契约已就绪（前两个子任务的产出）

`CompareResult`（`apps/desktop/src-core/types.ts:275-293`）已携带：

| 字段 | 类型 | 语义 |
|---|---|---|
| `items` | `DiffItem[]` | 含 `objectType` / `objectName` / `changeType` / `aspects` / `risk` / `sql` / `rollback` / `explain` |
| `stats` | `CompareStats` | ALL / CREATE / DROP / CHANGE / INDEX / DML |
| `dataTables` | `DataTableStatus[]` | 数据对比逐表状态（含 reason） |
| `source` | `ResultSource` | real / demo（缺省视为 real） |
| `coverage` | `StructureCoverage` | `ok` 计数 + `skipped`（含 reason：permission-denied / object-missing / aborted / unknown） |
| `visibility` | `CompareVisibility` | `excluded`（grant-invisible）+ `compared` + `reliable` |

### 2. 数据侧已有覆盖状态词汇可复用

`DataTableStatusKind`：pending / running / done / skipped / error / confirm-needed；`reason`：no-pk / pk-mismatch / over-threshold / fetch-failed / aborted（`types.ts:153-168`）。这与结构侧 `CoverageReason` 是两套词汇，manifest 需要一个统一的汇总层。

### 3. 导出基础设施已存在

- `downloadJsonFile(filename, text)` / `downloadTextFile(filename, text, mime)`（`apps/desktop/src-renderer/sql.ts:101-124`）
- DBeaver 导出模式：IPC handler 返回 `{ fileName, content, exportedCount, warnings }`，renderer 用 `downloadJsonFile` 落盘（`dbeaver-export.md:22-46`）

### 4. 历史存储现状

`HistoryEntry`（`types.ts:113-123`）只存摘要（id / at / aAlias / bAlias / diffCount），存 `history.json`，只留最近 20 条（`store-json.ts:13`）。**不含结果、覆盖、可见性或来源。**

### 5. 保密边界

`nodes.json` 不含秘密；密码/密钥走 vault（`store-json.ts:1-5`）。DBeaver 导出契约明确 `save-password: false` 且不调用 Vault（`dbeaver-export.md:54-55`）。manifest 必须遵循同样边界。

### 6. 秘密与行值约束（父任务 AC3）

父任务要求「没有任何机器可读产物包含 secret 或未经裁定的行值」。manifest 的字段级裁决必须显式，不得默认全量输出 DDL/DML 行值。

## Requirements

### R1 可保存的 run manifest

- 一次真实比较（`source: 'real'`）的结果可导出为 versioned、无秘密的 JSON 文件。
- 包含：schema 版本、工具版本、时间、A→B 方向、scopes/options/映射、输入 fingerprint、结果（DiffItem）、风险/回滚提示、覆盖报告、可见性报告。
- **不含**：密码、私钥、passphrase、Vault 密文、连接串原文、未经裁定的行值。

### R2 覆盖状态统一分类

- 提供 `CoverageStatus` 汇总：结构侧 + 数据侧 + 可见性的统一视图。
- 至少区分：成功、权限失败、无行身份、超阈、取消、错误、不可见对象。
- 不得只表达「有差异」。

### R3 脱敏 JSON/Markdown 导出

- 同一 manifest 可导出为 JSON（机器可读）与 Markdown（人工交接）。
- 行值默认脱敏；是否放行由字段级裁决显式记录，不得默认全量输出。
- 导出物不提供 SQL 执行按钮。

### R4 无执行入口

- 全链无写库路径、无 SQL 执行入口；`mysqldiff/` 不动。

## Acceptance Criteria

- [ ] AC1 一次真实比较可导出 JSON manifest，文件为合法 JSON、schema 版本号可解析。
- [ ] AC2 导出物不含任何秘密或未经裁定的行值；数据 DML 的行值已脱敏，且脱敏器有单测覆盖字符串/数字/日期/Buffer/NULL。
- [ ] AC3 导出物可被解析回 `CompareResult` 的语义（或等价表示），可重新展示。
- [ ] AC4 manifest 有显式 schema 版本，版本升级路径有测试覆盖。
- [ ] AC5 覆盖状态统一分类（`CoverageStatus` 枚举 + 计数）区分：成功、权限失败、无行身份、超阈、取消、错误、不可见对象。
- [ ] AC6 Markdown 导出含头部 + 差异摘要表 + 覆盖/可见性说明 + 保密声明，可用于人工交接。
- [ ] AC7 无 SQL 执行入口；`mysqldiff/` 未改动。
- [ ] AC8 typecheck / lint / test / build 四件套全绿。

## Out of Scope

- 账号、RBAC、审批、审计、云端服务。
- 人工标记「接受/排除/待确认」的交互界面（属后续报告工作台）。
- 自动保存/持久化到 userData（Q1 已定：仅导出下载）。
- baseline / 漂移。
- headless CLI / CI 退出码（依赖本任务定稿的 manifest 合同，单独排期）。
- 5–8 人用户实验（属路线图 Phase 1 验证，不在本代码任务内）。

## Open Questions

- ~~Q1 持久化范围~~ **已定**：仅导出下载（用户手动触发 JSON/Markdown 下载，不写入应用 userData）。「复比」留给后续报告工作台。
- ~~Q2 行值脱敏~~ **已定**：结构 DDL 全量保留；数据 DML 行值脱敏（字符串→`***`、数字→0 等），保留语句骨架。`sqlLiteral` 层做掩码最干净。
- ~~Q3 CoverageStatus 形态~~ **已定**：统一枚举 + 计数（`ok` / `permission-denied` / `no-row-identity` / `over-threshold` / `aborted` / `error` / `grant-invisible`），各层来源映射到该枚举。
- ~~Q4 Markdown 报告内容~~ **已定**：头部 + 摘要表 + 覆盖/可见性说明 + 保密声明（含 DDL 代码块，DML 脱敏）。

## Key Decisions

| # | 决策 | 依据 |
|---|---|---|
| Q1 | 仅导出下载，不引入存储层 | 路线图 Phase 1「先支持本地文件和工单/聊天交接」 |
| Q2 | DDL 全量 + DML 脱敏 | `sqlLiteral` 直接序列化真实行值（`data-diff.ts:49-68`），违反 AC3；DDL 是 schema 对比核心价值 |
| Q3 | CoverageStatus 统一枚举 + 计数 | 路线图「覆盖状态必须区分：成功、权限失败、无行身份、超阈、取消、错误」正好是枚举集合 |
| Q4 | Markdown：头部+摘要表+覆盖说明+保密声明 | `toExportSql` 头部（`compare.ts:160-171`）可复用 |

## Notes

- 依据：`.trellis/tasks/archive/2026-09/09-24-product-expansion-roadmap/roadmap.md` §5.1、Phase 1。
- 前置任务产出的类型与 spec 已合并到 `main` 分支（`c72df06`、`0543029`）。