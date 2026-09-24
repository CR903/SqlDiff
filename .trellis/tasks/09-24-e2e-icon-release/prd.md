# 全面测试+应用图标+双端打包

## Goal

三件事一次交付：(1) CDP真机端到端全面测试（UI交互/节点CRUD/筛选复制/导出落盘/真库只读对比）并留测试报告；(2) 自动生成符合 SqlDiff 品牌（双库对比/SQL语义）的应用图标，输出 macOS `.icns` + Windows `.ico`；(3) 挂图标后重新构建 macOS(arm64+x64)与 Windows(x64) 安装包并核验产物。

本任务是 `09-22-deep-e2e` 的继任者（测试范围并入本任务，deep-e2e 待本任务完成后归档）。

## Background

- 现有 `apps/desktop`：Electron34+Vite+React+TS，三件套 159 测全绿（2026-09-22 ui-fix-batch 后）。
- 2026-09-22 已用 CDP 远程调试做过一轮真机测试（12通过/3真bug/1未复现），修单已合（`f83f91c`）：导出落盘、错误消毒、左侧全部Tab、筛选去重多选。**本轮要复验这些修复 + 扩面**。
- `electron-builder.yml` 已有 appId/productName/双端 target，但**无 icon 字段**（此前产物用 Electron 默认图标）。
- 环境事实：无 `GEMINI_API_KEY`（AI 图像生成不可用）、无 rsvg/magick/PIL；可用 `sips`/`iconutil`（macOS）与 Electron 离屏截图。

## Requirements

### R1 全面E2E测试（CDP驱动，真实点击/按键/剪贴板/文件实证）

- T1 冷启动：`npm run build` → `npm start -- --remote-debugging-port` → 窗口标题/三栏/空状态截图。
- T2 节点CRUD：新增（空校验→填→保存→下拉出现→左侧全部Tab可见）→测试连接（失败路径中文错误）→编辑→删除（弹窗确认→下拉/左侧消失→secrets文件清理）。
- T3 对比双路径：demo兜底路径（种子节点→中文报错，无 `Error invoking` 前缀）→ **真库只读对比**（192.168.0.5:3306 smarterlab vs smarterlab_zky；只读元数据+可选小表数据，不执行任何生成脚本）。
- T4 筛选：对象/INDEX/动词多选、CREATE/DROP/CHANGE Tab、关键字；各组合下**列表=复制内容=统计**。
- T5 复制：单条/当前Tab，DROP 二次确认（可信点击），剪贴板内容与预览逐行比对。
- T6 导出：可信点击 → `will-download` 落盘 → 文件存在且内容=预览；0条时无文件+toast提示。
- T7 密码安全：落盘后 `nodes.json`/`secrets/*` 无明文。
- T8 冒烟复验：交换/清空、Cmd+Enter、节点搜索。
- 输出：`.trellis/tasks/09-24-e2e-icon-release/e2e-report.md`（用例×结果×证据截图路径×缺陷），发现的真bug当轮修复+复验。

### R2 应用图标（自动生成，符合项目功能特定性）

- 设计语义（SqlDiff=MySQL 双库结构对比）：暗色科技底 + 双柱状"数据库A/B" + 中间 diff（±/⇄）+ 底部 `SQL` 语义；沿用产品色 `#0b0f14 / #6366f1 / #22d3ee`；macOS 圆角方形、Windows 无外框（builder处理）。
- 产出：`apps/desktop/build/icon/icon.png`(1024)、`icon.icns`、`icon.ico`、以及生成脚本 `apps/desktop/scripts/generate-icon.mjs`（可重复运行）；源模板 `scripts/icon-source.html`。
- 渲染管线：HTML/CSS → Electron 离屏 BrowserWindow 多尺寸截图（16/32/64/128/256/512/1024）→ macOS `iconutil` 组 `.icns` → Node 脚本组多尺寸 `.ico`（PNG 直嵌，无需第三方库）。
- `electron-builder.yml` 挂 `mac.icon`/`win.icon`（或 `buildResources/icon.*`）；开发态 `BrowserWindow.icon` 用 256 PNG（可选，mac 不显示，Win 有用）。

### R3 双端打包

- `npm run pack`（`ELECTRON_MIRROR` 镜像兜底）：`SqlDiff.dmg`(x64)、`SqlDiff-arm64.dmg`、`SqlDiff Setup.exe`(nsis x64)。
- 核验：产物存在+体积、dmg 能挂载/`hdiutil verify`、exe 签名位（无证书时 unsigned 属预期）、图标已嵌入（解包 Resources 检查）。
- 报告含产物清单（路径/大小/架构/图标核验结果）。

## Acceptance Criteria

- [ ] AC1 T1-T8 全部执行，报告有截图证据；发现的真bug全部修复且复验通过。
- [ ] AC2 图标：icns+ico 生成成功，Finder/资源管理器/包内三处可见；`electron-builder.yml` 已引用。
- [ ] AC3 三个安装包构建成功（mac x64/arm64 + win x64），图标已嵌入，报告列清单。
- [ ] AC4 真库对比全程只读，无任何数据变更；凭证不入库。
- [ ] AC5 三件套（tsc/lint/test）全绿；`mysqldiff/` 零改动。

## Out of Scope

- 代码签名证书、公证（无证书，unsigned 预期）；自动更新；CI 流水线；deep-e2e 独立任务另做。
- 图标动效/多尺寸自适应裁切实验。

## Risks

- GitHub 下载 Electron 二进制偶发 EOF → 沿用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。
- Windows 包在 macOS 上交叉构建依赖 wine（已验证可跑）；无法在真 Windows 上启动验证（记录为受限项）。
- 真库仅内网可达，测试需同网络环境。
