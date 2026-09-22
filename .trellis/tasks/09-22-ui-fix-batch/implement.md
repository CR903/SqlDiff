# Implement — UI实测修单

## Checklist（顺序）

- [ ] I1 will-download：main.ts 注册 handler（setSavePath downloads/filename）；单测假 session/item；CDP 可信点击复验文件落盘+内容一致。
- [ ] I2 消毒：`sanitizeIpcError` 纯函数+单测（Electron 前缀/双 Error/纯中文/非 Error 输入）；store 对比兜底 + conn 展示位接入。
- [ ] I3 全部 Tab：LeftTab 加 all + visibleNodes 直通 + 默认 leftTab 改 all；单测 tabs 过滤。
- [ ] I4 过滤重构：ObjectTypeFilter/AspectFilter 数组化（含 data）；删维度行 + DataDiffTable 区段 + DML_TABS；DML 提示条保留；postFilterResult 新参；更新受影响单测（逐条核对）；复制=所见逐行断言。
- [ ] I5 全量回归：`cd apps/desktop && npx tsc --noEmit && npm run lint && npm test`；`mysqldiff/` 零改动复查；CDP 可信点击走一遍导出/组合/全部 Tab。

## Validation

- `cd apps/desktop && npx tsc --noEmit && npm run lint && npm test`
- 真机：可信点击导出落盘；种子对比中文报错；新建节点左侧全部可见。

## Risky files / rollback

- `store.ts`/`App.tsx`（过滤状态改形，大面积引用，先 grep 全量调用点再改）。
- `main.ts`（will-download 注册位置放 app ready 内已有 session 逻辑旁）。
- 回滚：`git checkout -- apps/desktop`（本任务文件清单外无其他改动时）。
