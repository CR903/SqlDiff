# Implement — compare/data 应用服务集成测试

## 1. 测试辅助（`src-main/testing/` 或测试文件内联）

- [ ] 定义 `fakePool()`：`end: vi.fn().mockResolvedValue(undefined)`、`query: vi.fn().mockResolvedValue([[]])`
- [ ] 定义 `node(id, alias, database)`：形状对齐 `NodeMeta`（复用 `connection.test.ts` 的 baseNode）
- [ ] 定义 `fakeVault`：`{ getNodeSecret: () => ({ password: 'pw' }) } as unknown as Vault`
- [ ] 定义 `snapshot(meta, skipped)`：构造 `MetadataSnapshot` 的辅助

## 2. `data-run.integration.test.ts`（runDataCompare 细粒度）

- [ ] `vi.mock('./store-json')`：`loadNodes` 返回 A/B 假节点
- [ ] `vi.mock('./connection')`：`createMysqlPool` 返回 `fakePool()`
- [ ] `vi.mock('./metadata', importOriginal)`：保留真实导出，覆盖 `showCreateTable`
- [ ] `vi.mock('./data-fetch', importOriginal)`：保留真实导出，覆盖 `fetchAllByPK` / `getRowCount`
- [ ] **多表部分失败**：表1 正常（fetchAllByPK 返回行）→ 表2 `DataThresholdError` → 表3 普通 `Error`
  - [ ] 断言 `tables.map(t => t.status)` 为 `['done','confirm-needed','error']`
  - [ ] 断言 `items` 只含表1 diff、`stats` 正确累加
  - [ ] 断言两个 pool `end()` 被调用（cleanup 不变式）
- [ ] **无行身份跳过**：`showCreateTable` 返回无键 DDL，`getRowCount` 返回计数
  - [ ] 断言 `skipped` + `reason:'no-pk'` + `countA/countB`，`items` 空，不中断
- [ ] **取消整体抛出**：`AbortController` 预先 abort，`fetchAllByPK` 在 `signal.aborted` 时抛 `code:'ABORTED'`
  - [ ] 断言 `rejects`（不是逐表 error）、错误码 `ABORTED`、pool `end()` 被调用
- [ ] **cleanup 普通异常**：表1 error 后表2 正常 → 正常返回且 `end()` 被调用
- [ ] **空 pairs**：返回空结果且 `createMysqlPool` 未被调用

## 3. `compare-run.integration.test.ts`（runCompareRequest 全链路）

- [ ] `vi.mock('./store-json')`、`vi.mock('./connection')`、`vi.mock('./metadata', importOriginal)`、`vi.mock('./data-fetch', importOriginal)`、`vi.mock('./grants')`
  - [ ] `fetchMetadata` 返回固定 `MetadataSnapshot`（含表/视图/例程）
  - [ ] `assessVisibility` 返回 `{ byDatabase: { [db]: 'full' }, reliable: true }`
- [ ] **元数据失败 cleanup**：`fetchMetadata` 抛 `Error('connect ECONNREFUSED')`
  - [ ] 断言 `runCompareRequest` `rejects`，两个 pool `end()` 均被调用
- [ ] **data 阶段取消**：结构成功；data 阶段 `fetchAllByPK` 抛 `ABORTED`
  - [ ] 断言 `rejects`、错误码 `ABORTED`、pool `end()` 被调用
- [ ] **结构+数据混合输出**：结构正常 + 数据多表部分失败（done/confirm-needed/error）
  - [ ] 断言 `source==='real'`、`coverage` / `visibility` 存在、`dataTables` 状态齐全、`items` 排序合并、`stats.ALL` 正确
- [ ] **仅结构 scope**：`dataTables` 为 `undefined`，`source==='real'`，`coverage`/`visibility` 存在
- [ ] **全链路喂 manifest（AC5）**：把混合输出 result 传给 `buildManifest`
  - [ ] 断言 `deriveCoverageStatus(result)` 与 `dataTables` 一致
  - [ ] 断言 `serializeManifest` 输出合法 JSON、版本号可解析

## 4. 质量门禁

- [ ] 每个测试文件 `beforeEach` 中 `vi.clearAllMocks()`
- [ ] 运行 `npm run typecheck`
- [ ] 运行 `npm run lint`
- [ ] 运行 `npm test`（全量，确认既有测试不被破坏）
- [ ] 运行 `npm run build`

## 5. 规格同步（Phase 3.3）

- [ ] `backend/quality-guidelines.md` §Test Strategy：补充「compare/data 应用服务集成测试（cleanup/cancel/partial failure）位于 `src-main/*.integration.test.ts`」
- [ ] 如测试暴露缺陷并最小修复，在任务产物记录缺陷与修复；spec 不变式无变化则不改其他 spec

## 6. 缺陷修复（仅当 Q3 触发）

- [ ] 记录测试暴露的缺陷（文件、行、现象、影响）
- [ ] 最小修复：只改 `data-run.ts` / `compare-run.ts` 中被证伪的不变式路径，保持只读边界与 `mysqldiff/` 不动
- [ ] 修复后重跑四件套，确认全绿

## Validation

```bash
cd apps/desktop
npm run typecheck
npm run lint
npm test
npm run build
```

## Risky Files / Rollback Points

| 文件 | 风险 | 回滚 |
|---|---|---|
| `src-main/data-run.integration.test.ts` | 新测试，无产品代码影响 | 删除文件即可 |
| `src-main/compare-run.integration.test.ts` | 新测试，无产品代码影响 | 删除文件即可 |
| `src-main/data-run.ts` / `compare-run.ts` | 仅 Q3 触发时最小修改 | 单文件 revert 即可回滚 |
| `backend/quality-guidelines.md` | spec 追加 | revert 该文件 |

## Review Gates

1. 步骤 2 完成后：`npm test -- src-main/data-run.integration.test.ts` 通过
2. 步骤 3 完成后：`npm test -- src-main/compare-run.integration.test.ts` 通过
3. 四件套全绿后进入 `trellis-check`

## Before `task.py start`

- [ ] `implement.jsonl` / `check.jsonl` 各含至少一条真实 spec 条目
- [ ] 用户已明确批准最终规划摘要