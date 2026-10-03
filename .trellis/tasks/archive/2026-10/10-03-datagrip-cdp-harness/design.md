# Design — DataGrip CDP 回归 harness

## 1. 技术选型

### 1.1 Playwright vs Puppeteer

**选择：Playwright。**

| 维度 | Playwright | Puppeteer |
|---|---|---|
| Electron 支持 | 原生 `electron.launch()` fixture，一行启动 | 需手动 `puppeteer.launch({ executablePath })` + CDP 端口 |
| 多文件测试 | `test.describe` + `test()` 原语，fixture 注入 | 手写 describe/it 或 jsdom |
| 文件对话框 | `electronApp.on('dialog')` + `browserPage.on('dialog')` | 需 CDP 协议手动处理 |
| 报告 | 内置 HTML/JSON reporter | 需 jest-reporters 或类似 |
| CI 兼容 | `--project=electron` 配置化 | 无内置 project 概念 |
| 社区活跃 | 活跃，Electron fixture 持续维护 | 活跃，但 Electron 支持靠第三方包 |

Playwright 的 `electron` fixture 是本任务最直接的依赖，减少 ~100 行手动 setup。

### 1.2 原生保存对话框策略

**问题**：Electron 的 `dialog.showSaveDialog` 是 main-process 同步 API，Playwright 无法直接点击或拦截。

**三个候选方案**：

| 方案 | 原理 | 产品代码改动 | CDP 复杂度 | 可靠性 |
|---|---|---|---|---|
| A. env 测试钩子 | `SQLDIFF_E2E_SAVE_DIR` 环境变量，`saveFiles` 检测到后跳过对话框直接写入 | ~10 行 `save-file.ts` | 低 | 高 |
| B. CDP 拦截 | `webContents.session` API 或 `Page.setInterceptFileChooserDialog` | 0 | 高（CDP 不覆盖 main-process dialog） | 低 |
| C. `@electron/remote` polyfill | 渲染进程直接调用 `dialog` | 需新增依赖 + 修改 preload | 中 | 中 |

**选择：方案 A（env 测试钩子）。**

理由：
- `dialog.showSaveDialog` 是同步阻塞的 main-process API，CDP 协议不覆盖；方案 B 不可行。
- 方案 C 引入新依赖且需要修改 preload 安全边界，风险大。
- 方案 A 只需在 `save-file.ts` 的 `saveFiles` 函数入口加一个 `if (process.env.SQLDIFF_E2E_SAVE_DIR)` 分支，~10 行，不改变任何产品逻辑，不引入新依赖。
- 该 env 变量在 `npx playwright test` 启动前由 harness 设置，运行时注入，不影响生产构建。

**具体实现**：

```ts
// save-file.ts — saveFiles 入口增加测试分支
export async function saveFiles(
  ctx: SaveFilesContext,
  request: SaveRequest,
): Promise<SaveResult> {
  // 测试模式：跳过系统对话框，直接写入指定目录
  if (process.env.SQLDIFF_E2E_SAVE_DIR) {
    return saveFilesToDir(request, process.env.SQLDIFF_E2E_SAVE_DIR);
  }
  // 生产路径：原有逻辑不变
  ...
}
```

`saveFilesToDir` 是新增的纯函数，复用 `writeFileAtomic` / `writeFilesAtomic` 逻辑，只是路径由 env 决定而非对话框。

### 1.3 CI 环境

**macOS 本地为唯一验收目标。** Linux CI 作为后续补验（当前 `electron-builder.yml` 无 Linux target）。Windows 不在本任务范围内。

## 2. 架构

### 2.1 目录结构

```
apps/desktop/
  e2e/                        # 新增：E2E 测试目录
    fixtures/                 # 测试 fixture
      test-nodes.ts           # 构造测试用 NodeMeta 数组
      test-data.ts            # 测试用比较结果/差异数据
    helpers/
      electron.ts             # Electron 启动/关闭封装
      assertions.ts           # XML/JSON 解析 + 断言工具
    specs/
      dbeaver-export.spec.ts  # DBeaver 导出 E2E
      datagrip-export.spec.ts # DataGrip 导出 E2E
      determinism.spec.ts     # 确定性 E2E
    playwright.config.ts      # Playwright 配置
  package.json                # 新增 e2e script + devDependency
```

### 2.2 Electron 启动流

```
npm run e2e
  → npx playwright test --project=electron
    → playwright.config.ts: testDir='e2e/specs', use={ ... }
      → test.beforeAll:
          1. 创建临时目录 tmpdir（os.tmpdir()/sqldiff-e2e-*）
          2. 设置 env: SQLDIFF_E2E_SAVE_DIR=tmpdir/downloads
          3. 构造测试用 nodes.json（写入 userDataDir）
          4. electron.launch({ args: ['.', '--user-data-dir=<tmpdir>'], env })
          5. browser.newPage() → goto renderer entry
      → test():
          1. 通过 page.evaluate 调用 window.sqlDiffApi 注入测试数据
          2. 通过 page.click 操作 UI（打开导出弹窗、选择节点、点击导出）
          3. 从 tmpdir/downloads 读取落盘文件
          4. 解析 XML/JSON，断言内容
      → test.afterAll:
          1. 关闭 Electron
          2. 清理 tmpdir
```

### 2.3 数据注入策略

E2E 测试需要预置测试节点。两条路径：

| 路径 | 优点 | 缺点 |
|---|---|---|
| A. 启动前写入 `userDataDir/nodes.json` | 模拟真实用户数据，测试真实加载路径 | 需要构造合法 JSON 并写入文件系统 |
| B. 运行时通过 `window.sqlDiffApi` 注入 | 灵活，可动态添加 | 需要确保 API 在测试模式下可用 |

**选择：路径 A（启动前写入 `nodes.json`）。**

理由：
- 模拟真实用户场景：节点从磁盘加载，经过完整的 `loadNodes` → `validateNodeMeta` → 渲染路径。
- 不依赖运行时 API 注入，避免与生产代码耦合。
- `nodes.json` 的格式与 `save-file.test.ts` 中已有 fixture 一致，复用成本低。

**测试节点 fixture**：

```ts
// e2e/fixtures/test-nodes.ts
export const TEST_NODES = [
  // 直连 MySQL
  { id: 'e2e-direct', alias: 'prod-db', host: 'db.internal', port: 3306, ... },
  // 密码 SSH
  { id: 'e2e-pwd-ssh', alias: 'staging-db', host: 'staging.internal', port: 3306, ... },
  // 私钥 SSH
  { id: 'e2e-key-ssh', alias: 'dev-db', host: 'dev.internal', port: 3306, ... },
  // 共用跳板机（SSH 折叠测试）
  { id: 'e2e-collapse-1', alias: 'coll-ap', host: 'a.internal', port: 3306, ... },
  { id: 'e2e-collapse-2', alias: 'coll-bp', host: 'b.internal', port: 3306, ... },
];
```

## 3. 保存对话框测试流

```
UI 点击「导出」
  → store.exportDatagrip(ids)
    → ipcRenderer.invoke('nodes.export-datagrip', ids)
      → main: resolveDatagripNodes → createDatagripExportResult
    → 返回 DatagripExportResult { files[], warnings }
  → saveTextFiles(result.files, title)
    → ipcRenderer.invoke('file.save', { kind: 'bundle', files, title })
      → main: saveFiles(ctx, request)
        → process.env.SQLDIFF_E2E_SAVE_DIR 存在
        → saveFilesToDir(request, dir)
          → 写入 dataSources.xml, dataSources.local.xml, sshConfigs.xml
          → 返回 { status: 'saved', filePaths: [...] }
    → 返回 ExportOutcome { saved: true, filePaths: [...] }
  → toast 显示保存路径
  → E2E 从 filePaths 读取文件，断言内容
```

## 4. 断言策略

### 4.1 XML 断言

```ts
// e2e/helpers/assertions.ts
export function assertWellFormedXml(xml: string): void
export function extractDataSources(xml: string): Array<{ name: string; uuid: string }>
export function extractSshConfigs(xml: string): Array<{ id: string; host: string; port: number }>
export function assertNoSecrets(content: string): void
```

- `assertWellFormedXml`：检查 XML 声明 + `<project version="4">` 根 + 标签闭合 + 引号配对。
- `extractDataSources`：正则提取 `<data-source name=... uuid=...>`。
- `extractSshConfigs`：正则提取 `<sshConfig ... host=... port=... id=...>`。
- `assertNoSecrets`：断言不含 `password`/`passphrase`/`keyPath`/`keyValue`/`BEGIN OPENSSH` 等。

### 4.2 JSON 断言（DBeaver）

```ts
export function parseDBeaverJson(json: string): DBeaverDataSources
export function assertDBeaverTopology(connections: DBeaverConnection[]): void
export function assertNoSecretsInJson(json: string): void
```

### 4.3 确定性断言

```ts
// 两次导出，文件内容逐字节比对
const result1 = await exportDatagrip(ids1);
const result2 = await exportDatagrip(ids2); // 不同顺序
assert.strictEqual(result1.files[0].content, result2.files[0].content);
```

## 5. 测试时间预算

| Spec | 预估耗时 |
|---|---|
| DBeaver 导出（3 用例） | ~8s（启动 + 导出 + 断言） |
| DataGrip 导出（5 用例） | ~12s（含 SSH 折叠 + 确定性） |
| 确定性（2 用例） | ~6s |
| **总计** | **~30s** |

远在 3min CI 阈值内。每个 `test.beforeAll` 只启动一次 Electron，后续 spec 复用同一实例。

## 6. 回滚策略

- `e2e/` 目录是纯新增，删除即回滚。
- `save-file.ts` 的测试钩子分支可通过删除 `SQLDIFF_E2E_SAVE_DIR` 判断来移除。
- `package.json` 的 `e2e` script 和 `playwright` devDependency 可独立移除。
- 不影响任何现有产品代码的行为。
