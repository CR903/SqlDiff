# 脚本DDL-DML-INDEX三维过滤

## Goal

生成脚本支持按 DDL / DML 维度查询，并新增 INDEX（索引）类目；筛什么复制什么（复制=所见），统计口径与所见一致。

## Background（已确认事实）

- `src-core/types.ts:62-75`：`DiffItem{objectType, changeType, dml?}`；结构四类全视为 DDL，`objectType==='data'` 为 DML。
- `src-core/classify.ts:18-27`：单条（或单对象多语句拼接）SQL 判 CREATE/DROP/CHANGE。
- `src-core/compare.ts:92-99`：表走 `diffTable`，**多条 ALTER 拼为单条目**（M4 压缩语义）；`toExportSql:137-153` 按条目导出。
- `src-core/compare-filter.ts:58-80`：后过滤 scopes + 表名子串；`recountStats:37-50` 重算口径。
- 现状问题：一表多 ALTER 拼一条，INDEX 无法精确筛——只打标会导致复制 INDEX 时带出列变更，违背复制=所见。

## Requirements

- R1 维度：新增 `StmtKind='DDL'|'DML'`（`objectType==='data'` 即 DML，其余 DDL），UI 一级维度切换 [全部/DDL/DML]，与现有 CREATE/DROP/CHANGE Tab、DML 三 Tab 正交组合。
- R2 语句级拆分：表条目按 `;\n` 拆为单语句条目（CREATE TABLE 内无分号，拆分安全；视图/过程/函数/数据条目保持原子），每条独立 `id={`${objectType}:${objectName}:${n}`)`、独立 classify + risk。
- R3 INDEX 类目：每语句打 aspect（`column|primary|index|table|routine`），UI 新增 INDEX 筛选 chip；INDEX 定义：`ADD/DROP INDEX|KEY|FULLTEXT|SPATIAL|UNIQUE INDEX` 及 `ADD/DROP PRIMARY KEY` 归 primary 不归 index（见 Q1）。
- R4 统计：`recountStats` 按拆分后条目重算；stats 新增 `INDEX` 计数（index-aspect 条数）；`toExportSql` 头注释 `[DDL:CREATE]` 之类保持 `[changeType]` 不变，条数=所见。
- R5 复制=所见：任意过滤组合下复制/导出内容与列表完全一致；空结果给空状态。
- R6 回归：既有单测按新口径更新（条目数变多属预期），`mysqldiff/` 零改动。
- R7 全部行按动词搜：`verbOf(sql)` 取首关键字（CREATE/DROP/ALTER/TRUNCATE/INSERT/UPDATE/DELETE/REPLACE→CREATE/OTHER），UI 在全部视图加动词 chips（DDL组 CREATE/DROP/ALTER＋DML组 INSERT/UPDATE/DELETE），与维度/aspect/Tab 正交 AND；TRUNCATE 引擎不产，无桶；INDEX 归 DDL（2026-09-22用户确认，Q3）。

## Acceptance Criteria

- [ ] 同一表“加列+加索引”变出两条：列条目 aspect=column，索引条目 aspect=index。
- [ ] 切 DDL 只见结构、切 DML 只见数据；INDEX chip 只见索引语句。
- [ ] 各组合复制内容与所见逐行一致；stats 计数=列表条数。
- [ ] 动词搜：CREATE 桶只见 CREATE 开头语句，ALTER 桶只见 ALTER（含列/主键/索引三类 ALTER），DML 三动词只见对应数据语句；chip 计数=过滤后条数。
- [ ] 三件套全绿。

## Out of Scope

- 例程（视图/过程/函数）语句拆分（DROP+CREATE 含 DELIMITER，不拆，aspect=routine）。
- 历史记录格式迁移（history 只记差异数，不受条目拆分影响）。

## Open Questions

- [x] Q1 INDEX口径（决议待用户确认）：`PRIMARY KEY` 增删归 primary 不归 index；`UNIQUE KEY/INDEX` 归 index。理由：主键约束与二级索引排查场景不同。若用户要合并，改一处正则即可。
- Q2 实施基线：small-enhance 有未提交改动（App.tsx/store.ts 等），本任务实现时以最新工作树为基，`npm test` 全绿为准。无阻塞。
- [x] Q3 INDEX归属：归 DDL（2026-09-22用户确认）；TRUNCATE 引擎不产，不设桶。
