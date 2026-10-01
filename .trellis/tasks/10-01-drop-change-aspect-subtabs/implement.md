# Implement — DROP / CHANGE Tab 按切面分子标签

## 前置检查

- [ ] `python3 ./.trellis/scripts/task.py current --source` 指向本任务
- [ ] `prd.md` / `design.md` 已获用户批准
- [ ] 工作区干净：`git status --short` 无输出
- [ ] 基线门禁通过（改动前先跑一次便于对比）：
      `cd apps/desktop && npm run typecheck && npm run lint && npm test`

## Step 1 — 定义 Tab→切面作用域表

- [ ] `src-core/compare-filter.ts` 新增 `ASPECT_SCOPES`（DROP / CHANGE 两个键，内容见 design.md §2）
- [ ] 注释写明来源：实测 (Tab × 切面) 矩阵，依据 `aspects` 恒为单元素
      （`compare.ts:42` + `diff.test.ts:268`），确保后人知道这不是拍脑袋的枚举
- [ ] `countAspects` 保持现有签名（它本就接受条目列表，无需改动）

**验证点**：`npm test` 应**零失败**（纯新增导出）。

## Step 2 — 改造 App 的筛选链

- [ ] `App.tsx` 新增 `byTab` 中间层：`diffFilter === 'ALL' ? byAspect : byAspect.filter(changeType === diffFilter)`
- [ ] `aspectCounts` 改为 `countAspects(byTab)`（原为 `countAspects(byObj)`），
      保证计数回答「点了这个子标签会得到几条」
- [ ] 删除 1050e1a 引入的 `ASPECT_CHIPS` 常量与全局 chip 渲染分支（R5）

**验证点**：`npm test` 仍零失败；`npm run typecheck` 通过（若有 prop 残留未删会报 unused）。

## Step 3 — 渲染作用域化子标签行

- [ ] 在 Tab 行之后、对象 chips 行之前插入 `ASPECT_SCOPES[diffFilter]` 渲染
- [ ] `diffFilter` 不在 `ASPECT_SCOPES` 中（全部 / CREATE）时整行不渲染（R3）
- [ ] 计数为 0 的子标签显示但 `disabled`，不隐藏（design.md §4）
- [ ] 每个子标签 tooltip 写明作用域，避免被误解为跨 Tab 生效
- [ ] 复用 `.obj-filters` / `.chip`；若确需新样式再最小化补到 `styles.css`

**验证点**：无变化（纯 JSX 增量），`npm test` 零失败。

## Step 4 — Tab 切换时清理不可用切面（R8）

- [ ] 加 `useEffect`：Tab 变化时把 `aspectFilter` 裁剪到新 Tab 的可用集，
      裁剪后为空则 `setAspectFilter('ALL')`（代码见 design.md §3）
- [ ] 确认 `store.ts` 的 `setAspectFilter` 已存在；若只有 `toggleAspect`，需补 setter

**验证点**：`npm test` 零失败。

## Step 5 — 新增/调整测试

- [ ] `src-core/aspect-count.test.ts` 扩展：`countAspects` 对 `table` / `routine` / `data` 三桶也能计数
      （现有测试只覆盖 index/primary/column，且断言这三桶「不计入」——
      需改为「可计入但不属于 chip 作用域」，见下方注意事项）
- [ ] 新增 `ASPECT_SCOPES` 的完整性测试：
      - DROP 键含且仅含实测的 5 种切面；CHANGE 键含且仅含 5 种；
      - 无 `全部` / `CREATE` 键
- [ ] 若把切面作用域逻辑抽为纯函数（如 `pruneAspectFilter(sel, tab)`），
      为它写单测：DROP·表→CHANGE 得 `ALL`；DROP·(表+索引)→CHANGE 得 `[index]`；
      DROP→CREATE 得 `ALL`

**注意事项（易错）**：1050e1a 的 `aspect-count.test.ts` 里有两条测试断言
「table/routine/data 三桶不计入 chip」。本任务改变了这一定义——
子标签需要这三桶的计数。**必须同步更新这两条测试并在注释中写明定义已变**，
不得为了保绿而扭曲实现。

## Step 6 — 全量质量门

- [ ] `cd apps/desktop && npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`（全绿；总数 ≥ 336 + 本次新增）
- [ ] `npm run build`
- [ ] `cd ../.. && git status --short` 确认只动了预期文件

## Step 7 — 端到端验证（CDP，真实 Electron）

无头环境连不上真实 MySQL，需用 demo 数据或注入条目验证：

- [ ] 真实点击 Tab，确认子标签行在 DROP/CHANGE 出现、在 全部/CREATE 消失（AC1–AC3）
- [ ] 点 `DROP + 表`，断言结果只剩表级删除，换主键与删索引条目已排除（AC4）
- [ ] 点 `DROP + 主键` 后切到 `CHANGE`，断言结果非空且无残留过滤（AC6，最易出错的路径）
- [ ] 记录 Tab 计数与改动前一致（AC8）

## Step 8 — Spec 同步（Phase 3.3）

- [ ] `.trellis/spec/frontend/quality-guidelines.md`：现有「切面多选」描述需更新为
      Tab 作用域子标签；注明全局切面 chip 已移除
- [ ] `.trellis/spec/backend/quality-guidelines.md:35` 的 classify 规则**本次不变**
      （本方案不动核心），仅需确认无需改动
- [ ] `grep -rn "INDEX" .trellis/spec` 检查无失效引用

## 风险点与回滚锚点

| 位置 | 风险 | 回滚方式 |
|---|---|---|
| `App.tsx` chip 渲染段 | 误删对象 chips 或动词 chips（相邻代码） | 单文件 `git checkout -- src-renderer/App.tsx` |
| `aspectCounts` 基数 | 若误用 `byObj`，计数将回答错误的问题 | 改回 `byTab`，AC5 会失败暴露 |
| R8 清理 effect | 若漏做，AC6 失败（静默空列表） | Step 4 单独回滚 |
| `aspect-count.test.ts` 旧断言 | 误把「三桶不计入」当不可动摇的规则 | 同步更新测试并写明定义变更理由 |

整体回滚 = `git revert <commit>`：纯展示层改动，无数据写入、无迁移、无残留状态。

## 提交前自检

- [ ] commit message 写清**筛选入口变了什么**，不写「按用户反馈」等无信息量措辞
- [ ] 已知取舍（删除全局 chip、全部/CREATE 无切面入口）已写入 commit message 或 prd
- [ ] 未声称做了实际未做的验证（CDP 端到端若未跑通，不得写「已验证」）