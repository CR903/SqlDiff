# Error Handling

## Boundary Contract

There is no HTTP error response. Main-process failures reject the `ipcRenderer.invoke` promise; renderer-facing caught failures are cleaned with `sanitizeIpcError` before display. Operational paths that are expected to produce partial results return typed status objects instead of throwing.

| Situation | Representation | Consumer |
|---|---|---|
| Invalid node, history, compare, or data request | Thrown `Error` with a domain prefix such as `nodes:`, `compare:`, or `data:` | `sanitizeIpcError` in the renderer |
| Connection test failure | `ConnTestResult {ok:false, code, message, ms}` | `NodeModal.handleTest` and `App.handleTestNode` |
| One data table cannot be read | `DataTableStatus` with `status: 'error'` and `reason: 'fetch-failed'` | `DataSection` without aborting other tables |
| A table exceeds the row limit | `DataThresholdError`, then `DataTableStatus` with `status: 'confirm-needed'` | UI asks for confirmation and reruns |
| User cancels a data fetch | `Error` with `code = 'ABORTED'` or name `AbortError` | `data-run.isAbortErr` stops the run |
| A single `SHOW CREATE` fails | `null` in `DatabaseMetadata`, plus a `CoverageSkip {name, objectType, reason}` in `MetadataSnapshot.skipped` | `compareRun` skips that object; `CompareResult.coverage` reports the gap |
| A real comparison fails while the app has no backend | demo results with `source: 'demo'` | `store.runCompare` development path only; status bar prefixes `本地示例 ·` |
| Clipboard write fails | `sql.copy` returns `false` | `copyText` falls back to browser clipboard/`execCommand` |

## Validation Before Side Effects

- Validate at the main-process boundary. `assertNonEmpty`, `normalizePort`, and `buildNodeMeta` in `src-main/main.ts` normalize node input before writing metadata or secrets.
- Treat IPC and imported JSON as untrusted at runtime. `isNodeMeta` / `isHistoryEntry` in `store-json.ts` guard persisted data, and `Vault.importDecrypted` checks version, array shape, basic metadata, and encrypted fields.
- Recheck derived state in service functions. `validateNode`, `findNodeOrThrow`, and `decideIdentity` fail early with actionable messages rather than passing invalid ids or identities deeper into the stack. `resolveDataPairs` does not throw for malformed manual pairs: it filters them and falls back to the same-name intersection.

## Error Classes and Conversion

- `ConnectionError` carries a stable `code` such as `SSH_CONFIG` or `MYSQL_CONNECT`. `testConnection` converts it to `ConnTestResult`; do not make connection testing reject for an expected unreachable server.
- `DataThresholdError` carries `table`, `count`, and `threshold`. `runDataCompare` converts it to `confirm-needed`; this is a user decision, not a failed comparison.
- Ordinary database, vault, or orchestration failures remain `Error` instances and reject the IPC call. Domain errors such as `vault:`, `store:`, `compare:`, and `data-compare:` use their owning prefix; `ConnectionError` carries a stable code instead. Keep the message diagnosable after Electron wraps the error, and do not put secrets in it.
- SQL formatting and clipboard writes are best-effort: the `sql.format` handler returns the original text on formatter errors, while `sql.copy` returns `false` so the renderer can use its clipboard fallback.

## Cleanup and Partial Failure

- Put resource cleanup in `finally`. Once their pool references are assigned, `runCompareRequest`, `runDataCompare`, and `main.ts`'s `data.tables` handler close them regardless of outcome; `pingDirect` / `pingViaTunnel` likewise close their temporary connections. The partial pool-construction gap is documented in [Database Guidelines](./database-guidelines.md).
- Use `Promise.allSettled` for independent cleanup so one close failure hides neither the result nor another cleanup error.
- Catch only where the product has an explicit policy:
  - `fetchMetadata` converts per-object `SHOW CREATE` failures to `null` and records a coarse `CoverageReason` (`permission-denied` / `object-missing` / `aborted` / `unknown`) in the snapshot's `skipped` list, so a permission blind spot is reported rather than looking like "no difference"; raw MySQL errors never reach the renderer;
  - `runDataCompare` records a failed table and continues;
  - `appendHistory` failure does not block a successful comparison;
  - renderer progress unsubscribe and best-effort star/use-count persistence ignore secondary failures.
- Do not treat a failed real comparison as a successful real result. `store.runCompare` splits its `catch` on `isNoIpc`, which is the semantic dividing line rather than a message-wording branch: the `no-ipc` development state still falls back to demo data and marks it `source: 'demo'`, while **any** real failure (credentials, connectivity, permissions, backend error) clears `items` and renders an explicit error card carrying the `sanitizeIpcError` output. Filling in demo items after a failed connection was the defect this replaced; the archived E2E report recorded how it could be misread. Changes to this path still need explicit product review and UI regression coverage.
- Keep the demo marker honest. `source` is optional on `CompareResult` and a missing value reads as `'real'`, because `compareRun` and `postFilterResult` construct results inside `src-core` and cannot know their caller. `compare-run.ts` therefore marks the real path explicitly and `src-renderer/demo.ts:runDemoCompare` is the single demo marker. When adding a new result producer, set `source` rather than relying on the default.

## Renderer Handoff

Electron prefixes rejected invokes with `Error invoking remote method ...`. Never show a raw caught value. Pass renderer-facing failures through `sanitizeIpcError` from `src-core/ipc-error.ts`, as done by `refreshDataTables`, `NodeModal`, App node/file actions, and the `SqlPreview` export handler.

Avoid:

- throwing from a cleanup path and replacing the original comparison error;
- treating missing `SHOW CREATE` text as an absent object;
- including `SecretBundle`, private keys, connection strings, master-key bytes, or encrypted buffers in an error message;
- adding a second error format in the renderer instead of using `sanitizeIpcError`.
