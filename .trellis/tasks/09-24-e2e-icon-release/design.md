# Design — 全面测试 + 图标 + 双端打包

## 1. E2E 测试架构

- 驱动：Electron `--remote-debugging-port=9333` → CDP（WebSocket）`Runtime.evaluate` 拿状态、`Input.dispatchMouseEvent` 发**可信点击**（关键：Blob 下载/confirm 弹窗只对可信手势响应，2026-09-22 已实证）、`Page.captureScreenshot` 存证。
- 脚本位置：临时 harness（`$TMPDIR` 下的 ws 客户端 + eval/click 脚本），不入库；报告与截图证据沉淀到 task 目录（截图存 `.trellis/tasks/.../evidence/`）。
- 数据源：
  - demo 路径：UI 种子节点（后端报"节点不存在"→ demo 兜底 9 条），验证前端过滤/复制/展示。
  - 真库路径：会话内提供的 `192.168.0.5:3306 root` + 两库；**通过 UI 节点表单录入**（走真实 CRUD + safeStorage），凭证不落盘任务文件。
- 断言口径：复制=所见（剪贴板/文件逐行 vs 预览 `highlightSql` 源文本）、统计=条数、落盘=文件名+内容+字节数。

## 2. 图标生成管线

```
icon-source.html (1024x1024 模板, CSS 绘制)
   │  Electron 离屏 BrowserWindow（show:false, deviceScaleFactor=1）
   ├─ for size in [16,32,64,128,256,512,1024]: capturePage → PNG
   ├─ macOS: iconutil -c icns icon.iconset (含 @2x 组合) → icon.icns
   └─ Node: ico 容器手写（ICONDIR + ICONDIRENTRY + PNG 直嵌, Vista+ 支持）→ icon.ico
```
- 图标语义：左蓝柱(A库) / 右青柱(B库) / 中间 diff 标记 / 底部 SQL 文本，全部用 CSS/SVG 内联绘制，无外部字体依赖（系统 -apple-system/SF，回退 sans）。
- 产物目录 `apps/desktop/build/icon/`（electron-builder 默认 buildResources=build，`icon.icns`/`icon.ico` 放此即自动识别；额外显式 `mac.icon`/`win.icon` 双保险）。
- 可重复：`npm run icon` → `node scripts/generate-icon.mjs`（脚本内自起 Electron 子进程渲染，自行组 .icns/.ico，失败非零退出）。

## 3. 打包

- `electron-builder --win --mac`（脚本已含 `npm run build` 前置）；`ELECTRON_MIRROR` 仅在下载失败时注入。
- 核验脚本（手工命令，不入库）：`ls -lh release/`、`hdiutil verify release/*.dmg`、`unzip -l "release/win-unpacked/resources/app.asar" | head`、mac 包内 `Contents/Resources/icon.icns` 存在性、`plutil -p release/mac*/SqlDiff.app/Contents/Info.plist | grep CFBundleIconFile`。

## 4. 边界与兼容

- 测试 harness 全部在 `$TMPDIR`，不污染仓库；唯一入库新文件：`scripts/generate-icon.mjs`、`scripts/icon-source.html`、`build/icon/*`（图标产物入库，build/ 目录，注意 `build/` 不在 .gitignore）。
- `electron-builder.yml` 仅加 icon 引用；不改 target/签名策略。
- 不改业务代码；若 E2E 抓真 bug，按最小修复+单测+复验流程处理（走本任务 commit）。
