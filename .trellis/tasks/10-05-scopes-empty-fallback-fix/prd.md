# 修复 scopes 空回落：数据单独对比被静默放大

## Goal

用户取消勾选全部结构类型、只保留「数据」对比时，系统必须只跑数据对比；当前实现会把四种结构类型全部跑完，而界面与历史记录都显示成只跑了数据。这是**只读工具里的静默越权**：用户没勾的东西被执行，且事后无法从 UI 或历史发现。

## Background（已确认事实 · 2026-10-05 实测代码路径）

完整触发链：

1. `store.ts:341` `toggleScope` 取消最后一个结构类型 → `scopes = []`
2. `store.ts:376` 用户保留勾选「数据」→ `includeData = true`
3. `store.ts:577` 门禁 `if (s.scopes.length === 0 && !s.includeData)` 判 false → **放行**
4. `store.ts:609` 发出 `scopes: includeData ? [...scopes, 'data'] : scopes` → 请求为 `['data']`
5. `compare-filter.ts:21-27` `normalizeScopes(['data'])`：`'data'` 不是结构 `ObjectType` → `kept = []` → 走 `kept.length > 0 ? ... : [...ALL_SCOPES]` → **回落到四类全开**
6. `filterMetadataByScopes` 收到全开 scopes → `compareRun` 产出全部结构差异

佐证（为什么难发现）：

- 界面进度与结果都表现为"数据对比"，没有结构差异的视觉异常提示
- `store.ts:646` `lastComboText` 写的是 `${scopes.join('/')}${includeData ? '/data' : ''}`，此时 `scopes` 为空 → 显示成 `· /data`，**日志与历史也看不出实际跑了全结构**

发现路径：本仓库 `10-04-test-gap-backfill` 补测任务中，`tests/core/compare-filter-scope.test.ts` 为 `normalizeScopes` 补对抗用例时暴露。按该任务 R6（纯测试任务不改产品码）只记录为 P1，未修。

## 用户决策

**Q1（已定）**：允许"数据单独对比"。用户取消全部结构类型、只留数据，是合法操作，系统应尊重选择而不是替用户补全。

## Requirements

- [ ] R1 `normalizeScopes` 区分两种"空"：
  - **显式空**（`[]` 或仅含 `'data'` 等非结构项的数组）→ 返回 `[]`，不补全
  - **无有效输入**（`null` / `undefined` / 非数组 / 数组内全为非法值）→ 仍回落 `ALL_SCOPES`（IPC 边界 fail-safe 不得因修复而退化）
- [ ] R2 `runCompare` 门禁保持"至少勾选一个范围"，但需覆盖"只勾数据"这一合法态（当前逻辑已放行，确认无需改；若改则同步文案）
- [ ] R3 `lastComboText` 如实反映实际执行范围：结构范围为空时不输出误导性的 `/data` 前导斜杠，应显示为仅 `data`
- [ ] R4 回归测试（按 `quality-guidelines.md` 门禁，每个功能必须带测试）：
  - `normalizeScopes(['data'])` → `[]`
  - `normalizeScopes([])` → `[]`
  - `normalizeScopes(null / undefined / 42 / 'table' / {} / [true, 123])` → `ALL_SCOPES`（fail-safe 不退化）
  - `normalizeScopes(['table','data','view'])` → `['table','view']`（去重且剔除 data）
  - `filterMetadataByScopes(meta, [])` → 四类全空（下游不产结构差异）
  - 数据单独对比的端到端语义：`compareRun` 在 `scopes=[]` + `includeData=true` 时只产 DML 差异
- [ ] R5 不改 `mysqldiff/`；不改数据库查询与只读边界

## Acceptance Criteria

- [ ] AC1 用户取消全部结构类型 + 只勾数据 → 结果只含 DML 差异，无结构差异
- [ ] AC2 `normalizeScopes` 对 `null`/`undefined`/非数组/全非法数组仍回落 `ALL_SCOPES`（fail-safe 未退化）
- [ ] AC3 `lastComboText` 不再出现误导性的 `· /data` 形态
- [ ] AC4 新增回归用例全绿；`npx vitest run` 无回归（原 723 项不减）
- [ ] AC5 `npm run typecheck` / `lint` / `build` 全绿
- [ ] AC6 `mysqldiff/` 零改动

## Out of Scope

- 过滤/切面（aspect）筛选的其他语义问题
- `postFilterResult` 的统计口径
- 数据对比的阈值、批次等既有参数

## Key Decisions

- Q1 已定：数据单独对比合法 → R1 采用"显式空不补全、无效输入仍全开"的双语义
- 修在 `normalizeScopes` 而非 UI 拦截：IPC 请求可绕过 UI，且 `compare-run.ts` 也有独立调用路径

## Open Questions

无。
