# Implement — 全面测试 + 图标 + 双端打包

## Checklist

### A. E2E 全面测试（R1）
- [x] A1 前置：`npm run build` + 三件套绿；起 `npm start -- --remote-debugging-port=9333`（后台）；建 `$TMPDIR` CDP harness（ws 客户端 + eval/click/shot 脚本，沿用 2026-09-22 已验证模式）。
- [x] A2 T1 冷启动：标题/三栏/种子演示态 → 截图；空对比态由 T2 证据覆盖。
- [x] A3 T2 节点CRUD：新增（空校验/填/保存/下拉出现/左侧全部可见）→ 测试连接失败中文 → 编辑 → 删除（可信点击+弹窗确认+secrets 清理）→ 截图。
- [x] A4 T3 对比：demo 路径（种子→中文报错前缀已消毒）→ 指定内网真库不可达时按已批准豁免使用 Docker fixture（结构差异、联合主键、无主键、小表数据；全程只读）→ 截图；指定真库仍明确标记为未闭环。
- [x] A5 T4/T5 筛选+复制：多选组合（对象/INDEX/动词/Tab/关键字）计数=条数；可信点击复制（单条/当前Tab/DROP 二次确认）→ 剪贴板逐行比对。
- [x] A6 T6 导出：可信点击 → `will-download` 落盘 → 文件存在+内容=预览；0条无文件。
- [x] A7 T7 安全：grep `nodes.json`/`secrets/*` 无明文凭证。
- [x] A8 T8 冒烟：交换/清空/Cmd+Enter/搜索。
- [x] A9 汇总 `e2e-report.md`（用例×结果×证据×缺陷）；fixture 编码问题已按 utf8mb4 重灌并复验，应用侧无遗留真 bug。

### B. 图标（R2）
- [x] B1 `scripts/icon-source.html`：1024 暗色科技风（A/B 双库柱 + diff 标记 + SQL 语义，产品色系）。
- [x] B2 `scripts/generate-icon.mjs`：Electron 离屏多尺寸截图（16/32/48/64/128/256/512/1024）→ `build/icon/*.png`；macOS `iconutil` 组 `icon.icns`；Node 手写 ICO 容器组 `icon.ico`；失败非零退出。
- [x] B3 `package.json` 加 `"icon": "node scripts/generate-icon.mjs"`；`electron-builder.yml` 显式 `mac.icon: build/icon/icon.icns` / `win.icon: build/icon/icon.ico`。
- [x] B4 生成并核验图标（含 256 PNG 视觉检查），确认 A/B 双库、diff 和 SQL 主题贴切。

### C. 打包（R3）
- [x] C1 `ELECTRON_MIRROR=... npm run pack`（含 B2/B3 产物）。
- [x] C2 核验产物清单（3 件套 dmg×2+exe）+ `hdiutil verify` + macOS 包内 `icon.icns` + Windows PE/NSIS 产物、`RT_GROUP_ICON` 与包内资源；Windows Explorer/真机启动按已批准豁免不要求。
- [x] C3 报告补产物清单段（路径/大小/架构/图标核验）。

### D. 收尾
- [x] D1 全量回归 `npx tsc --noEmit && npm run lint && npm test`；`mysqldiff/` 零改动复查。
- [x] D2 spec 更新（图标管线/打包镜像坑 → backend quality-guidelines）。
- [x] D3 工作提交完成；任务归档与会话日志按 finish-work 流程执行。

## Validation

- `cd apps/desktop && npm run icon && npm run pack`
- `cd apps/desktop && npx tsc --noEmit && npm run lint && npm test`
- `ls -lh release/ && hdiutil verify release/SqlDiff*.dmg`
- E2E：逐条见 `e2e-report.md`

## Rollback Points

- A 段 bug 修复：逐个 commit，可单独 revert。
- B 段：图标独立文件+yml 两行，回滚即删文件/还原 yml。
- C 段：仅生成 `release/`（gitignored），无回滚成本。
