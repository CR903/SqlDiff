# UI实测修单：导出落盘+错误文案+节点库全部+筛选去重

## Goal

修复真机实测抓到的 1 个 P0 + 2 个 P1，并按用户要求把筛选去重到最细粒度多选。全部实证可复验（CDP 可信点击）。

## Background（实测证据）

- P0（实证）：可信点击“导出 .sql”后 `Page.downloadWillBegin→inProgress→1244/1244` 永久挂起，`~/Downloads` 无文件，而 toast 照报“已导出”。根因：`src-main/main.ts` 无 `will-download` 处理，默认行为不落盘。`src-renderer/sql.ts:102-115 downloadSqlFile` 本身无错。
- P1a（实证截图）：对比条/组合栏裸奔 `Error invoking remote method 'compare.run': Error: …`。源头：`store.ts:585-598` 把 `err.message` 原样拼进 `reason`/toast。种子节点不在 vault 时后端报错本身友好（`compare: A 槽节点不存在（n-prod），请重新选择`），只需剥前缀。
- P1b（实证）：左侧三 Tab 为历史=对比记录/我的=收藏/常用=频次（`App.tsx:60-71 visibleNodes`），新节点三处皆不可见，改/删/测够不着（仅 A/B 下拉可选）。
- 筛选冗余（用户确认）：首行 [全部/DDL/DML] 维度与底部动词拆分重复；`DataDiffTable` 的 DML_TABS 与 DML 动词 chips 重复。`ObjectTypeFilter`/`AspectFilter` 现为单选（store.ts:38-42），动词已多选。

## Requirements

- R1 导出必落盘：主进程注册 `will-download`，`setSavePath(downloads/filename)` 静默落盘（保持现有“无弹窗”体验）；仅当落盘成功才 toast“已导出”，失败 toast 报因。单测/手工：可信点击后文件存在且内容=预览文本。
- R2 错误文案消毒：新增 `sanitizeIpcError()`（剥 `Error invoking remote method '…'(: Error:)?` 前缀，取中文 message），用于对比兜底 reason/toast；其它 IPC 错误展示位同规则（conn 测试等，若有）。
- R3 左侧加“全部”Tab：`LeftTab` 加 `all`，`visibleNodes` 直通（仅关键字过滤），默认 Tab 改为全部（新节点立即可见可管）；历史/我的/常用语义不变。
- R4 筛选去重（最细粒度多选）：删首行维度 tabs + `DataDiffTable` 独立区段 + DML_TABS（动词 chips 已覆盖）；对象 chips 改多选（含数据）；aspect INDEX 改多选（与其它 aspect 默认 ALL 共存）；动词 chips 保持多选；各组内 OR、组间 AND；复制/导出/统计同源（复制=所见）；空状态保留。
- R5 回归：三件套绿；`mysqldiff/` 零改动。

## Acceptance Criteria

- [ ] 可信点击导出 → `~/Downloads/sqdiff_*.sql` 存在且与预览逐行一致；0 条时 toast“暂无可导出”且无文件。
- [ ] 种子对比失败只显示中文 message，无 `Error invoking` 前缀（组合栏+toast）。
- [ ] 新建节点后左侧“全部”立即可见，可改/删/测；默认 Tab 为全部。
- [ ] 无维度行；对象/动词/INDEX 均多选；CREATE Tab 与 CREATE 动词等组合复制=所见、计数=条数。
- [ ] 三件套全绿。

## Out of Scope

- 另存对话框（保持静默落盘体验，二期再议）；TRUNCATE 桶；历史记录格式迁移。

## Open Questions

- Q1 默认 Tab 改全部是否接受（改变老用户习惯，换来新节点可见）？默认接受，可 veto。
