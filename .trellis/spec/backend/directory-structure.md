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
│   ├── data-fetch.ts         # COUNT and keyset-paginated SELECT
│   ├── data-run.ts           # per-table data comparison orchestration
│   ├── compare-run.ts        # A/B compare orchestration and history
│   ├── download.ts           # will-download save-path policy
│   └── converters/           # future third-party node importers
├── src-core/                 # deterministic comparison/filter/risk logic
│   ├── types.ts              # cross-process domain contracts
│   ├── diff.ts               # ported structural diff semantics
│   ├── compare.ts            # DiffItem assembly, sorting, export text
│   ├── compare-filter.ts     # browser-safe shared filters
│   ├── data-*.ts             # row identity, DML generation, option defaults
│   ├── classify.ts / risk.ts # local tags and explanations
│   └── ipc-error.ts          # renderer-safe IPC error sanitization
├── scripts/                  # repeatable tooling; icon-source.html + generator
└── build/icon/               # generated, committed packaging assets
```

## Ownership Rules

- `src-main/main.ts` is the composition root for Electron lifecycle, window creation, IPC registration, clipboard, downloads, and shutdown cleanup. Keep handlers thin; delegate work as `registerNodesIpc` does to `vault.ts` and `store-json.ts`, and `compare.run` does to `compare-run.ts`.
- `src-main/preload.ts` is the only supported renderer-to-main bridge. It exposes the typed `SqlDiffApi` as `window.sqldiff`; renderer modules must not import `ipcRenderer` directly.
- `src-main/connection.ts` owns transport and resource lifetime. `createMysqlPool` creates pools, while callers close them. `ensureTunnel` owns the per-node SSH cache and `main.ts` invokes `closeAll` from its `before-quit` hook (the hook starts the async close but does not await it).
- `src-main/metadata.ts`, `data-fetch.ts`, and the `connection.ts` ping helpers own read-only SQL execution. Comparison policy belongs in `src-core` or the run orchestrators, not in SQL string construction.
- `src-core` owns deterministic logic shared by main and renderer. `src-core/compare-filter.ts` explicitly exists so renderer filtering does not pull in `node:crypto`, `mysql2`, or `ssh2`; follow that dependency rule for new shared helpers.
- `src-core/types.ts` is the normal source of truth for domain types. `DatabaseMetadata` currently lives in `src-main/metadata.ts`, so consumers in `compare.ts`, `compare-filter.ts`, and `demo.ts` use `import type`; do not turn that into a runtime import.
- `src-main/converters/index.ts` defines the future `NodeConverter` seam. A converter returns metadata plus an in-memory secret; persistence remains with `Vault` and `store-json.ts`.

## Reference-Only Areas

- `mysqldiff/` is the read-only legacy CLI. Its `DB.js`, `Tools.js`, and `mysqldiff` script define compatibility behavior referenced by comments and tests, but product changes belong under `apps/desktop/`.
- `apps/desktop-mock/index.html` is an interaction reference for the three-pane layout. Do not make it the source of business behavior or modify it to fix a production bug.
- `dist-main/`, `dist-renderer/`, and `release/` are generated and gitignored. Source maps and packaged output are not edit points.

## Naming and Placement

- Use kebab-case for modules (`compare-filter.ts`, `data-fetch.ts`) and PascalCase for React components (`NodeLibrary`, `SqlPreview`).
- Use camelCase for functions and methods, and uppercase snake case for constants such as `MAX_CONCURRENCY` and `HISTORY_LIMIT`.
- Most tests are colocated as `<module>.test.ts`. The current storage exception is `src-core/vault.test.ts`, which exercises `src-main/vault.ts` and `src-main/store-json.ts`; keep that exception visible rather than inventing a second test location. Renderer-only pure helpers stay in `src-renderer`; logic needed by both processes belongs in `src-core`.
- Use `.mjs` for repository tooling executed directly by Node, as in `scripts/generate-icon.mjs`.
