# Design — DDL/DML/INDEX 三维过滤

## Boundaries

- `src-core/types.ts`：加 `StmtKind='DDL'|'DML'`、`StmtAspect='column'|'primary'|'index'|'table'|'routine'|'data'`；`DiffItem` 加 `stmtKind: StmtKind`、`aspects: StmtAspect[]`（单语句条目恒 1 个，保留数组为以后多语句合并留余）；`CompareStats` 加 `INDEX: number`。
- `src-core/diff.ts`：不改 diff 语义，新增 `splitStatements(tableSql: string): string[]`（按 `/;\s*\n/` 切，补回 `;`，过滤空块；仅表条目调用）。
- `src-core/compare.ts`：`makeItem` 拆为 `makeItems(objectType, objectName, sql)`——表 sql 先 split，每语句独立 classify + assessRisk + aspect（`aspectOf(stmt)`）；id 后缀 `:s<n>`；排序：同表同组语句按原顺序稳定（sortDiffItems 加 `seq` 隐式键：先按现有键，末级按 id）。
- `src-core/classify.ts`：加 `aspectOf(stmt)`：`/\bADD\s+(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(INDEX|KEY)\b/i` 或 `DROP INDEX|KEY` → index；`PRIMARY KEY` → primary；`ADD/DROP/CHANGE/MODIFY COLUMN` → column；`CREATE TABLE`/`DROP TABLE` → table；其余 routine/data 由调用方定。再加 `verbOf(stmt): 'CREATE'|'DROP'|'ALTER'|'INSERT'|'UPDATE'|'DELETE'|'OTHER'`（首关键字匹配，`CREATE OR REPLACE`→CREATE，DELIMITER 块→OTHER；TRUNCATE 预留映射但引擎不产）。
- `src-core/compare-filter.ts`：`postFilterResult` 加参 `{stmtKind?: 'ALL'|'DDL'|'DML', aspect?: 'ALL'|StmtAspect, verbs?: 'ALL'|Verb[]}`（AND 链：维度→对象→动词→aspect→Tab/关键字）；data 行 stmtKind 恒 DML；`recountStats` 计 INDEX。
- `src-renderer`：维度切换 [全部/DDL/DML] + INDEX chip（与 CREATE/DROP/CHANGE、DML 三 Tab 正交，状态进 store，走同一 items 引用保证复制=所见）。全部视图加动词 chips 行（DDL组 CREATE/DROP/ALTER＋DML组 INSERT/UPDATE/DELETE，计数由当前维度过滤后列表现算），与维度/aspect/Tab/关键字正交 AND。
- 兼容：`toExportSql` 不变（已按条目导出）；history 不变；IPC 契约不变（DiffItem 加字段为增量兼容）。

## Data flow

compareRun（拆分打标）→ store 全量 items → filter（维度+aspect+既有条件，纯函数）→ 列表/复制/导出同源 → stats 重算。

## Tradeoffs

- 拆分 vs 打标：选拆分。打标需复制时切片 SQL，多一套代码路径且易与格式化冲突；拆分后过滤/复制/统计走同一条目模型，测试断言更直接。代价：条目数变多（M7 的 521 口径作废，以新口径为准）。
- PRIMARY 不归 INDEX：排查场景不同（约束 vs 索引性能），Q1 已定。

## Rollout / rollback

- 只读展示层+纯函数变更，不碰连接/存储；回滚即 revert 本 tasks 改动文件，`mysqldiff/` 未动。
