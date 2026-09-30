# Design — compare/data 应用服务集成测试

## Architecture / Boundaries

改动只新增测试文件与必要的测试辅助，不新增产品模块边界：

```
apps/desktop/src-main/compare-run.integration.test.ts   runCompareRequest 全链路（cleanup/cancel/混合输出）
apps/desktop/src-main/data-run.integration.test.ts      runDataCompare 细粒度（cleanup/cancel/partial failure）
apps/desktop/src-main/testing/fake-*.ts（可选）          共享 fake Pool / fake 节点 / fake vault 构造器
```

**被测对象保持真实执行**：`runDataCompare` / `runCompareRequest` 及其内部编排逻辑（逐表串行、状态机、finally、异常分类、并发拉取、排序合并）。

**mock 边界**（模块级 `vi.mock`，只替换 IO/DB 触点）：

| 模块 | 被 mock 的导出 | 注入内容 |
|---|---|---|
| `./store-json` | `loadNodes` | 固定 `NodeMeta[]`（A/B 两个节点） |
| `./connection` | `createMysqlPool` | fake Pool（`end: vi.fn()` + `query`） |
| `./metadata` | `fetchMetadata`、`showCreateTable` | 固定 `MetadataSnapshot`；`showCreateTable` 返回 DDL |
| `./data-fetch` | `fetchAllByPK`、`getRowCount` | 可编程：成功行 / `DataThresholdError` / 普通 `Error` / `ABORTED` |
| `./grants` | `assessVisibility` | 固定 `{ byDatabase: { [db]: 'full' }, reliable: true }` |

`ctx.vault` 不走模块 mock——`runCompareRequest` / `runDataCompare` 都以 `ctx` 参数接收 vault，直接传假对象 `{ getNodeSecret: () => ({ password: 'pw' }) }`。

`compareRun` / `decideIdentity` / `diffDataRows` / `buildManifest` 等 core 纯函数保持真实执行（它们无 IO，且是前两任务定稿的契约）。

## Contracts

### 1. fake 形状

```ts
// fake Pool：结构兼容 mysql2 Pool 的被调用面（end/query）。
function fakePool() {
  return {
    end: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([[]]),
  };
}

// 假节点（复用 connection.test.ts 的 baseNode 形状）。
function node(id: string, alias: string, database: string): NodeMeta {
  return {
    id, alias, host: '127.0.0.1', port: 3306, user: 'u', database,
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password' },
    createdAt: new Date(0).toISOString(),
  };
}

// 假 vault。
const vault = { getNodeSecret: () => ({ password: 'pw' }) } as unknown as Vault;
```

### 2. mock 模块时的真实导出保留

`metadata` 模块同时导出 `escapeIdent` / `rowsOf` 等被 `data-fetch` / `data-run` 使用的工具。`vi.mock` 必须保留真实导出：

```ts
vi.mock('./metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./metadata')>();
  return { ...actual, fetchMetadata: vi.fn(), showCreateTable: vi.fn() };
});
```

`data-fetch` 的 mock 需保留 `DataThresholdError` 与 `DEFAULT_BATCH_ROWS` / `DEFAULT_ROW_THRESHOLD`（`fetchAllByPK` 的默认参数走真实常量）：

```ts
vi.mock('./data-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./data-fetch')>();
  return { ...actual, fetchAllByPK: vi.fn(), getRowCount: vi.fn() };
});
```

### 3. 测试场景矩阵

#### data-run.integration.test.ts（runDataCompare）

| 场景 | 编排 | 断言 |
|---|---|---|
| 多表部分失败 | 3 表：表1 fetchAllByPK 返回行（done）；表2 抛 `DataThresholdError`；表3 抛普通 `Error` | `tables` 状态序列 `['done','confirm-needed','error']`；`items` 只含表1 diff；`stats` 正确；两个 pool `end()` 均被调用 |
| 无行身份跳过 | `showCreateTable` 返回无键 DDL；`getRowCount` 返回计数 | 状态 `skipped` + `reason:'no-pk'` + `countA/countB`；不中断；`items` 空 |
| 取消整体抛出 | `AbortController` 预先 `abort()`；`fetchAllByPK` 在 `signal.aborted` 时抛 `code:'ABORTED'` | `runDataCompare` `rejects`（不是逐表 error）；错误码 `ABORTED`；pool `end()` 被调用 |
| cleanup：普通异常不中断时关池 | 表1 error 后表2 正常 | 结果正常返回且 `end()` 被调用（finally 恒执行） |
| 空 pairs | `pairs=[]` | 返回空 `items/tables/stats`，不建池（`createMysqlPool` 未被调用） |

#### compare-run.integration.test.ts（runCompareRequest）

| 场景 | 编排 | 断言 |
|---|---|---|
| 元数据失败 cleanup | `fetchMetadata` 抛 `Error('connect ECONNREFUSED')` | `rejects`；两个 pool `end()` 均被调用 |
| data 阶段取消 | 结构成功；data 阶段 `fetchAllByPK` 抛 `ABORTED` | `rejects`（错误码 `ABORTED`）；pool `end()` 被调用 |
| 结构+数据混合输出 | 结构正常 + 数据多表部分失败 | `result.source==='real'`；`coverage` / `visibility` 存在；`dataTables` 含 done/confirm-needed/error；`items` 排序合并；`stats.ALL` 正确 |
| 无数据 scope | 仅结构 | `dataTables` 为 `undefined`；`source==='real'`；`coverage`/`visibility` 存在 |
| 全链路喂 manifest | 上一步 result → `buildManifest` | `deriveCoverageStatus` 输出与 dataTables 一致；序列化合法 JSON |

### 4. 断言模式

- 池关闭：`expect(poolA.end).toHaveBeenCalled()` / `expect(poolB.end).toHaveBeenCalled()`。
- 取消错误码：捕获 reject 的 Error，断言 `(err as { code?: string }).code === 'ABORTED'`。
- 部分失败状态：`expect(res.tables.map(t => t.status)).toEqual(['done','confirm-needed','error'])`。
- 全链路形状：`expect(res.source).toBe('real')`、`expect(res.coverage?.skipped)`、`expect(res.visibility?.compared)`。

## Data Flow

```
测试用例
 ├─ 配置 vi.mock 返回值（节点/快照/授权/可编程 fetch）
 ├─ 构造 ctx（userDataDir 任意 + fake vault）
 ├─ 调用 runDataCompare / runCompareRequest（真实编排逻辑）
 ├─ 断言结果形状 / reject 错误码
 └─ 断言 fakePool.end() 被调用（cleanup 不变式）
```

关键点：`runCompareRequest` 内部会调用 `runDataCompare`（真实），其依赖的 `loadNodes` / `createMysqlPool` / `fetchAllByPK` 在同一 `vi.mock` 作用下也走 fake，因此全链路测试无需额外 mock 层。

## Trade-offs

| 选择 | 代价 | 理由 |
|---|---|---|
| mock 连接层而非真库 fixture | 不验证 MySQL 真实语义（如 SHOW CREATE 文本） | 被测对象是服务编排逻辑；DB 语义已被 metadata/data-fetch 层测试覆盖；CI 可重复（Q1） |
| 两个测试文件分开放 | 需重复少量 fake 构造 | 被测对象不同，mock 面不同，隔离更清晰 |
| `ctx.vault` 直接传假对象 | 不走模块 mock 的 vault | vault 是参数而非模块依赖，传假对象更简单且与实现一致 |
| 保留真实导出再覆盖 | mock 代码稍长 | 避免 `escapeIdent`/`rowsOf` 等被 mock 掉导致 data-fetch 内部损坏 |

## Compatibility

- 纯新增测试文件与测试辅助；不修改任何产品源文件（除非 Q3 最小修复被触发）。
- 不改变 `CompareResult` / `DataTableStatus` / `CoverageStatus` 等既有契约。
- 不新增 IPC、不新增存储、不引入依赖。
- 现有测试不受影响（新文件独立命名，不触碰既有测试的 `vi.mock` 状态）。

## Rollout / Rollback

1. 新增 `src-main/testing/`（或直接在测试文件内联 fake）——纯增量
2. 新增 `data-run.integration.test.ts` —— 纯增量
3. 新增 `compare-run.integration.test.ts` —— 纯增量
4. （仅当 Q3 触发）最小修复 `data-run.ts` / `compare-run.ts` —— 有明确回滚点：单文件 revert 即可

每步可独立运行 `npm test -- <file>` 验证。回滚任何一步都不影响既有功能。

## Operational Notes

- 运行：`cd apps/desktop && npm test -- src-main/data-run.integration.test.ts src-main/compare-run.integration.test.ts`。
- 每个测试文件在 `beforeEach` 中 `vi.clearAllMocks()`，避免用例间泄漏。
- 若测试暴露服务层缺陷（Q3），先写失败断言再最小修复，修复必须保持只读边界与 `mysqldiff/` 不动。
- 集成测试文件名带 `.integration.` 以区分纯函数测试，且不依赖任何外部服务。
- AC5（喂 manifest）只需在 compare-run 集成测试中追加一个用例，调用 `buildManifest` 断言合法 JSON 与 `coverageStatus`，不重复 manifest 自身单测。