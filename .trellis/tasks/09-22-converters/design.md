# Technical Design — DBeaver Export

## Boundary and Direction

This task exports SqlDiff `NodeMeta` to DBeaver. It does not use or change the existing reverse-import `NodeConverter` contract in `src-main/converters/index.ts`; that interface exists for future third-party → SqlDiff import and would otherwise force secrets through the wrong boundary.

The exporter is deterministic and pure. The main process owns node lookup and IPC validation; the renderer owns selection UI and the existing trusted Blob download path.

## Data Flow

```text
NodeLibrary export button
  -> DBeaverExportModal (local selected ids, all/none, warning)
  -> Zustand exportDbeaver(ids)
  -> preload SqlDiffApi.nodes.exportDbeaver(ids)
  -> main nodes.export-dbeaver handler
  -> loadNodes(userDataDir) + buildDBeaverDocument(selected)
  -> DBeaverExportResult { fileName, content, exportedCount, warnings }
  -> renderer downloadTextFile(...)
```

No Vault read occurs on this path. The handler returns topology only; it must not accept or return a `SecretBundle`.

## Main-Process Module

Add `src-main/converters/dbeaver.ts` with a typed document builder and result types. The builder accepts already-validated `NodeMeta[]` and returns the JSON document plus warnings. Keep the driver/provider constants in this module.

Suggested public shape:

```ts
interface DBeaverExportResult {
  fileName: string;
  content: string;
  exportedCount: number;
  warnings: string[];
}

function buildDBeaverDocument(nodes: NodeMeta[]): {
  document: DBeaverDataSources;
  warnings: string[];
}
```

The JSON must use `folders: {}`, `connections` keyed by a deterministic id derived from the SqlDiff node id, and `connection-types: {}`. Each connection contains provider/driver/name/save-password/configuration. `configuration` uses MANUAL host/port/database and native auth username. SSH uses the documented `handlers.ssh_tunnel` shape. `save-password` is false; no secret fields are emitted. For private-key auth, omit `keyPath` because SqlDiff stores key material, not a trustworthy path, and add a warning.

The handler should reject an empty selection and unknown ids with a domain-prefixed Chinese error. It should return no file content for an empty result. Tests should call the pure builder for format assertions and the handler boundary for validation where practical.

## Renderer and Download

Add a `nodes.exportDbeaver(ids: string[])` method to `SqlDiffApi` and a narrow store action. Add a local `DBeaverExportModal` in `App.tsx`, following the existing local-component convention. Default selection is all currently loaded nodes; the modal has per-node checkboxes, select-all/none, selected count, explicit secret warning, cancel, and export.

Generalize the existing Blob helper enough to provide a JSON MIME type, or add a small `downloadTextFile` helper. Preserve the trusted `will-download` main-process save path and do not introduce a second file-writing path.

The modal is presentation/local state; do not put selected ids in Zustand. The store action owns the IPC call and error sanitization. On success, download the returned content and show the count/warnings. On failure, use `sanitizeIpcError`.

## Compatibility and Rollback

- Existing custom encrypted JSON export/import and legacy connection-string import remain unchanged.
- Existing `NodeConverter` stub remains available for a future reverse-import task.
- DBeaver output is additive; deleting the new module, IPC method, and button restores the previous behavior.
- If driver ID verification fails in a real installation, change one documented constant and regenerate the JSON; do not add format fallbacks that emit guessed fields.

## Tests

- Pure builder: direct, password SSH, private-key SSH, multiple nodes, deterministic ids, no-secret assertions, warning behavior.
- IPC/store boundary: empty/unknown ids and sanitized error propagation.
- CDP: open modal, select nodes, trusted export click, verify downloaded file exists and equals returned JSON, inspect no secret fields.
- Full gate: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
