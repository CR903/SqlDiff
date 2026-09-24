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

Use focused tests while iterating, for example `npm test -- src-core/diff.test.ts`. `npm run pack` is reserved for icon or release changes.

## Security Invariants

- Keep Electron locked down as configured in `createWindow`: `contextIsolation: true`, `nodeIntegration: false`, and an explicit preload. Do not expose arbitrary IPC or Node primitives through `contextBridge`.
- The renderer must not directly import `node:*`, `electron`, `mysql2`, or `ssh2`. `src-core/compare-filter.ts` was extracted specifically to keep shared renderer logic browser-safe.
- Store only `NodeMeta` and `HistoryEntry` in `nodes.json` / `history.json`. `SecretBundle` goes through `Vault` to safeStorage or AES-GCM files; exports use `ExportJSON.secretsEnc`, never plaintext secrets.
- Validate IPC, imported JSON, and persisted records at runtime. Keep `assertSafeNodeId`, `assertNonEmpty`, `normalizePort`, `isNodeMeta`, and `Vault.importDecrypted` checks at their boundaries.
- Escape identifiers in executed MySQL queries and parameterize values. Follow `escapeIdent`, `escapeDataIdent`, and `fetchPageByPK`; see [Database Guidelines](./database-guidelines.md). Generated structural DDL in `src-core/diff.ts` currently follows the legacy backtick interpolation, so hardening that output is a separate product/security change.
- Do not add a path that executes generated `DiffItem.sql`. The product is a read-only comparison tool.
- Keep `mysqldiff/` unchanged. Compatibility work belongs in `src-core` and must be justified by a test against current behavior or an approved product decision.

## Comparison Invariants

These are correctness contracts, not cleanup opportunities:

- Direction is A source/expected to B target. `compareRun` and `diffDataRows` generate SQL that upgrades B toward A.
- Structural semantics follow the legacy functions named in `src-core/diff.ts`: `filterTable`, `filterField`, `diffTable`, `diffTableField`, `filterProcedure`, `changeProcedure`, and `diffProcedure`. Preserve intentional legacy behavior unless a task explicitly changes it.
- Each emitted table statement is one `DiffItem`. `splitStatements` handles table ALTER output and adds `:s<n>` ids; views, procedures, and functions remain atomic because `makeItems` calls `splitStatements` only for table objects (routine output can contain `DELIMITER` blocks).
- Classification stays independent and ordered: DROP wins unless CREATE is also present; CREATE OR REPLACE is CHANGE; `aspectOf` checks table before primary/index/column; `verbOf` uses the first effective keyword.
- Filtering and export must describe the same `DiffItem` model. The renderer's table and unselected bulk copy/export use its final filtered list; selecting a `DiffItem` intentionally narrows `SqlPreview` copy/export/risk/rollback to that item. Toggle counters intentionally use an upstream stage; `recountStats` and compare-result statistics must be updated together whenever `DiffItem` or `CompareStats` gains a field.
- Data comparison uses PK first, then an all-`NOT NULL` UNIQUE identity. No identity skips the table, mismatched identities mark that table failed, and a threshold confirmation reruns with explicit consent.
- Close assigned pools in `finally`, reuse/close SSH tunnels through `connection.ts`, and cancel long data reads through the `AbortSignal` path; review the documented partial-construction gap separately.
- Keep renderer downloads and main-process save policy paired. `downloadSqlFile` initiates the Blob anchor and `registerWillDownload` sets the Downloads path. The renderer success toast is optimistic because there is no completion IPC; CDP/file inspection is the proof of a successful write.

## Test Strategy

Tests are Vitest files, mostly colocated, and avoid live infrastructure by extracting pure functions or injecting minimal fakes. The current storage exception is `src-core/vault.test.ts`, which exercises `src-main/vault.ts` and `src-main/store-json.ts`:

- legacy structural semantics and assembly: `src-core/diff.test.ts`;
- connection configuration and tunnel cache: `src-main/connection.test.ts`;
- SQL text, escaping, result shapes, and concurrency: `src-main/metadata.test.ts` and `src-main/data-fetch.test.ts`;
- secret persistence/export and JSON storage: `src-core/vault.test.ts` (it exercises the main-process `vault.ts` and `store-json.ts`);
- row identity decisions: `src-main/data-run-identity.test.ts`;
- download and IPC error regressions: `src-main/download.test.ts` and `src-core/ipc-error.test.ts`.

Add or update a test in the same relevant layer as the change, preserving the documented storage exception. Test null/empty input, compatibility edges, and cleanup paths, not just the happy path. For filesystem tests, use temporary directories and remove them in `afterEach`, as in `vault.test.ts`.

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
- Regression tests cover the changed invariant; full typecheck, lint, test, and build pass.
- `mysqldiff/` has no task-authored diff (compare with the task baseline because its standalone working tree may already be dirty), and generated `dist-*` / `release/` files were not edited.
