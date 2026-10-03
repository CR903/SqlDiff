# Journal — DataGrip CDP 回归 harness

## 2026-10-03: Implementation Complete

### 7 个 Stage 全部完成

| Stage | 内容 | 结果 |
|---|---|---|
| 0 | Baseline sanity（383 测试全绿） | ✅ |
| 1 | 依赖与配置（@playwright/test + playwright.config.ts + e2e script） | ✅ |
| 2 | 测试钩子（saveFilesToDir + getE2eSaveDir） | ✅ |
| 3 | Electron 启动辅助（electron.ts + test-nodes.ts） | ✅ |
| 4 | DBeaver 导出 E2E（3 用例） | ✅ |
| 5 | DataGrip 导出 E2E（5 用例） | ✅ |
| 6 | 确定性 + UI 冒烟 + 报告 | ✅ |
| 7 | Spec、文档、收尾 | ✅ |

### 关键设计决策

1. **E2E 检测仅用 env 变量**：`getE2eSaveDir()` 只检查 `process.env.SQLDIFF_E2E_SAVE_DIR?.trim() || null`。不检查标志文件——固定路径可被本地其他用户伪造（symlink 攻击），且 Windows 无 `/tmp`。

2. **测试分层**：
   - 深度断言（API 直调）：`dbeaver-export.spec.ts` / `datagrip-export.spec.ts`，验证 JSON/XML 结构、字段映射、UUID 一致性、SSH 折叠、确定性
   - UI 冒烟（真实点击）：`ui-smoke.spec.ts`，验证按钮→弹窗→勾选→确认→toast 的可达性

3. **无秘密白名单**：`assertNoSecrets` 允许 `save-password: false`（DBeaver 控制字段）和 `authType: PASSWORD/PUBLIC_KEY`（DataGrip 枚举值），拒绝所有实际秘密泄露。

### Check 子代理发现的问题

1. **CRITICAL 安全**：固定路径标志文件 `/tmp/sqldiff-e2e-save-dir` 可被 symlink 攻击 → 已删除，仅保留 env 注入
2. **MAJOR PRD 违规**：E2E 完全绕过 UI（用 `page.evaluate` 直调 IPC）→ 新增 `ui-smoke.spec.ts` 3 个真实点击用例
3. **MINOR 边界**：env 空白串边界未测试 → 新增 `SQLDIFF_E2E_SAVE_DIR 为空串或纯空白：视为未设置` 用例

### 最终验证结果

| 检查 | 结果 |
|---|---|
| typecheck | ✅ |
| lint | ✅ |
| unit tests | ✅ 31 文件，390 测试 |
| build | ✅ |
| e2e tests | ✅ 11 测试，18s |
| mysqldiff/ | ✅ 零改动 |

### 文件变更

**修改**：
- `apps/desktop/package.json` — 新增 @playwright/test devDependency + e2e script
- `apps/desktop/package-lock.json` — 更新
- `apps/desktop/.gitignore` — 新增 e2e/test-results/ + e2e/playwright-report/
- `apps/desktop/src-main/save-file.ts` — 新增 getE2eSaveDir() + saveFilesToDir() + saveFiles() env 分支
- `apps/desktop/src-main/save-file.test.ts` — 新增 7 个测试（saveFilesToDir + env 分支 + 空白边界）

**新增**：
- `apps/desktop/e2e/playwright.config.ts`
- `apps/desktop/e2e/helpers/electron.ts`
- `apps/desktop/e2e/helpers/assertions.ts`
- `apps/desktop/e2e/fixtures/test-nodes.ts`
- `apps/desktop/e2e/specs/dbeaver-export.spec.ts`
- `apps/desktop/e2e/specs/datagrip-export.spec.ts`
- `apps/desktop/e2e/specs/ui-smoke.spec.ts`
- `.trellis/spec/backend/e2e-harness.md`

### 后续补验

- Linux CI：当前 `electron-builder.yml` 无 Linux target，E2E 在 Linux 上能否运行需单独验证
- Windows：不在本任务范围内
- 真实 IDE 导入烟测：不在本任务范围内（无目标 IDE 环境）
