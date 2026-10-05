# E2E Harness

Persistent CDP/E2E regression harness for SqlDiff desktop export paths. Uses Playwright's native `electron.launch()` fixture to drive a real Electron instance, assert on UI interactions, and verify exported file contents.

## Scope

- DBeaver export: `data-sources-sqldiff.json` JSON structure, MySQL fields, SSH handlers, no-secrets
- DataGrip export: three-file XML (`dataSources.xml` + `dataSources.local.xml` + `sshConfigs.xml`), UUID determinism, SSH collapse, no-secrets
- UI smoke: button click → modal → node selection → confirm → toast (proves the UI path is reachable end-to-end)
- Determinism: byte-identical output across different input orders

Not covered: connection tests, comparison flows, or any non-export path. Each feature builds its own E2E as needed.

## Prerequisites

- `@playwright/test` in `devDependencies` (not `dependencies`)
- `npm run build` must succeed first (Playwright launches the built app, not the dev server)
- macOS local is the primary validation target; Linux CI is a follow-up (no Linux target in `electron-builder.yml`)

## Running

```bash
cd apps/desktop
npm run build   # required — Playwright uses the built dist, not Vite dev server
npm run e2e
```

## Architecture

```
apps/desktop/
  e2e/
    playwright.config.ts    # testDir='./specs', workers=1, timeout=60s, HTML+list reporters
    specs/
      dbeaver-export.spec.ts  # 3 tests: direct node, SSH nodes, determinism
      datagrip-export.spec.ts # 5 tests: direct, pwd-SSH, key-SSH, SSH collapse, determinism
      ui-smoke.spec.ts        # 3 tests: UI click path (DataGrip export, DBeaver empty-select, DBeaver full export)
    helpers/
      electron.ts           # launchElectron(nodes) / closeElectron(handle) — temp userDataDir, env injection
      assertions.ts         # assertWellFormedXml, extractDataSources, extractSshConfigs, assertNoSecrets, parseDBeaverJson
      env-loader.ts         # loadEnvFile / readRequiredEnv / missingEnvReason — .env.e2e 装载与必填变量诊断（纯函数，可单测）
    fixtures/
      test-nodes.ts         # 5 test nodes (direct, pwd-SSH, key-SSH, 2 collapse nodes)
  src-main/
    save-file.ts            # E2E hook: getE2eSaveDir() checks env var, saveFilesToDir() writes directly
  tests/
    main/
      save-file.test.ts     # saveFilesToDir unit tests + env branch coverage
      env-loader.test.ts    # .env.e2e 加载三态 + 必填变量诊断（被测模块在 e2e/helpers/ 下）
```

## E2E Save Dialog Strategy

Electron's `dialog.showSaveDialog` is a synchronous main-process API that CDP does not cover. The harness uses an **environment variable injection** strategy:

```
Playwright _electron.launch({ env: { SQLDIFF_E2E_SAVE_DIR: <tmpdir> } })
  → Electron main process starts with SQLDIFF_E2E_SAVE_DIR set
  → saveFiles() checks getE2eSaveDir() at entry
  → if set: calls saveFilesToDir(request, dir) — writes directly, no dialog
  → if not set: production path unchanged (system dialog)
```

**Security constraint**: `getE2eSaveDir()` only checks `process.env.SQLDIFF_E2E_SAVE_DIR?.trim() || null`. No flag-file fallback — a fixed path would be writable by any local user (symlink attack). Empty string and whitespace-only values are treated as unset.

**Production safety**: When `SQLDIFF_E2E_SAVE_DIR` is absent or empty, `saveFiles()` follows the original dialog path with zero behavioral change. The E2E branch is a pure additive early-return.

## Test Data Injection

Test nodes are injected **before** Electron launches, by writing `nodes.json` to a temp `userDataDir`:

```
launchElectron(nodes):
  1. mkdtempSync(tmpdir + '/sqldiff-e2e-')
  2. mkdirSync(userDataDir, downloadsDir)
  3. writeFileSync(userDataDir/nodes.json, JSON.stringify(nodes))
  4. _electron.launch({ args: [cwd, '--disable-gpu', '--no-sandbox'],
                        env: { SQLDIFF_USER_DATA_DIR, SQLDIFF_E2E_SAVE_DIR } })
  5. app.firstWindow() → waitForLoadState('domcontentloaded') → waitForTimeout(1500)
```

This exercises the full real path: `loadNodes` → `validateNodeMeta` → render. No runtime API injection.

## Assertion Strategy

### XML (DataGrip)

| Function | Purpose |
|---|---|
| `assertWellFormedXml(xml)` | `<?xml version="1.0"` declaration + `<project version="4">` root + tag closure + quote pairing |
| `extractDataSources(xml)` | Regex extract `<data-source name=... uuid=...>` pairs |
| `extractSshConfigs(xml)` | Regex extract `<sshConfig ... host=... port=... id=...>` |

### JSON (DBeaver)

| Function | Purpose |
|---|---|
| `parseDBeaverJson(json)` | Parse to `{ folders, connections, connectionTypes }` |
| `assertDBeaverTopology(connections)` | Check `provider=mysql`, `driver=mysql8`, `MANUAL`, `native`, `auth-properties.userName` |

### No-Secrets

`assertNoSecrets(content)` asserts absence of: `password`, `passphrase`, `keyPath`, `keyValue`, `BEGIN OPENSSH`, `BEGIN RSA`, `BEGIN EC`. **Whitelisted**: `save-password: false` (DBeaver control field) and `authType: PASSWORD/PUBLIC_KEY` (DataGrip enum) — these are legitimate non-secret values.

### Determinism

Two exports with the same node set but different input orders → byte-identical file contents. Verified by `assert.strictEqual(file1.content, file2.content)`.

## Testing Layers

| Layer | Tests | Method |
|---|---|---|
| Unit (Vitest) | `save-file.test.ts` | `saveFilesToDir` file/bundle/directory creation + env branch + whitespace boundary |
| E2E depth (Playwright) | `dbeaver-export.spec.ts`, `datagrip-export.spec.ts` | `page.evaluate` → direct IPC call → assert file contents |
| E2E UI smoke (Playwright) | `ui-smoke.spec.ts` | `page.click` → modal → checkbox → confirm → toast → assert files |

The split is intentional: depth tests use API calls (faster, more stable for content assertions); UI smoke tests use real clicks (proves the UI path is reachable). Both are required.

## Time Budget

| Spec | Tests | Estimated |
|---|---|---|
| DataGrip export | 5 | ~2s |
| DBeaver export | 3 | ~2s |
| UI smoke | 3 | ~14s |
| **Total** | **11** | **~18s** |

Far within the 3-min CI threshold. Each spec's `test.beforeAll` launches Electron once; subsequent tests reuse the same instance.

## Rollback

- Remove `e2e/` directory
- Remove `saveFilesToDir` and `getE2eSaveDir` from `save-file.ts`
- Remove `SQLDIFF_E2E_SAVE_DIR` check from `saveFiles()`
- Remove `@playwright/test` from `devDependencies` and `e2e` script from `package.json`
- Remove `.gitignore` entries for `e2e/test-results/` and `e2e/playwright-report/`

None of these affect any existing product behavior.

## Preflight E2E on Real MySQL

### 触发方式

真机 host 与密码统一放在 `apps/desktop/.env.e2e`（gitignored，模板见 `.env.e2e.example`），
由 `e2e/playwright.config.ts` 用 dotenv 自动加载 —— **填好文件即可跑，无需手工 export**。

```bash
# 触发方式（不合并到 CI，依赖外部 MySQL 可达性）
npm run e2e:preflight:mysql      # MySQL 8.0.46（E2E_RUN_PREFLIGHT_MYSQL）
npm run e2e:preflight:mysql57    # MySQL 5.7  （E2E_RUN_PREFLIGHT_MYSQL57，独立开关）
```

未设置对应开关时整套 spec 静默 skip，不影响 `npm run e2e` 主 harness。
注意开关是从 `.env.e2e` 加载的：一旦把 `E2E_RUN_PREFLIGHT_MYSQL=1` 写进文件，
`npm run e2e`（`testDir: './specs'` 会收集全部 spec）也会把真机 preflight spec 一起跑起来。
模板默认给 0 就是为了让主 harness 保持安静——只想跑真机用例时用上面两个专用 script。

### `.env.e2e` 加载语义（安全边界）

`e2e/helpers/env-loader.ts` 的 `loadEnvFile()` 被 `playwright.config.ts` 在收集测试前调用：

| 情形 | 行为 |
|---|---|
| `process.env` 已存在的键 | **不覆盖**（外部 / CI 注入优先） |
| 仅 `.env.e2e` 里存在的键 | 注入 |
| 外部注入的是空字符串 | 同样算"已设置"，不覆盖（判据是 `hasOwnProperty`，与 dotenv `override:false` 一致） |
| `.env.e2e` 不存在 | 静默返回 `loaded:false`，不抛错 |

"已有优先"是**安全边界**而非便利性：否则 CI 注入的 secret 会被本地文件里的旧值顶掉。
缺失文件必须静默，因为 `.env.e2e` 不存在是**正常状态**（主 harness 不需要它），
诊断交由各 spec 自己的 skip 消息给出。三态由 `tests/main/env-loader.test.ts` 锁住。

### 为什么 host 没有代码默认值

目标机是**虚拟机，IP 每次重启都会变**。因此 spec 里 host 不带默认值：写死后 IP 一变，
spec 要么静默 skip（看不出原因），要么**连到错误的那台机器**——后者更糟，因为它看起来跑通了。
缺失 host 时 spec skip 并点名缺哪个变量，同时说明"IP 是动态的、请填 `.env.e2e`"，
避免下一个维护者把默认值加回去。

### 版本矩阵

| 目标 | MySQL 版本 | INSTANT ADD | INSTANT DROP |
|---|---|---|---|
| `E2E_MYSQL_9_*` | 8.0.46 | ✅ (≥8.0.12) | ✅ (≥8.0.29) |
| `E2E_MYSQL_57_*` | 5.7.44 | ❌ | ❌（ADD/DROP COLUMN 均走 INPLACE + rebuild） |

两台构成 INSTANT 能力的**两侧极端**。8.0.12–8.0.28 这段中间地带（DROP 仍 INPLACE）
当前无真机覆盖，属已知的 Out of Scope。

变量名 `E2E_MYSQL_9_*` 是单机化后遗留的**不透明标签**（`9` 不再对应任何具体机器）。
刻意不改名：改名只会让已有 `.env.e2e` 与外部文档失效，版本语义由 describe 名承载。

### Fixture 8 表清单

| 表名 | 特征 | 触发规则 |
|---|---|---|
| `orders_empty` | 有 PK、空表 | baseline |
| `users_big` | 有 PK、~100 万行 | LARGE_TABLE_INSTANT_ADD, BIG_TABLE_COPY |
| `products_no_pk` | 无主键 | NO_PRIMARY_KEY |
| `tags_unique` | 有 UNIQUE 索引 | ADD_UNIQUE_INDEX rebuild |
| `events_fk` | 有外键 | FK 相关分类 |
| `config_wide` | 100 列宽表 | 列多场景 |
| `audit_pk_unique` | PK + UNIQUE | 组合索引 |
| `slow_log_no_index` | 有数据无索引 | 无索引场景 |

### 断言清单（11 项）

1. `schemaVersion === 2`（`assertReportStructure` 实际断言；见 `preflight.md` §15 schema v2）
2. `server.mysql_version` fact 与 fixture 版本一致
3. `table.users_big.rows` fact > 0（information_schema 估算值）
4. ADD_COLUMN Inference `algorithm === 'INSTANT'`（8.0.46 侧；5.7 侧见 `assertInplaceBaseline`）
5. DROP_COLUMN Inference `algorithm` 分叉：5.7 → INPLACE；8.0.46 → INSTANT
6. OTHER 分类落 Unknown（`unparsed-ddl`）
7. `LARGE_TABLE_INSTANT_ADD` issue 存在（severity='warn'）
8. `READ_ONLY_TARGET` block issue 触发（临时 `SET GLOBAL read_only=1`）
9. `permissions.visibility` fact 存在
10. 6 类 Fact category 覆盖（server/variables/table/index/replication/permissions）
11. verdict.level 有效（pass/warn/block/unknown）

### 5.7 INPLACE baseline（已覆盖）

MySQL 5.7 分支由 `preflight-on-mysql-5-7.spec.ts` 覆盖（`npm run e2e:preflight:mysql57`，
开关 `E2E_RUN_PREFLIGHT_MYSQL57`，env 约定 `E2E_MYSQL_57_*`，见 `.env.e2e.example` 目标 2）。
两段对比：5.7（ADD/DROP 均 INPLACE + rebuild，全报告无 INSTANT）/ 8.0.46（双 INSTANT）。
5.7 反向断言：`BIG_TABLE_COPY` block（rebuild 路径）存在，`LARGE_TABLE_INSTANT_ADD` 永不触发。

5.7 目标机的 `root` 仅有 `root@localhost`，TCP 远程登录被拒，需专用远程账号：

```sql
CREATE USER 'sqldiff'@'%' IDENTIFIED BY '<pw>';
GRANT ALL PRIVILEGES ON `sqldiff_preflight_test_5_7`.* TO 'sqldiff'@'%';
GRANT SELECT, REPLICATION CLIENT, SUPER ON *.* TO 'sqldiff'@'%';
```

`ALL` on fixture 库覆盖建表/灌数据/删库；全局 `SELECT` 读 `information_schema`；
`REPLICATION CLIENT` 服务 `SHOW SLAVE STATUS`（5.7 无 `SHOW REPLICA STATUS`，走降级链）；
`SUPER` **唯一用途**是 `READ_ONLY_TARGET` 用例的 `SET GLOBAL read_only`，
spec 的 `finally` 负责还原（read_only 残留会影响开发机后续使用）。
