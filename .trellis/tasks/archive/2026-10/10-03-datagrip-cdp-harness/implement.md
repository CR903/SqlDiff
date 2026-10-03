# Implement — DataGrip CDP 回归 harness

## Stage 0 — Baseline sanity (0 commits)

- [ ] `cd apps/desktop && npm run typecheck && npm run lint && npm test && npm run build` 在当前分支零改动通过。记录 git SHA。
- [ ] 确认 Node.js 版本 ≥ 20（当前 v22.23.2），Playwright 兼容。
- [ ] 确认 `save-file.ts` 的 `saveFiles` 函数入口位置，记录需要插入测试钩子的行号。
- [ ] 确认 `package.json` 无现有 playwright/puppeteer devDependency。
- [ ] 确认 `apps/desktop/e2e/` 目录不存在。

## Stage 1 — 依赖与配置（1 commit）

- [ ] `cd apps/desktop && npm install -D @playwright/test`（仅 devDependency，不引入运行时依赖）。
- [ ] 创建 `apps/desktop/e2e/playwright.config.ts`：
  - `testDir: './specs'`
  - `use: { browserName: 'chromium', ... }`（Playwright electron fixture 不需要 browserName，但保留默认）
  - `workers: 1`（Electron 实例不并发）
  - `timeout: 60_000`（单用例 60s 上限）
  - `reporter: [['html', { open: 'never' }], ['list']]`
  - `outputDir: './test-results'`
- [ ] `package.json` 新增 script：`"e2e": "npx playwright test"`。
- [ ] `.gitignore` 新增 `apps/desktop/e2e/test-results/` 和 `apps/desktop/e2e/playwright-report/`。
- [ ] 运行 `npm run e2e` 确认 Playwright 能启动（无 spec 时报 "no tests found"，这是预期行为）。
- [ ] 运行完整 gate：`npm run typecheck && npm run lint && npm test && npm run build` 确认零回归。

## Stage 2 — 测试钩子（1 commit）

- [ ] 在 `save-file.ts` 的 `saveFiles` 函数入口添加测试分支：
  ```ts
  if (process.env.SQLDIFF_E2E_SAVE_DIR) {
    return saveFilesToDir(request, process.env.SQLDIFF_E2E_SAVE_DIR);
  }
  ```
- [ ] 实现 `saveFilesToDir(request, dir)` 纯函数：
  - `kind: 'file'` → 写入 `dir/defaultName`，返回 `{ status: 'saved', filePaths: [path] }`
  - `kind: 'bundle'` → 写入 `dir/file1, dir/file2, ...`，返回 `{ status: 'saved', filePaths: [...] }`
  - 复用现有 `writeFileAtomic` / `writeFilesAtomic` 或 `fs.mkdirSync` + `fs.writeFileSync`
  - 不弹对话框，不返回 `'canceled'`
- [ ] 在 `save-file.test.ts` 添加 `saveFilesToDir` 单测：
  - file 模式：写入 + 返回正确路径
  - bundle 模式：多文件写入 + 路径排序
  - 目录不存在时自动创建
- [ ] 运行 `npm run typecheck && npm run lint && npm test && npm run build` 确认全绿。
- [ ] 确认 `saveFilesToDir` 分支不影响生产路径（无 env 变量时行为完全不变）。

## Stage 3 — Electron 启动辅助（1 commit）

- [ ] 创建 `e2e/helpers/electron.ts`：
  ```ts
  import { electron } from '@playwright/test';
  import { tmpdir } from 'os';
  import { join } from 'path';
  import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';

  export async function launchElectron(): Promise<{ app, browser, tmpDir, userDataDir }> {
    // 1. 创建临时目录
    // 2. 创建 userDataDir 和 downloads 子目录
    // 3. 写入测试用 nodes.json
    // 4. electron.launch({ args, env: { SQLDIFF_E2E_SAVE_DIR } })
    // 5. browser.newPage() → goto renderer entry
    // 返回 { app, browser, tmpDir, userDataDir, downloadsDir }
  }

  export async function closeElectron(app, browser, tmpDir): Promise<void> {
    // 1. 关闭 browser 和 app
    // 2. rmSync(tmpDir, { recursive: true })
  }
  ```
- [ ] 创建 `e2e/fixtures/test-nodes.ts`：
  - `TEST_NODES`：5 个节点（direct / pwd-ssh / key-ssh / collapse-1 / collapse-2）
  - `writeNodesJson(dir: string, nodes: NodeMeta[]): void`
- [ ] 创建 `e2e/fixtures/test-data.ts`：
  - `TEST_COMPARE_RESULT`：预置的比较结果（含差异项）
  - `TEST_DIFF_ITEMS`：预置的差异数据
- [ ] 运行 `npm run typecheck && npm run lint && npm test && npm run build` 确认全绿。
- [ ] 确认 `e2e/` 目录不被 `tsc --noEmit` 包含（`tsconfig.json` 的 `include` 排除 `e2e/`，或在 `playwright.config.ts` 中用 `@playwright/test` 自带编译）。

## Stage 4 — DBeaver 导出 E2E（1 commit）

- [ ] 创建 `e2e/specs/dbeaver-export.spec.ts`：
  ```ts
  import { test, expect } from '@playwright/test';
  import { launchElectron, closeElectron } from '../helpers/electron';
  import { TEST_NODES } from '../fixtures/test-nodes';

  let app, browser, downloadsDir;

  test.beforeAll(async () => {
    ({ app, browser, downloadsDir } = await launchElectron(TEST_NODES));
  });

  test.afterAll(async () => {
    await closeElectron(app, browser, tmpDir);
  });

  test('导出单个直连节点', async ({ page }) => {
    // 1. 页面加载完成
    // 2. 点击「导出到 DBeaver」按钮
    // 3. 确认弹窗出现
    // 4. 点击「导出 1 个节点」
    // 5. 等待 toast 出现
    // 6. 从 downloadsDir 读取 data-sources-sqldiff.json
    // 7. 断言 JSON 结构：folders, connections, connection-types
    // 8. 断言 MySQL 字段：provider=mysql, driver=mysql8, MANUAL, native
    // 9. 断言无秘密字段
  });

  test('导出含 SSH 的节点', async ({ page }) => {
    // 选择 pwd-ssh + key-ssh 节点
    // 断言 handlers.ssh_tunnel 存在
    // 断言 PASSWORD / PUBLIC_KEY auth
    // 断言无 keyPath/keyValue
  });

  test('确定性：不同输入顺序 → 相同内容', async ({ page }) => {
    // 第一次导出 [node1, node2, node3]
    // 第二次导出 [node3, node1, node2]
    // 断言 JSON 内容完全一致
  });
  ```
- [ ] 运行 `npm run e2e` 确认 DBeaver spec 全绿。
- [ ] 运行完整 gate 确认无回归。

## Stage 5 — DataGrip 导出 E2E（1 commit）

- [ ] 创建 `e2e/specs/datagrip-export.spec.ts`：
  ```ts
  test('导出单个直连节点', async ({ page }) => {
    // 1. 点击「导出到 DataGrip」按钮
    // 2. 确认弹窗出现
    // 3. 点击「导出 1 个节点」
    // 4. 从 downloadsDir 读取 dataSources.xml + dataSources.local.xml
    // 5. 断言 XML well-formed
    // 6. 断言 driver-ref=mysql.8, jdbc-driver=com.mysql.cj.jdbc.Driver
    // 7. 断言 jdbc-url=jdbc:mysql://host:port/db
    // 8. 断言 user-name 正确
    // 9. 断言无 sshConfigs.xml（files 数组只有 2 个文件）
    // 10. 断言无秘密字段
  });

  test('导出含 SSH 的节点', async ({ page }) => {
    // 选择 pwd-ssh 节点
    // 断言 sshConfigs.xml 存在
    // 断言 sshConfig authType=PASSWORD
    // 断言 ssh-config-id 与 sshConfig id 一致
  });

  test('导出私钥 SSH 节点', async ({ page }) => {
    // 选择 key-ssh 节点
    // 断言 sshConfig authType=PRIVATE_KEY
    // 断言无 keyPath
    // 断言 warning 包含「重新选择密钥」
  });

  test('SSH 折叠：两个节点共用跳板机', async ({ page }) => {
    // 选择 collapse-1 + collapse-2
    // 断言 sshConfigs.xml 只有 1 个 sshConfig
    // 断言 2 个 ssh-config-id 引用同一 id
    // 断言 warning 包含「拓扑已折叠」
  });

  test('确定性：不同输入顺序 → 相同内容', async ({ page }) => {
    // 第一次导出 [n1, n2, n3]
    // 第二次导出 [n3, n1, n2]
    // 断言所有 XML 文件内容完全一致
  });
  ```
- [ ] 运行 `npm run e2e` 确认 DataGrip spec 全绿。
- [ ] 运行完整 gate 确认无回归。

## Stage 6 — 确定性 + 报告（1 commit）

- [ ] 创建 `e2e/specs/determinism.spec.ts`：
  ```ts
  test('DataGrip 三件套确定性', async ({ page }) => {
    // 两次导出，逐字节比对 dataSources.xml + dataSources.local.xml + sshConfigs.xml
  });

  test('DBeaver JSON 确定性', async ({ page }) => {
    // 两次导出，逐字节比对 data-sources-sqldiff.json
  });
  ```
- [ ] 确认 Playwright HTML reporter 生成在 `e2e/playwright-report/`。
- [ ] 运行 `npm run e2e` 确认全套 spec 全绿。
- [ ] 运行完整 gate：`npm run typecheck && npm run lint && npm test && npm run build` 确认全绿。

## Stage 7 — Spec、文档、收尾（1 commit）

- [ ] 创建 `.trellis/spec/backend/e2e-harness.md`：
  - scope/trigger
  - 目录结构
  - Electron 启动流
  - 保存对话框测试策略（env 钩子）
  - 断言策略
  - 时间预算
  - 回滚策略
- [ ] 在 `.trellis/spec/backend/index.md` 添加 E2E harness 行。
- [ ] 在 `.trellis/spec/frontend/index.md` 添加 E2E 相关条目。
- [ ] 更新 PRD AC 标记为完成。
- [ ] 添加 journal 记录 CDP 验证结果。
- [ ] 运行完整 gate + `npm run e2e` 确认全绿。
- [ ] `git diff -- mysqldiff/` 为空。

## Review gates

- **Gate A（Stage 1 后）**：依赖 + 配置就绪。`npm run e2e` 能启动（无 spec 报错）。
- **Gate B（Stage 2 后）**：测试钩子就绪。`saveFilesToDir` 单测通过。生产路径不变。
- **Gate C（Stage 4 后）**：DBeaver E2E 全绿。完整 gate 无回归。
- **Gate D（Stage 5 后）**：DataGrip E2E 全绿。完整 gate 无回归。
- **Gate E（Stage 6 后）**：全套 spec 全绿。报告生成。完整 gate 无回归。

## Rollback points

- Stage 1 依赖：`npm uninstall @playwright/test` + 删除 playwright.config.ts + 删除 e2e script。
- Stage 2 测试钩子：删除 `saveFilesToDir` 函数和 env 判断分支。
- Stage 3-6 测试：删除 `e2e/` 目录。
- 全部回滚：`git checkout -- apps/desktop/e2e/ apps/desktop/package.json apps/desktop/src-main/save-file.ts`。

## Acceptance mapping

- AC1（`npm run e2e` macOS 全绿）— Stage 6 全套运行。
- AC2（DBeaver E2E 覆盖）— Stage 4。
- AC3（DataGrip E2E 覆盖）— Stage 5。
- AC4（确定性 E2E）— Stage 6。
- AC5（不引入运行时依赖）— Stage 1 仅 devDependency。
- AC6（不修改产品代码）— Stage 2 仅 `save-file.ts` 测试钩子，非 converters/renderer。
- AC7（`mysqldiff/` 零改动）— 全程不变。
