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
    fixtures/
      test-nodes.ts         # 5 test nodes (direct, pwd-SSH, key-SSH, 2 collapse nodes)
  src-main/
    save-file.ts            # E2E hook: getE2eSaveDir() checks env var, saveFilesToDir() writes directly
    save-file.test.ts       # saveFilesToDir unit tests + env branch coverage
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
