# Design — UI实测修单

## Boundaries

- `src-main/main.ts`：`session.defaultSession.on('will-download', (e, item) => { item.setSavePath(path.join(app.getPath('downloads'), item.getFilename())); })`，注册一次（app ready 内）。单测用假 session/item 断言 setSavePath 被调且文件名透传；真机 CDP 可信点击复验。
- `src-core/` 或 renderer 工具：`sanitizeIpcError(err: unknown): string`（纯函数，放 `src-core/` 供双端用；正则剥 `^Error invoking remote method '[^']*':\s*(Error:\s*)?`），`store.ts` 对比兜底 + conn 测试展示位调用。
- `App.tsx visibleNodes` + `LeftTab`：加 `'all'`，直通；Tab 栏加 [全部] 置首，store 默认 `leftTab: 'all'`（查现有默认值一并改）。
- 过滤重构（renderer + `compare-filter.ts`）：
  - 删维度行 UI + `DataDiffTable` 独立区段 + DML_TABS；数据行并入主 DiffTable（`extraItems` 合并逻辑保留，DML 模式切换逻辑删除，DML 空提示条保留并改文案为勾选数据指引）。
  - `ObjectTypeFilter` → `'ALL' | ObjectTypeWithData[]`（含 `'data'`；`postFilterResult` data 行改走对象集合判定，不再特殊 bypass）；`AspectFilter` → `'ALL' | StmtAspect[]`；空数组/全选视为 ALL（沿用 verb toggle 语义）。
  - `postFilterResult` options：`{objectTypes?, aspects?, verbs?}` 全数组化；AND 链 对象→动词→切面→关键字→Tab；`recountStats` 不变（按条目计）。
  - `toExportSql`/复制路径不动（已按条目）；`stmtKindFilter`/`dmlFilter` 状态删除（查全仓引用并清）。
- 兼容：IPC/`DiffItem` 不变；history 不变；stats 口径不变（条目计）。

## Data flow

对比 → items（含 data）→ 单表 + 多选过滤（对象/动词/aspect/Tab/关键字）→ 列表/复制/导出/统计同源。

## Tradeoffs

- 删维度行后 DML 专属区消失：数据行混入主表，靠对象“数据”chip + 动词 DML 组定位；DML 空提示条保留指引。代价：CHANGE Tab 下会出现数据 UPDATE 行（changeType 映射），属正交语义已定行为，可接受。
- 静默落盘 vs 另存对话框：选前者（现有 toast 文案与 0 改动面；对话框二期）。
- 默认 Tab 改全部：新节点可见优先；老用户多一次点击切历史，可接受（Q1 可 veto）。

## Rollout / rollback

- main 进程加 will-download 无副作用（此前无 handler）；回滚 revert 本任务文件。
