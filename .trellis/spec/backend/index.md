# SqlDiff Main-Process Guidelines

This directory covers the Electron main process and the process-neutral comparison core. SqlDiff has no HTTP server, ORM, or database migration layer. The product reads MySQL metadata and rows, then generates SQL; it never executes the generated SQL.

## Guidelines

| Guide | Use it for | Status |
|---|---|---|
| [Directory Structure](./directory-structure.md) | Main/preload/core ownership, Electron boundaries, reference code | Current |
| [Database Guidelines](./database-guidelines.md) | Read-only MySQL access, SQL construction, pooling, metadata snapshots | Current |
| [Error Handling](./error-handling.md) | IPC failures, structured results, partial failures, cleanup | Current |
| [Logging Guidelines](./logging-guidelines.md) | The project's actual diagnostic and logging boundaries | Current |
| [Quality Guidelines](./quality-guidelines.md) | Type safety, security, tests, diff invariants, icons, packaging | Current |

## Pre-Development Checklist

- Decide whether code belongs in `apps/desktop/src-main`, `src-core`, or `src-renderer`; do not put Node-only code in a renderer import path. The current boundary is visible in `src-main/main.ts`, `src-main/preload.ts`, and `src-core/compare-filter.ts`.
- If an IPC method or payload changes, update the shared contract in `src-core/types.ts`, the bridge in `src-main/preload.ts`, its handler in `src-main/main.ts`, and renderer callers together.
- Preserve the read-only contract: MySQL calls are limited to `SELECT`, `COUNT`, `information_schema`, and `SHOW CREATE`, as implemented by `src-main/metadata.ts` and `src-main/data-fetch.ts`.
- Treat `mysqldiff/` as read-only historical behavior. Port or test semantics in `apps/desktop/src-core`; do not repair the old CLI in place.
- Choose a focused Vitest file in the owning layer. Most tests sit beside the implementation; the current storage exception is `src-core/vault.test.ts`, which covers `src-main/vault.ts` and `src-main/store-json.ts`. Prefer pure functions and injected fakes, following `src-main/metadata.test.ts` and `src-main/connection.test.ts`.

## Quality Check

Run from `apps/desktop`:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run build` is required for Electron/preload/build changes because it type-checks, builds the renderer with Vite, and compiles the CommonJS main process. For release or icon work, also follow [Quality Guidelines](./quality-guidelines.md#icons-and-packaging).

Review that:

- renderer code has no direct `node:*`, `electron`, `mysql2`, or `ssh2` import;
- assigned pools, connections, listeners, and progress subscriptions are cleaned up; review the documented partial-construction gap separately;
- real secrets never enter `nodes.json`, test output, task artifacts, or plaintext export payloads;
- generated SQL remains unexecuted and A-to-B direction remains explicit;
- any new error or status path is covered by a unit test or documented CDP scenario.
