# Main-Process and Shared-Core Structure

## Runtime Boundary

In this repository, “backend” means the Electron main process plus code shared with the renderer. It is not a web API service.

```text
apps/desktop/
├── src-main/                 # Node/Electron runtime
│   ├── main.ts               # app lifecycle, BrowserWindow, ipcMain handlers
│   ├── preload.ts            # contextBridge API and renderer-facing input types
│   ├── vault.ts              # safeStorage adapter, AES-GCM, secret files, legacy import
│   ├── store-json.ts         # nodes.json/history.json persistence
│   ├── connection.ts         # mysql2 pools, ssh2 one-hop tunnel cache
│   ├── metadata.ts           # information_schema and SHOW CREATE
│   ├── visibility.ts         # (core) pure SHOW GRANTS text → per-database visibility
│   ├── grants.ts             # SHOW GRANTS FOR CURRENT_USER() probe
│   ├── data-fetch.ts         # COUNT and keyset-paginated SELECT
│   ├── data-run.ts           # per-table data comparison orchestration
│   ├── compare-run.ts        # A/B compare orchestration, grant narrowing, and history
│   ├── preflight-collect.ts  # (v1 preflight) six read-only collectors
│   ├── preflight-run.ts      # (v1 preflight) 8-stage orchestration + PreflightRequest/PreflightExportResult
│   ├── download.ts           # will-download save-path policy
│   └── converters/           # DBeaver exporter + future third-party importers
├── src-core/                 # deterministic comparison/filter/risk logic
│   ├── types.ts              # cross-process domain contracts
│   ├── diff.ts               # ported structural diff semantics
│   ├── compare.ts            # DiffItem assembly, sorting, export text
│   ├── compare-filter.ts     # browser-safe shared filters
│   ├── data-*.ts             # row identity, DML generation, option defaults
│   ├── classify.ts / risk.ts # local tags and explanations
│   ├── preflight-types.ts    # (v1 preflight) PreflightReport v1 contract + thresholds
│   ├── preflight-ddl.ts      # (v1 preflight) classifyDdl + Online DDL matrix + version compare
│   ├── preflight-rules.ts    # (v1 preflight) nine rule evaluators
│   ├── preflight.ts          # (v1 preflight) buildPreflightReport + serialize + markdown
│   └── ipc-error.ts          # renderer-safe IPC error sanitization
├── scripts/                  # repeatable tooling; icon-source.html + generator
└── build/icon/               # generated, committed packaging assets
```

## Ownership Rules

- `src-main/main.ts` is the composition root for Electron lifecycle, window creation, IPC registration, clipboard, downloads, and shutdown cleanup. Keep handlers thin; delegate work as `registerNodesIpc` does to `vault.ts` and `store-json.ts`, and `compare.run` does to `compare-run.ts`.
- `src-main/preload.ts` is the only supported renderer-to-main bridge. It exposes the typed `SqlDiffApi` as `window.sqldiff`; renderer modules must not import `ipcRenderer` directly.
- `src-main/connection.ts` owns transport and resource lifetime. `createMysqlPool` creates pools, while callers close them. `ensureTunnel` owns the per-node SSH cache and `main.ts` invokes `closeAll` from its `before-quit` hook (the hook starts the async close but does not await it).
- `src-main/metadata.ts`, `data-fetch.ts`, `grants.ts`, and the `connection.ts` ping helpers own read-only SQL execution. Comparison policy belongs in `src-core` or the run orchestrators, not in SQL string construction. `grants.ts` is a probe, not a policy: it executes one fixed statement and hands the result to the pure `src-core/visibility.ts` parser.
- Boundary-layer decisions stay out of `src-core`. `narrowToSharedVisibility` lives in `compare-run.ts` because it needs the node's database names, and it runs before `compareRun` so the pure function never learns about grants. The parser itself stays in `src-core/visibility.ts` because "grant text → verdict" is pure and unit-testable without a database; it must not import `DbQueryable` or anything from `src-main` at runtime.
- `src-core` owns deterministic logic shared by main and renderer. `src-core/compare-filter.ts` explicitly exists so renderer filtering does not pull in `node:crypto`, `mysql2`, or `ssh2`; follow that dependency rule for new shared helpers. `src-core/visibility.ts` is subject to the same rule — regex over strings only.
- `src-core/types.ts` is the normal source of truth for domain types. `DatabaseMetadata` currently lives in `src-main/metadata.ts`, so consumers in `compare.ts`, `compare-filter.ts`, and `demo.ts` use `import type`; do not turn that into a runtime import.
- `src-main/converters/dbeaver.ts` is the current SqlDiff → DBeaver topology exporter; `dbeaver.test.ts` is its focused regression. See the [DBeaver Export Contract](./dbeaver-export.md). `src-main/converters/index.ts` remains the future third-party → SqlDiff `NodeConverter` seam, which is a different direction and must not be used for export.
- `src-core/preflight-*.ts` is the pure-function layer for production preflight (types, DDL classifier, Online DDL matrix, rule evaluators, report builder, serializer, markdown, file names). It carries no Node or `mysql2` imports and is safe to run in both the renderer (which builds and serializes the report) and main (which feeds facts into `buildPreflightReport`). `src-main/preflight-*.ts` is the collection and orchestration layer: `preflight-collect.ts` owns the read-only SQL statements and per-category collectors; `preflight-run.ts` owns the 8-stage orchestration, pool lifecycle, and the `preflight:run` IPC payload types (`PreflightRequest` / `PreflightExportResult`). Keep SQL strings in `preflight-collect.ts`, keep the classifier + matrix in `preflight-ddl.ts`, and keep the rules in `preflight-rules.ts`; do not leak SQL into `preflight-run.ts` and do not leak pool logic into `preflight-*.ts` under `src-core`. See the [Preflight Contract](./preflight.md).

## Reference-Only Areas

- `mysqldiff/` is the read-only legacy CLI. Its `DB.js`, `Tools.js`, and `mysqldiff` script define compatibility behavior referenced by comments and tests, but product changes belong under `apps/desktop/`.
- `apps/desktop-mock/index.html` is an interaction reference for the three-pane layout. Do not make it the source of business behavior or modify it to fix a production bug.
- `dist-main/`, `dist-renderer/`, and `release/` are generated and gitignored. Source maps and packaged output are not edit points.

## Naming and Placement

- Use kebab-case for modules (`compare-filter.ts`, `data-fetch.ts`) and PascalCase for React components (`NodeLibrary`, `SqlPreview`).
- Use camelCase for functions and methods, and uppercase snake case for constants such as `MAX_CONCURRENCY` and `HISTORY_LIMIT`.
- Most tests are colocated as `<module>.test.ts`. The current storage exception is `src-core/vault.test.ts`, which exercises `src-main/vault.ts` and `src-main/store-json.ts`; keep that exception visible rather than inventing a second test location. Renderer-only pure helpers stay in `src-renderer`; logic needed by both processes belongs in `src-core`.
- Use `.mjs` for repository tooling executed directly by Node, as in `scripts/generate-icon.mjs`.
