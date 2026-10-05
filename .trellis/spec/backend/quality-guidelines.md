# Main-Process Quality, Security, and Release Guidelines

## Required Quality Gate

The app uses strict TypeScript and unused-symbol checks in `apps/desktop/tsconfig.json`, plus the recommended JavaScript/TypeScript ESLint sets in `eslint.config.mjs`. There is no formatter or React-specific lint plugin, so match the existing two-space, semicolon, single-quote style and do not claim formatting is automated.

Run from `apps/desktop`:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Use focused tests while iterating, for example `npm test -- tests/core/diff.test.ts`. `npm run pack` is reserved for icon or release changes.

## Security Invariants

- Keep Electron locked down as configured in `createWindow`: `contextIsolation: true`, `nodeIntegration: false`, and an explicit preload. Do not expose arbitrary IPC or Node primitives through `contextBridge`.
- The renderer must not directly import `node:*`, `electron`, `mysql2`, or `ssh2`. `src-core/compare-filter.ts` was extracted specifically to keep shared renderer logic browser-safe.
- Store only `NodeMeta` and `HistoryEntry` in `nodes.json` / `history.json`. `SecretBundle` goes through `Vault` to safeStorage or AES-GCM files; exports use `ExportJSON.secretsEnc`, never plaintext secrets.
- Validate IPC, imported JSON, and persisted records at runtime. Keep `assertSafeNodeId`, `assertNonEmpty`, `normalizePort`, `isNodeMeta`, and `Vault.importDecrypted` checks at their boundaries.
- Escape identifiers in executed MySQL queries and parameterize values. Follow `escapeIdent`, `escapeDataIdent`, and `fetchPageByPK`; see [Database Guidelines](./database-guidelines.md). Generated structural DDL in `src-core/diff.ts` currently follows the legacy backtick interpolation, so hardening that output is a separate product/security change.
- Do not add a path that executes generated `DiffItem.sql`. The product is a read-only comparison tool.

## Comparison Invariants

These are correctness contracts, not cleanup opportunities:

- Direction is A source/expected to B target. `compareRun` and `diffDataRows` generate SQL that upgrades B toward A.
- Structural semantics follow the legacy functions named in `src-core/diff.ts`: `filterTable`, `filterField`, `diffTable`, `diffTableField`, `filterProcedure`, `changeProcedure`, and `diffProcedure`. Preserve intentional legacy behavior unless a task explicitly changes it.
- Each emitted table statement is one `DiffItem`. `splitStatements` handles table ALTER output and adds `:s<n>` ids; views, procedures, and functions remain atomic because `makeItems` calls `splitStatements` only for table objects (routine output can contain `DELIMITER` blocks).
- Classification stays independent and ordered: DROP wins unless CREATE is also present; CREATE OR REPLACE is CHANGE; `aspectOf` checks table before primary/index/column; `verbOf` uses the first effective keyword.
- Filtering and export must describe the same `DiffItem` model. The renderer's table and unselected bulk copy/export use its final filtered list; selecting a `DiffItem` intentionally narrows `SqlPreview` copy/export/risk/rollback to that item. Toggle counters intentionally use an upstream stage; `recountStats` and compare-result statistics must be updated together whenever `DiffItem` or `CompareStats` gains a field.
- Data comparison uses PK first, then an all-`NOT NULL` UNIQUE identity. No identity skips the table, mismatched identities mark that table failed, and a threshold confirmation reruns with explicit consent.
- Close assigned pools in `finally`, reuse/close SSH tunnels through `connection.ts`, and cancel long data reads through the `AbortSignal` path; review the documented partial-construction gap separately.
- `file.save` in `src-main/save-file.ts` is the only disk-writing path for exports. It prompts with the system save dialog (single file) or a directory picker (multi-file bundle), then returns the real absolute paths. Every export success toast must include that returned path; never report an optimistic "已导出" with no location. `registerWillDownload` is a fallback for the no-main-process Blob path only, not the primary export mechanism.

## Test Strategy

Tests are Vitest files under `apps/desktop/tests/`, never beside the implementation. They avoid live infrastructure by extracting pure functions or injecting minimal fakes. `tests/{core,main,converters,renderer}/` mirrors the tested source directory, and file names stay equal to the module under test:

- legacy structural semantics and assembly: `tests/core/diff.test.ts`;
- connection configuration and tunnel cache: `tests/main/connection.test.ts`;
- SQL text, escaping, result shapes, and concurrency: `tests/main/metadata.test.ts` and `tests/main/data-fetch.test.ts`;
- secret persistence/export and JSON storage: `tests/core/vault.test.ts` (it exercises the main-process `vault.ts` and `store-json.ts`, so it stays the cross-layer exception);
- row identity decisions: `tests/main/data-run-identity.test.ts`;
- download, export-save, and IPC error regressions: `tests/main/download.test.ts`, `tests/main/save-file.test.ts`, and `tests/core/ipc-error.test.ts`;
- compare/data 应用服务集成测试（cleanup/cancel/partial failure）：`tests/main/compare-run.integration.test.ts` 与 `tests/main/data-run.integration.test.ts`（模块级 mock 连接层，被测编排逻辑全真）。

Add or update a test in the mirror directory for the changed layer. `vitest.config.ts` includes only `tests/**/*.test.ts`, and both `tsconfig.json` and `tsconfig.main.json` include `tests`, so a misplaced file fails the run rather than going unnoticed. Test null/empty input, compatibility edges, and cleanup paths, not just the happy path. For filesystem tests, use temporary directories and remove them in `afterEach`, as in `vault.test.ts`.

### Mandatory: every feature and optimization ships tests

No feature, fix, refactor, or optimization is complete without test cases in `tests/`. This is a review-gate item, not a preference — an untested change is an incomplete change even when it works.

Before reporting such work done, confirm each of these:

- Every new or changed exported function has direct cases covering a normal path **and** a boundary or failure path. Indirect coverage (a caller happens to reach it) does not count; import and call it.
- Security primitives get adversarial cases, not just happy paths. `assertSafeNodeId` requires traversal shapes (`../etc/passwd`, `..`, `a/b`, `a\b`, `/abs/path`, `secrets/../../x`), empty string, over-length, and non-string input — not only the length check.
- Assertions target the **contract**, never a dependency's internal formatting. Assert that formatting happened, that keywords are uppercased, that clauses are on separate lines — not the exact indent width a formatter version happens to emit. Pinning third-party output makes the suite red on a patch upgrade while product behavior is unchanged.
- Deferred cleanup needs fake timers plus an explicit advance. A `setTimeout` that releases an object URL after `afterEach` ran leaks into the next test's global stub; see `tests/renderer/sql-io.test.ts`.
- Pure test tasks must not touch product code. When a test exposes a product bug, record it in the task notes with severity and a reproduction path, and open a separate task. Mixing the fix in blurs the diff and skips its own acceptance review.
- Fixtures use obviously fake credentials (`fake-*`); never a real host, password, or key.

To prove a new assertion is not vacuous, mutate the product code it targets (make the check pass-through, or weaken a guard), confirm the suite goes red, then restore. A green-after-mutation test proves nothing.

For UI, data-flow, clipboard, confirm-dialog, or download changes, use the trusted-input CDP procedure in [Frontend Quality Guidelines](../frontend/quality-guidelines.md#cdp-end-to-end-checks).

## Icons and Packaging

`scripts/icon-source.html` is the editable source. `scripts/generate-icon.mjs` renders it with offscreen Electron windows at all required sizes, validates PNG dimensions, builds `icon.ico`, and uses macOS `iconutil` to build `icon.icns`. `build/icon/` contains committed outputs referenced by `electron-builder.yml`.

- After changing the icon source or size lists, run `npm run icon`, inspect the generated assets, and only then run `npm run pack`.
- ICNS generation requires macOS. Do not hand-edit generated PNG/ICO/ICNS files; change the source/generator and regenerate.
- `electron-builder.yml` explicitly targets Windows NSIS x64 and macOS DMG arm64/x64, and explicitly references `build/icon/icon.ico` and `icon.icns`. Preserve those references when changing packaging.
- `npm run pack` rebuilds before packaging. If Electron or builder binaries fail to download with a GitHub EOF, the recorded fallback is `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`.
- Current packages are unsigned; code signing, notarization, and automatic updates are not configured. Do not report those as verified.
- Release output is gitignored. Validate generated package contents and architectures separately; the previous evidence and commands are recorded in `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md`.

## Review Checklist

- The change is in the correct runtime layer and does not widen Electron privileges.
- MySQL access remains read-only, executed identifiers are escaped, assigned resources are closed, and generated SQL is never sent to a pool; review the documented partial-construction gap separately.
- Real secrets and exported data remain encrypted and absent from diagnostics/tests.
- Shared contracts, handlers, preload methods, and renderer callers stay synchronized.
- DBeaver topology export follows the [DBeaver Export Contract](./dbeaver-export.md): keep the exporter deterministic, validate the IPC boundary with the documented prefixes, and prove the topology-only/no-secret path with its focused tests and CDP save check.
- Export paths go through `file.save` and report the real saved location; cancel is a non-error outcome, not a failure.
- Regression tests cover the changed invariant; full typecheck, lint, test, and build pass.
- Every feature or optimization landed with tests in `tests/`, asserting contracts rather than dependency internals (see Test Strategy).
- Generated `dist-*` / `release/` files were not edited.
