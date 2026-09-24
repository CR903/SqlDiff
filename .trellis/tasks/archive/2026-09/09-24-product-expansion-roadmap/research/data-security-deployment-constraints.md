# Research: 数据、安全与部署约束

- **Query**: 盘点 SqlDiff 当前的数据流、MySQL 只读边界、秘密存储、安全模型、并发/资源约束、桌面打包与平台部署事实。
- **Scope**: internal
- **Date**: 2026-09-24
- **证据标记**: `FACT` / `INFERENCE` / `HYPOTHESIS` 同 [`README.md`](README.md)。

## Findings

### 1. 运行时架构和边界

```text
renderer (React + Zustand)
  └─ window.sqldiff typed contextBridge (preload.ts)
       └─ Electron main handlers (main.ts)
            ├─ Vault / local JSON storage
            ├─ connection.ts → mysql2 Pool / ssh2 one-hop tunnel
            ├─ metadata.ts → information_schema + SHOW CREATE
            ├─ data-fetch.ts → COUNT + keyset SELECT
            ├─ compare-run.ts / data-run.ts → orchestration
            └─ src-core pure diff/filter/classify/risk/data helpers
```

- **FACT**：项目没有 HTTP server、ORM、migration、repository 或被检查数据库的 write API；“backend”规范明确指 Electron main + shared core。证据：`.trellis/spec/backend/index.md:1-3,16-23`。
- **FACT**：共享领域契约在 `apps/desktop/src-core/types.ts`，跨进程桥和 bridge-only 输入在 `apps/desktop/src-main/preload.ts`；renderer 只能使用 `window.sqldiff`。证据：`apps/desktop/src-core/types.ts:1-207`、`apps/desktop/src-main/preload.ts:66-156`、`.trellis/spec/backend/directory-structure.md:33-41`。
- **FACT**：Electron 窗口启用 `contextIsolation: true`、关闭 `nodeIntegration`，只加载显式 preload。证据：`apps/desktop/src-main/main.ts:367-380`。
- **INFERENCE**：当前可复用边界适合把同一比较核心接到另一种宿主（例如 headless runner），但仓库没有这样的第二入口；这是架构可扩展性事实，不是已存在的 CLI/服务能力。

### 2. 被检查数据库的只读操作清单

| 操作 | 当前实现 | 证据 |
|---|---|---|
| 连接测试 | `SELECT 1`，临时 connection 在 finally 关闭 | `apps/desktop/src-main/connection.ts:321-354` |
| 表清单 | `information_schema.tables ... table_type='BASE TABLE'`，schema 参数化 | `apps/desktop/src-main/metadata.ts:45-47,78-87` |
| 视图清单 | `information_schema.tables ... table_type='VIEW'` | `apps/desktop/src-main/metadata.ts:48-50,89-98` |
| 例程清单 | `information_schema.parameters` 去重 name/type | `apps/desktop/src-main/metadata.ts:42-44,100-112` |
| 定义读取 | `SHOW CREATE TABLE/PROCEDURE/FUNCTION/VIEW`，标识符经 `escapeIdent` | `apps/desktop/src-main/metadata.ts:52-55,115-138` |
| 行数 | `SELECT COUNT(*)` | `apps/desktop/src-main/data-fetch.ts:49-57` |
| 行读取 | `SELECT *` + 主键 `ORDER BY` + 整数化 `LIMIT` + 参数化 keyset WHERE | `apps/desktop/src-main/data-fetch.ts:33-85` |
| 结果写入 | 无；`DiffItem.sql` / `DataDiffResult` 只作为输出 | `apps/desktop/src-core/data-diff.ts:1-4`、`apps/desktop/src-main/data-run.ts:7-8`、`.trellis/spec/backend/database-guidelines.md:15-23` |

- **FACT**：schema 名、keyset 值使用 `?`；表/列标识符通过 `escapeIdent`；生成 DML 另用 `escapeDataIdent` 和 `sqlLiteral`。证据：`apps/desktop/src-main/metadata.ts:52-55`、`apps/desktop/src-main/data-fetch.ts:37-42,78-82`、`apps/desktop/src-core/data-diff.ts:36-68`。
- **FACT**：旧结构 diff builder 在 `apps/desktop/src-core/diff.ts` 中仍以反引号插值对象名；项目规范把它标为单独的安全/产品变化，不把它描述成已完成的 hardening。证据：`apps/desktop/src-core/diff.ts:59-60,141-169`、`.trellis/spec/backend/database-guidelines.md:7-12`。
- **FACT**：生成的 DDL/DML 从未传入 pool；main 的执行查询只出现在 metadata/data-fetch/connection。证据：`grep` 结果对应 `apps/desktop/src-main/connection.ts:329,348`、`apps/desktop/src-main/metadata.ts:80,91,102,121`、`apps/desktop/src-main/data-fetch.ts:51,82`；没有 `pool.query(DiffItem.sql)` 路径。

### 3. 结构快照语义

- `DatabaseMetadata` 是四张 `name -> SHOW CREATE text | null` map：`tables/views/procedures/functions`。证据：`apps/desktop/src-main/metadata.ts:26-32`。
- `fetchMetadata` 先并行取得三类清单，再对四类对象各用 `mapWithLimit`；默认并发上限 10。证据：`apps/desktop/src-main/metadata.ts:170-203`。
- `mapWithLimit` 保序返回，但 10 是每个 category map 的 worker 上限；A/B metadata fetch 也并行，实际 pool 仍受 `connectionLimit: 5` 约束。证据：`apps/desktop/src-main/metadata.ts:140-167`、`apps/desktop/src-main/connection.ts:301-318`、`.trellis/spec/backend/database-guidelines.md:25-31`。
- 单个 `SHOW CREATE` 失败被转换为 null，`compareRun` 跳过该对象而不把权限错误误报成 CREATE/DROP。证据：`apps/desktop/src-main/metadata.ts:190-201`、`apps/desktop/src-core/compare.ts:63-69,111-138`、`apps/desktop/src-core/diff.test.ts:277-281`。
- `tableFilter` 在 metadata 层只裁剪表清单，视图和例程仍全拉。证据：`apps/desktop/src-main/metadata.ts:34-39,180-188`；`apps/desktop/src-main/metadata.test.ts:175-180`。

### 4. 数据读取、内存与并发模型

- `fetchAllByPK` 先取总行数，再循环 keyset page，把当前表的所有 row 放入内存数组，完成后返回给 `diffDataRows`。证据：`apps/desktop/src-main/data-fetch.ts:105-134`。
- 单表 A/B 的 `fetchAllByPK` 并行；表循环本身串行，以限制跨表内存峰值。证据：`apps/desktop/src-main/data-run.ts:214-229,286-313`。
- 默认选项为 batch 1000、INSERT batch 500、threshold 100000；输入范围分别为 100–5000、100–2000、10000–1000000，非法/越界回落默认。证据：`apps/desktop/src-core/data-options.ts:7-77`；测试 `apps/desktop/src-core/data-options.test.ts:13-85`。
- 超过 threshold 且未确认时，表状态为 `confirm-needed`，其余表继续；UI 的“确认并重跑”会带 `confirmOverThreshold: true` 重新运行当前比较。证据：`apps/desktop/src-main/data-run.ts:291-302`、`apps/desktop/src-renderer/App.tsx:863-869,1716-1720`。
- `AbortSignal` 只在分页循环边界检查；取消表会抛出 `ABORTED`/`AbortError`，整个 `runDataCompare` 结束。证据：`apps/desktop/src-main/data-fetch.ts:97-103,125-132`、`apps/desktop/src-main/data-run.ts:101-106,291-292`。
- 结构 metadata 阶段没有同样的细粒度取消 UI；UI 文案明确“结构对比不可中断”。证据：`apps/desktop/src-renderer/App.tsx:480-487`。

### 5. 数据身份和 DML 输出边界

- PK 解析支持联合主键；无 PK 时只接受全列显式 `NOT NULL` UNIQUE；可空 UNIQUE 不作为身份。证据：`apps/desktop/src-core/data-pk.ts:17-30,70-143`；测试 `apps/desktop/src-core/data-unique.test.ts:56-147`。
- `decideIdentity` 在两侧都没有可用身份时返回 skipped，并只给 COUNT 行数差异与“加主键/全列 NOT NULL UNIQUE/整行 hash 抽样”替代提示；身份列集不一致返回 pk-mismatch。证据：`apps/desktop/src-main/data-run.ts:121-166,185-210`。
- 行 diff 使用 key 集合：A-only → INSERT，B-only → DELETE，同 key → 只写变化列的 UPDATE；INSERT 以 `VALUES` 多行批次生成。证据：`apps/desktop/src-core/data-diff.ts:83-142`；测试 `apps/desktop/src-core/data-diff.test.ts:44-101`。
- `sqlLiteral` 将 null/undefined 输出为 `NULL`，字符串转义，Date 转为字符串，Buffer 以 UTF-8 文本处理。证据：`apps/desktop/src-core/data-diff.ts:48-68`。
- **FACT**：INSERT 语句没有显式 column list，使用第一行列的 `Object.keys` 生成 values 顺序；这意味着输出依赖目标表列顺序/形状与 A 行一致。证据：`apps/desktop/src-core/data-diff.ts:75-81`。
- **FACT**：代码注释和 data-diff PRD 把 BLOB/大字段优化列为 out of scope；当前没有二进制专用序列化、采样或截断策略。证据：`apps/desktop/src-core/data-diff.ts:10-15`、`.trellis/tasks/archive/2026-09/09-21-data-diff-v2/prd.md:29-32`。

### 6. 连接、SSH 和资源生命周期

- 直连和 SSH 都创建 `mysql2/promise` pool，连接上限 5，调用者负责 `pool.end()`。证据：`apps/desktop/src-main/connection.ts:301-318`、`.trellis/spec/backend/database-guidelines.md:25-31`。
- SSH 认证支持 password 或 privateKey+可选 passphrase；隧道按 nodeId 缓存，并用 inflight Promise 去重。证据：`apps/desktop/src-main/connection.ts:55-85,140-142,228-291`。
- 本地转发端口沿用 32000–35000，EADDRINUSE 最多重试 10 次；测试覆盖范围和缓存命中/关闭。证据：`apps/desktop/src-main/connection.ts:17-25,247-277`、`apps/desktop/src-main/connection.test.ts:49-71,137-158`。
- `before-quit` 调用 `closeAll()`，但通过 `void closeAll().catch(...)` 启动，未等待其 Promise 完成。证据：`apps/desktop/src-main/main.ts:408-411`。
- 规范记录的 pool 构造边界：`Promise.all` 两边都 settle 后才赋值；若一边 pool 已创建而另一边失败，当前解构模式没有引用可关闭。这是已知 cleanup gap，不是已解决保证。证据：`.trellis/spec/backend/database-guidelines.md:27-31`。
- `closeTunnel` 可按 nodeId 关闭，但 main 的正常流程只在退出时调用 `closeAll`；当前没有看到节点更新/删除时显式关闭该节点隧道的调用。证据：`apps/desktop/src-main/connection.ts:392-427`、`apps/desktop/src-main/main.ts:180-189,408-411`。后一句是基于调用点搜索的 FACT。

### 7. 本地数据与秘密存储

| 存储项 | 内容 | 保护方式 | 证据 |
|---|---|---|---|
| `nodes.json` | `NodeMeta[]`，不含 secret | JSON 原子写；`isNodeMeta` 过滤 | `apps/desktop/src-main/store-json.ts:1-7,22-28,56-94` |
| `history.json` | 最近 20 条 `HistoryEntry` | 原子写，metadata only | `apps/desktop/src-main/store-json.ts:98-115`、`apps/desktop/src-core/types.ts:118-128` |
| `secrets/<nodeId>.json` | 加密后的 SecretBundle | safeStorage 或 AES-GCM | `apps/desktop/src-main/vault.ts:150-264` |
| `.masterkey` / `.masterkey.enc` | 回退/钥匙串加密的 master key | 文件 0600；safeStorage 可用时加密保存 | `apps/desktop/src-main/vault.ts:39-106` |
| `sqldiff.lastCombo` | 最近 A/B node id | renderer localStorage；无 secret/result | `apps/desktop/src-renderer/store.ts:54,106-126`、`.trellis/spec/frontend/state-management.md:27-37` |
| Downloads | renderer 生成的 `.sql`/JSON 文件 | Electron `will-download` 静默保存到 Downloads | `apps/desktop/src-main/download.ts:17-39`、`apps/desktop/src-main/main.ts:394-398` |

- **FACT**：`SQLDIFF_USER_DATA_DIR` 可覆盖 user-data 根，测试/隔离使用。证据：`apps/desktop/src-main/store-json.ts:15-20`、`apps/desktop/src-main/main.ts:50-65`。
- **FACT**：自定义 JSON 导入必须使用能解密该导出的 master key；换目录/机器会报解密失败。证据：`apps/desktop/src-main/vault.ts:127-147,292-315`；测试 `apps/desktop/src-core/vault.test.ts:130-140`。
- **FACT**：DBeaver 路径不调用 Vault、不接受 SecretBundle，只输出 NodeMeta topology。证据：`apps/desktop/src-main/main.ts:218-222`、`.trellis/spec/backend/dbeaver-export.md:48-56`。
- **FACT**：DBeaver 输出显式 `save-password: false`，私钥节点不输出 keyPath/keyValue，只给 warning。证据：`apps/desktop/src-main/converters/dbeaver.ts:137-194`；测试 `apps/desktop/src-main/converters/dbeaver.test.ts:50-97,122-143`。

### 8. Electron 安全和信任边界

- **FACT**：renderer 不直接 import `node:*`、electron、mysql2、ssh2；bridge 是唯一支持路径。证据：`.trellis/spec/backend/index.md:16-23`、`.trellis/spec/backend/quality-guidelines.md:18-25`；renderer 源码搜索无这些 import。
- **FACT**：renderer 通过 `sanitizeIpcError` 去掉 Electron remote-method 前缀再展示。证据：`apps/desktop/src-core/ipc-error.ts:1-16`、`apps/desktop/src-renderer/store.ts:387-390,498-500,614-629`、测试 `apps/desktop/src-core/ipc-error.test.ts:1-33`。
- **FACT**：应用没有应用级日志框架/日志文件/严重级别；诊断通道是 typed status、IPC rejection、toast、表单错误、测试/任务证据。证据：`.trellis/spec/backend/logging-guidelines.md:1-33`。
- **FACT**：当前代码没有 `console.*` 作为产品诊断（icon generator 的 stdout/stderr 除外）；敏感生成 SQL/行值没有写入运行日志。证据：`.trellis/spec/backend/logging-guidelines.md:5-29`、`apps/desktop/scripts/generate-icon.mjs:2,249-251,299-301`。
- **INFERENCE**：只读边界降低了应用误写目标库的风险，但用户仍可把生成的 SQL/JSON 手工交给其他工具执行；产品没有对外部执行器提供撤销或审计保证。该推论不改变“没有应用内执行路径”的事实。

### 9. 部署矩阵

| 平台/形态 | 当前配置 | 已验证程度 | 证据 |
|---|---|---|---|
| Windows x64 | NSIS，可选安装目录 | macOS 交叉构建、PE/NSIS/资源核验；无 Windows 真机启动 | `apps/desktop/electron-builder.yml:10-19`；`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:101-111` |
| macOS x64 | DMG | 产物、DMG 校验、架构/Info.plist/图标已核验 | `apps/desktop/electron-builder.yml:20-27`；`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:101-111` |
| macOS arm64 | DMG | 产物、架构、图标已核验 | 同上 |
| Linux | 当前 builder 无 target | 未验证；不能从旧 CLI README 推断当前桌面包 | `apps/desktop/electron-builder.yml:10-27`；`mysqldiff/README.md:36-37` |
| Vite browser preview | `npm run dev` | 仅 demo/seed 交互，真实 node/data 能力需 Electron | `apps/desktop/README.md:20-26`；`apps/desktop/src-renderer/store.ts:366-371,608-629` |
| Electron packaged app | `npm start` / release | macOS 有 E2E/包验证；Windows 仅交叉构建证据 | `apps/desktop/package.json:8-15`；`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md:68-76` |

- 应用窗口固定桌面尺寸 1440×900，最小 1100×680；CSS 三栏是 280px / 1fr / 380px。证据：`apps/desktop/src-main/main.ts:367-380`、`apps/desktop/src-renderer/styles.css:15-19`。
- 当前 package 声明 Node >=20；Electron/Vite/React/TS 版本范围在 `package.json:18-43`，本次环境实际安装版本由 `npm ls --depth=0` 观察到 Electron 34.5.8、mysql2 3.24.4、ssh2 1.17.0、Vitest 3.2.7。
- 图标是可重复的本地生成管线，macOS ICNS 依赖 `iconutil`；证据：`apps/desktop/scripts/generate-icon.mjs:211-229,231-302`、`apps/desktop/scripts/icon-source.html:53-59`。
- 代码签名、公证、自动更新、CI 不在当前配置/任务完成范围。证据：`.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/prd.md:61-64`、`.trellis/spec/backend/quality-guidelines.md:56-65`。

## Data/Security/Deployment Inferences

1. **INFERENCE（高置信）**：当前安全模型是“本地单机 + 只读读取器 + 加密本地凭据 + 手工执行输出”，不是多用户审计系统。依据是没有服务端身份/权限/项目存储，且 secrets/history/nodes 都在 Electron user-data。
2. **INFERENCE（高置信）**：MySQL 方言耦合分布在 connection、metadata、formatter、DDL parser 和 DML identity 多个层；增加另一种数据库不是只增加连接选项。依据：`apps/desktop/src-main/connection.ts`、`metadata.ts`、`apps/desktop/src-core/diff.ts`、`apps/desktop/src-renderer/sql.ts`。
3. **INFERENCE（中等置信）**：数据比较已从“旧 CLI 一次性拉 5000 行”演进到“按表 keyset 分页 + 阈值/取消”，但仍是全表 materialize-then-diff，不是数据库端流式比较。依据：`apps/desktop/src-main/data-fetch.ts:105-134`、`apps/desktop/src-core/data-diff.ts:89-142`。
4. **HYPOTHESIS**：用户是否愿意把 DDL/DML、行值或审查报告交给 CI/同事，当前没有访谈、留存或需求数据；不能从本地加密和导出能力推断团队协作需求。

## Related Specs

- `.trellis/spec/backend/database-guidelines.md`
- `.trellis/spec/backend/dbeaver-export.md`
- `.trellis/spec/backend/error-handling.md`
- `.trellis/spec/backend/logging-guidelines.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/frontend/state-management.md`
- `.trellis/spec/frontend/quality-guidelines.md`
- `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md`
- `.trellis/tasks/archive/2026-09/09-22-converters/research/dbeaver-connection-import.md`
- `.trellis/tasks/archive/2026-09/09-22-converters/research/datagrip-dataspell-connection-import.md`

## Caveats / Not Found

- 研究采集阶段只运行了 `npm test`、`npm run typecheck`、`npm run lint`，没有再次运行会写入 dist/release 的 build/pack；本次 Check Agent 质检阶段另行运行了 `npm run build`（未运行 pack）。当前 release 文件和报告中的包核验是已有证据，不等同于本次重新构建。
- 没有找到 Docker 配置文件或 CI 配置；Docker MySQL 仅出现在 E2E 任务报告的测试环境描述中。
- 没有找到自动更新、签名、公证、Linux builder target 或运行时日志配置。
- `mysqldiff/` 被根 `.gitignore` 忽略；它的旧 SSH/CLI 代码仅作为本地历史参考，不是当前 Git tracked 发布源。
