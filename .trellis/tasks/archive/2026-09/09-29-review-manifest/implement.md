# Implement — Review Manifest v1（版本化无秘密）

## 1. 类型契约（`src-core/types.ts`）

- [ ] 新增 `REVIEW_MANIFEST_VERSION = 1`
- [ ] 新增 `ReviewManifest` / `ReviewManifestItem` 类型
- [ ] 新增 `CoverageStatusKind` / `CoverageStatus` 类型
- [ ] 新增 `ManifestBuildInput`（result + request + aliases + appVersion 的输入形状）

## 2. CoverageStatus 映射（`src-core/manifest.ts` 纯函数）

- [ ] 新增 `deriveCoverageStatus(result: CompareResult): CoverageStatus`
  - [ ] 规则：无 skipped、无 excluded、无失败 dataTable → `ok`
  - [ ] `coverage.skipped` 各 reason → `permission-denied` / `error` / `aborted`
  - [ ] `dataTables` 各 status/reason → `no-row-identity` / `over-threshold` / `error` / `aborted`
  - [ ] `visibility.excluded` 非空 → `grant-invisible`
  - [ ] 优先级取 `kind`：`grant-invisible` > `permission-denied` > `over-threshold` > `no-row-identity` > `error` > `aborted` > `ok`
  - [ ] `counts` 为各来源累加

## 3. DML 脱敏器（`src-core/manifest.ts` 纯函数）

- [ ] 新增 `redactDmlSql(sql: string): string`
  - [ ] 先提取反引号标识符为占位符（复用 highlightSql 思路）
  - [ ] 字符串字面量 → `'***'`，数字 → `0`，`NULL`/`TRUE`/`FALSE` 保留
  - [ ] 日期字面量 → `'***'`
  - [ ] 还原标识符占位符
- [ ] 单测：字符串 / 数字 / 日期 / Buffer / NULL / 反引号含 `'` 不误伤 / 多行 DML / 注释

## 4. JSON 序列化（确定性）

- [ ] 新增 `serializeManifest(m: ReviewManifest): string`
  - [ ] `JSON.stringify(m, null, 2) + '\n'`
  - [ ] 字段顺序即类型声明顺序（同输入 byte 稳定）

## 5. Markdown 生成

- [ ] 新增 `manifestToMarkdown(m: ReviewManifest): string`
  - [ ] 头部：`# SqlDiff 审查报告` + A/B + 时间 + schemaVersion + appVersion
  - [ ] 差异摘要表：对象 / 类型 / 变更 / 风险
  - [ ] 结构 DDL 代码块（data 项已脱敏）
  - [ ] 覆盖/可见性说明：skipped（原因）、grant-invisible（对象+侧）、reliable:false 提示
  - [ ] 保密声明

## 6. IPC：app.version（`src-main/main.ts` + `src-main/preload.ts`）

- [ ] main：新增 `ipcMain.handle('app.version', () => app.getVersion())`
- [ ] preload：新增 `app.version: () => Promise<string>`

## 7. Store：保存上次 CompareRequest（`src-renderer/store.ts`）

- [ ] 新增 `lastCompareRequest: CompareRequest | null`（runCompare 成功时保存）
- [ ] 失败/demo 路径清空或保留（决定：仅真实成功保存，demo 不保存——Q1「仅真实比较导出」）

## 8. UI 导出入口（`src-renderer/App.tsx`）

- [ ] 在结果区新增「导出审查报告」按钮
- [ ] 点击后构建 manifest（用 `lastCompareRequest` + 当前 `result` + `ipc.app.version()`）
- [ ] 下载 JSON + Markdown 两个文件（复用 `downloadJsonFile` / `downloadTextFile`）
- [ ] toast 提示覆盖状态（若非 ok）

## 9. 测试

- [ ] `deriveCoverageStatus`：ok / permission-denied / no-row-identity / over-threshold / aborted / error / grant-invisible 全分支
- [ ] `redactDmlSql`：字符串/数字/日期/Buffer/NULL/反引号/多行/注释
- [ ] `serializeManifest`：byte 稳定、合法 JSON、版本号可解析
- [ ] `manifestToMarkdown`：含头部/摘要表/DDL 块/覆盖说明/保密声明
- [ ] 集成：一次真实比较的 CompareResult → manifest → 重新解析回等价语义（AC3）
- [ ] 秘密检查：manifest 的 JSON 字符串不含任何 `password` / `privateKey` / `passphrase` / `SecretBundle` 字段

## 10. 规格同步（Phase 3.3）

- [ ] `dbeaver-export.md` 或新增 `manifest-export.md`：记录 ReviewManifest 契约、CoverageStatus 枚举、脱敏器规则、IPC 签名
- [ ] `type-safety.md`：补 `ReviewManifest` / `CoverageStatus` 到共享类型清单
- [ ] `quality-guidelines.md`：导出入口需 CDP 验证（点击下载断言文件内容）

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
| `src-core/manifest.ts` | 新逻辑，纯函数 | 无破坏性（新增） |
| `src-renderer/store.ts` | 加 lastCompareRequest | 不影响既有字段 |
| `src-renderer/App.tsx` | 新增按钮 | 可单独回滚步骤 8 |
| `src-main/main.ts` | 新增 IPC | 纯增量 |

## Review Gates

1. 步骤 1–4 后：typecheck + 单测全绿
2. 步骤 9 后：全分支测试通过
3. 四件套全绿后进入 `trellis-check`

## Before `task.py start`

- [ ] `implement.jsonl` / `check.jsonl` 各含至少一条真实 spec 条目
- [ ] 用户已明确批准最终规划摘要