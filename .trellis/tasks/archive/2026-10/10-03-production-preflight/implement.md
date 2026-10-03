# Implement — 生产 Preflight v1（只读变更检查）

## 1. 类型契约（`src-core/preflight-types.ts`）

- [ ] 新增 `PREFLIGHT_REPORT_VERSION = 1`
- [ ] 新增 `PreflightCategory` 联合类型（server / table / index / ddl / replication / permissions / variables）
- [ ] 新增 `PreflightFactSource` 联合类型
- [ ] 新增 `PreflightFact` / `PreflightInference` / `PreflightUnknown` / `PreflightIssue` / `PreflightReport` 接口
- [ ] 新增 `PreflightInferenceConfidence`、`PreflightUnknownReason`、`PreflightIssueSeverity` 联合类型
- [ ] 新增 `PreflightThresholds` 接口（bigTableRows、replicaLagSeconds 默认值）

## 2. DDL 分类器（`src-core/preflight-ddl.ts` 纯函数）

- [ ] 新增 `DdlOp` 联合类型（15 种 Op）
- [ ] 新增 `DdlClassification` 接口
- [ ] 新增 `classifyDdl(sql: string): DdlClassification`
  - [ ] 按优先级匹配 15 种 Op（详见 design.md §2）
  - [ ] 复合 ALTER 语句取首个操作类别
  - [ ] 无法识别 → `op: 'OTHER'`, `confidence: 'low'`
- [ ] 单测：每种 Op 至少 1 个正例 + 1 个反例 + OTHER 兜底

## 3. Online DDL 矩阵（`src-core/preflight-ddl.ts`）

- [ ] 新增 `OnlineDdlInfo` 接口
- [ ] 新增 `versionAtLeast(actual, required): boolean` 纯函数
- [ ] 新增 `lookupOnlineDdl(op, mysqlVersion): OnlineDdlInfo | null`
  - [ ] 内置 15 种 Op 的矩阵表
  - [ ] `availableFrom` 版本下限处理（8.0.12 INSTANT ADD COLUMN、8.0.29 INSTANT DROP COLUMN）
  - [ ] 版本 < 5.6 → 返回 `null`（上层记 `unsupported-version`）
- [ ] 单测：MySQL 5.7 / 8.0.11 / 8.0.12 / 8.0.29 / 8.0.36 五个版本 × 至少 8 种 DdlOp

## 4. 高风险规则（`src-core/preflight-rules.ts` 纯函数）

- [ ] 新增 `RuleInput` 接口
- [ ] 新增 `evaluateRules(input): PreflightIssue[]`
- [ ] 每条规则独立函数 + 独立单测：
  - [ ] `BIG_TABLE_COPY`（block）
  - [ ] `NO_PRIMARY_KEY`（warn）
  - [ ] `REPLICA_LAG`（warn）
  - [ ] `READ_ONLY_TARGET`（block）
  - [ ] `GTID_MISMATCH`（warn）
  - [ ] `PERMISSION_INCOMPLETE`（warn）
  - [ ] `LARGE_TABLE_INSTANT_ADD`（warn，正面）
  - [ ] `NO_UNIQUE_INDEX_AFTER_CHANGE`（warn）
  - [ ] `LARGE_TABLE_REBUILD`（warn）
- [ ] 单测：每条规则各至少 2 个用例（触发 + 不触发）

## 5. 报告构建（`src-core/preflight.ts` 纯函数）

- [ ] 新增 `PreflightBuildInput` 接口
- [ ] 新增 `deriveVerdict(issues, unknowns)` 纯函数
  - [ ] level 优先级：block > warn > unknown > pass
  - [ ] counts：blocking / warnings / unknowns
- [ ] 新增 `buildPreflightReport(input): PreflightReport`
  - [ ] 字段顺序即类型声明顺序（byte 稳定）
- [ ] 新增 `serializePreflight(m): string`（JSON + '\n'）
- [ ] 新增 `preflightToMarkdown(m): string`
  - [ ] 头部 + 目标信息
  - [ ] Fact 表（按 category 分组）
  - [ ] Inference 表（含 evidence 引用）
  - [ ] Unknown 表（含 reason）
  - [ ] Issue 表（severity 排序：block 优先）
  - [ ] Verdict 结论
  - [ ] 保密声明
- [ ] 新增 `preflightFileNames(checkedAt)` 导出文件名生成
- [ ] 单测：deriveVerdict 全分支 / serializeManifest byte 稳定 / preflightToMarkdown 含全部区块

## 6. 只读采集器（`src-main/preflight-collect.ts`）

- [ ] 新增 `PreflightCollectHooks` 接口
- [ ] 新增 `collectServerFacts(db: DbQueryable): Promise<CollectedFact[]>`
  - [ ] `SELECT VERSION(), @@version_comment, @@sql_mode, ...`
- [ ] 新增 `collectVariablesFacts(db): Promise<CollectedFact[]>`
  - [ ] `SELECT @@innodb_buffer_pool_size, @@max_connections, ...`
- [ ] 新增 `collectTableFacts(db, database, tables): Promise<CollectedFact[]>`
  - [ ] `information_schema.tables` 分批查询（每批 100）
  - [ ] 表名参数化，schema 参数化
- [ ] 新增 `collectIndexFacts(db, database, tables): Promise<CollectedFact[]>`
  - [ ] `information_schema.statistics`（主键 + 索引）
  - [ ] `information_schema.key_column_usage`（外键）
- [ ] 新增 `collectReplicationFacts(db): Promise<CollectedFact[]>`
  - [ ] 先尝试 `SHOW REPLICA STATUS`（8.0.22+）
  - [ ] 失败降级 `SHOW SLAVE STATUS`（5.7 / 8.0.21-）
  - [ ] 两者都失败 → `not-applicable` Unknown
  - [ ] `SELECT @@server_id, @@read_only, @@super_read_only, @@log_bin, @@gtid_mode`
- [ ] 新增 `collectGrantFacts(db): Promise<CollectedFact[]>`
  - [ ] 复用 `assessVisibility`（`grants.ts`）
  - [ ] 库级 `Visibility` 结果
- [ ] 错误分类复用 `metadata.ts` 的 `PERMISSION_ERRNOS` / `PERMISSION_CODES`
- [ ] 单测：注入 fake `DbQueryable`，断言 SQL 只含 SELECT / SHOW / @@ / information_schema
- [ ] 单测：每个采集函数在错误时返回 Unknown 而非抛错

## 7. 编排（`src-main/preflight-run.ts`）

- [ ] 新增 `PreflightRunContext`（userDataDir + vault，同 `CompareRunContext`）
- [ ] 新增 `PreflightRunHooks`（signal + onProgress）
- [ ] 新增 `runPreflight(req, ctx, hooks): Promise<PreflightReport>`
  - [ ] 建池（复用 `createMysqlPool`）
  - [ ] 采集 6 类事实（Server / Variables / Grants 并发；Tables → Indexes 串行；Replication 并发）
  - [ ] 对每条 item 调 `classifyDdl` + `lookupOnlineDdl`，生成 ddl Inference
  - [ ] 调 `evaluateRules`
  - [ ] 调 `deriveVerdict`
  - [ ] 调 `buildPreflightReport`
  - [ ] finally 关闭 pool（`Promise.allSettled`，参考 `compare-run.ts:297`）
- [ ] 单测：注入 fake pool，断言完整流程产出 PreflightReport；pool 失败时不阻塞返回

## 8. IPC（`src-main/preload.ts` + `src-main/main.ts`）

- [ ] 新增 `PreflightRequest` / `PreflightExportResult` 类型（preload 导出）
- [ ] preload：新增 `preflight.run(input)` 桥接
- [ ] main：新增 `ipcMain.handle('preflight:run', handler)`
- [ ] handler 内部调用 `runPreflight`，序列化后返回

## 9. Store（`src-renderer/store.ts`）

- [ ] 新增 `lastPreflightResult: PreflightReport | null`
- [ ] 新增 `runPreflight(bId)` action
  - [ ] 从 state 拿 lastCompareRequest 与 result
  - [ ] 过滤 `items.filter(i => i.objectType !== 'data')` 作为输入
  - [ ] 调 `ipc.preflight.run`
  - [ ] 保存结果到 `lastPreflightResult`

## 10. UI（`src-renderer/App.tsx`）

- [ ] 在结果区新增「运行 Preflight」按钮（与「导出审查报告」并列）
- [ ] 点击后触发 store 的 `runPreflight`
- [ ] 展示 verdict.level 徽标（pass/warn/block/unknown 四色）
- [ ] 展示 issues 计数（blocking / warnings / unknowns）
- [ ] 「导出 Preflight 报告」按钮：下载 JSON + Markdown
- [ ] 无 CompareResult 或含 demo 结果时禁用 Preflight 按钮

## 11. 集成测试

- [ ] Docker MySQL 5.7 fixture：8 表（含 PK / 无 PK / 复合 PK / 宽表 / 无索引 / 有 UNIQUE / 有 FK / 有触发器）
- [ ] Docker MySQL 8.0 fixture：同 8 表
- [ ] 每个 fixture 跑一次完整 preflight，断言：
  - [ ] facts 覆盖 6 类（server / variables / tables / indexes / replication / grants）
  - [ ] 每条 DiffItem 都有 DDL 分类
  - [ ] 矩阵查询返回合理的 algorithm / lockMode / rebuildsTable
  - [ ] 规则至少触发 3 条已知规则
  - [ ] Unknown 列表包含权限不足表的权限记录
- [ ] 断言：`grep -n "\.query\(.*sql\|pool\.execute" apps/desktop/src-main/preflight*` 为空

## 12. 规格同步（Phase 3.3）

- [ ] `.trellis/spec/backend/database-guidelines.md`：追加 preflight 只读 SQL 清单
  - [ ] `information_schema.statistics` / `key_column_usage`
  - [ ] `SHOW REPLICA STATUS` / `SHOW SLAVE STATUS`（降级链）
  - [ ] `SELECT @@*`（列清单）
- [ ] `.trellis/spec/backend/preflight.md`（新增）：记录 PreflightReport 契约、DDL 分类器、Online DDL 矩阵、规则表、IPC 签名
- [ ] `.trellis/spec/backend/manifest-export.md`：追加 PreflightReport 与 ReviewManifest 的边界说明（互补不合并）
- [ ] `.trellis/spec/frontend/type-safety.md`：补 Preflight* 类型到共享类型清单
- [ ] `.trellis/spec/frontend/quality-guidelines.md`：CDP 验证要求（Preflight 按钮 + 导出下载）

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
| `src-core/preflight-*.ts` | 新逻辑，纯函数 | 无破坏性（新增） |
| `src-main/preflight-*.ts` | 新采集器，可能引入慢查询 | 可单独回滚 |
| `src-main/preload.ts` / `main.ts` | 新增 IPC | 纯增量 |
| `src-renderer/store.ts` | 加 lastPreflightResult | 不影响既有字段 |
| `src-renderer/App.tsx` | 新增按钮 | 可单独回滚步骤 10 |
| `.trellis/spec/backend/database-guidelines.md` | 扩展只读 SQL 清单 | 追加内容，不改现有 |

## Review Gates

1. 步骤 1–5 后：typecheck + 纯函数单测全绿
2. 步骤 6–7 后：采集器单测通过（fake DbQueryable）
3. 步骤 11 后：Docker fixture 集成测试通过
4. 四件套全绿后进入 `trellis-check`

## Before `task.py start`

- [ ] `implement.jsonl` / `check.jsonl` 各含至少一条真实 spec 条目
- [ ] 用户已明确批准最终规划摘要
- [ ] 确认 MySQL 5.7 与 8.0 Docker 环境可用（不阻塞代码编写，但阻塞集成测试）
