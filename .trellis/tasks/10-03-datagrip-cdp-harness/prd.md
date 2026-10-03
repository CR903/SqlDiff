# DataGrip CDP 回归 harness

## 背景

`09-24-datagrip-converter` 的 Stage 0-3 已完成（纯 builder + IPC + UI，383 测试全绿）。
Stage 4 原本要求 CDP 回归，但项目里没有任何 CDP/E2E harness、没有 playwright/puppeteer 依赖。

DBeaver 导出（`09-22-converters`）的 AC6 也是手工 CDP，`dbeaver-report.md:54` 明确记录"临时 harness 与下载文件已清理"，未持久化。

本任务搭建**持久化** CDP harness，一次性解决 DBeaver + DataGrip 两个导出路径的 E2E 回归缺口。

## 前置

- `09-24-datagrip-converter` Stage 0-3 已合并（`feat(desktop): DataGrip 三件套 XML 导出`）
- `09-22-converters` DBeaver 导出已完成
- Electron 桌面应用可在 CI/本地启动

## 范围

### 必须做

- [ ] 引入 playwright（或 puppeteer）作为 devDependency
- [ ] Electron 启动脚本：`npx playwright test` 前自动拉起 Electron + 暴露 CDP 端口
- [ ] 原生保存对话框拦截：Playwright `electronBrowser` 的 `setSaveDialog` 或 `page.on('dialog')` 模拟
- [ ] DBeaver 导出 E2E：点击导出 → 选择节点 → 确认导出 → 断言 `data-sources-sqldiff.json` 落盘内容（JSON 结构、字段、无秘密）
- [ ] DataGrip 导出 E2E：点击导出 → 选择节点 → 确认导出 → 断言 `dataSources.xml` + `dataSources.local.xml` 落盘（well-formed、UUID 一致、driver-ref、jdbc-url、无秘密）
- [ ] SSH 节点 E2E：含 SSH 的节点 → 断言 `sshConfigs.xml` 落盘（仅当有 SSH 节点时）、`ssh-properties` 引用、无 `keyPath`
- [ ] 确定性 E2E：相同节点集合不同输入顺序 → 导出内容字节一致
- [ ] `npm run e2e` 脚本，CI 可一键跑
- [ ] 测试报告输出（HTML/JSON），便于归档

### 明确不做

- [ ] 真实 DataGrip/DBeaver IDE 导入烟测（无目标 IDE 环境）
- [ ] 截图持久化（报告里引用截图 URL，不提交截图文件）
- [ ] 非导出路径的 E2E（连接测试、比较流程等——各功能自己按需建）

## 验收标准

- [ ] `npm run e2e` 在 macOS 本地全绿（Linux CI 作为后续补验，不阻塞）
- [ ] DBeaver E2E 覆盖：文件名、JSON 顶层结构、MySQL 直连字段、SSH 密码/私钥 handler、无秘密字段
- [ ] DataGrip E2E 覆盖：XML well-formed、UUID 跨文件一致、driver-ref/jdbc-driver/jdbc-url、`ssh-config-id` 引用、无 `keyPath`/`passphrase`
- [ ] 确定性 E2E：两次导出字节比对一致
- [ ] 不引入新的运行时依赖（playwright 仅 devDependency）
- [ ] 不修改 `src-main/converters/` 或 `src-renderer/` 的产品代码（harness 是测试基础设施，不是产品代码）
- [ ] `git diff -- mysqldiff/` 为空

## 约束

- Playwright 版本需与项目 Node.js 版本兼容（当前 Node 版本待确认）
- Electron 启动需要 `--remote-debugging-port`，与现有 `electron-builder` 配置不冲突
- 保存对话框的测试策略需在 `design.md` 中明确（Playwright 原生支持 vs `@electron/remote` vs 文件对话框 polyfill）
- 测试时间预算：单个 E2E spec ≤ 30s，全套 ≤ 3min（CI 超时阈值内）

## 开放问题

1. **Playwright vs Puppeteer**：Playwright 对 Electron 有原生 `electron` fixture，但需要额外配置；Puppeteer 通过 CDP 直连更轻量。需在 `design.md` 中做技术选型并说明理由。
2. **原生保存对话框**：Electron 的 `dialog.showSaveDialog` 是系统级 UI，Playwright 无法直接点击。候选方案：(a) 临时 mock `dialog.showSaveDialog` 为 `electron.dialog` stub；(b) 走 `file://` 协议 + `download` 事件；(c) 走 `will-download` 事件 + `session` API 拦截。需在 `design.md` 中选定。
3. **CI 环境**：当前 `electron-builder` 配置只支持 macOS/Windows，无 Linux target。E2E 在 Linux CI 上能否跑需要单独验证，作为后续补验。

## 相关任务

- `09-24-datagrip-converter`：Stage 0-3 已完成，Stage 4 CDP 由本任务补齐
- `09-22-converters`：DBeaver 导出，AC6 的手工 CDP 由本任务升级为持久 harness
