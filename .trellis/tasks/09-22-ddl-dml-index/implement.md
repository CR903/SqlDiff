# Implement — DDL/DML/INDEX 三维过滤

## Checklist（顺序）

- [ ] I1 类型：types.ts 加 StmtKind/StmtAspect/DiffItem.stmtKind+aspects/CompareStats.INDEX（保持 IPC 增量兼容）。
- [ ] I2 拆分+打标：diff.ts `splitStatements`；classify.ts `aspectOf`；compare.ts `makeItems`（表拆分，例程/数据原子），排序稳定（同表语句保序）。
- [ ] I3 过滤统计：compare-filter.ts 维度+aspect 参数，recountStats 计 INDEX；更新受影响单测期望（条目数变多属预期，逐条核对非盲改）。
- [ ] I4 UI：store 加维度+aspect 状态；维度切换 [全部/DDL/DML] + INDEX chip，与既有 Tab 正交；复制/导出走同一过滤引用。
- [ ] I5 单测新增：拆分（加列+加索引一表两条）、aspect 判定（index/primary/column/table 各 2 例）、维度过滤组合、复制=所见（过滤后导出文本逐行断言）。
- [ ] I6 全量回归：`npx tsc --noEmit` + `npm run lint` + `npm test`（apps/desktop）；`mysqldiff/` 零改动复查。

## Validation

- `cd apps/desktop && npx tsc --noEmit && npm run lint && npm test`
- 手工：mock 双节点跑一次结构对比，切 DDL/DML/INDEX 逐项核对列表=复制内容。

## Risky files / rollback

- `compare.ts`（排序/ID 变更面最大，改前先跑现有单测留基线）、`App.tsx`/`store.ts`（与 small-enhance 未提交改动同文件，以工作树最新版为基，冲突先合 small-enhance）。
- 回滚：`git checkout -- apps/desktop`（本任务文件清单外无其他改动时）。
