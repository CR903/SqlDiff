# DBeaver Export Contract

## 1. Scope / Trigger

Use this contract whenever adding or changing SqlDiff → DBeaver connection export. The exporter is topology-only and additive; it does not import DBeaver configuration or migrate secrets.

Source of truth: `apps/desktop/src-main/converters/dbeaver.ts` and the `nodes.export-dbeaver` handler in `src-main/main.ts`.

## 2. Signatures

```ts
resolveDBeaverNodes(nodes: readonly NodeMeta[], ids: unknown): NodeMeta[]

buildDBeaverDocument(nodes: readonly NodeMeta[]): {
  document: DBeaverDataSources;
  warnings: string[];
}

createDBeaverExportResult(nodes: readonly NodeMeta[]): DBeaverExportResult
```

IPC contract:

```ts
SqlDiffApi.nodes.exportDbeaver(ids: string[]): Promise<DBeaverExportResult>

DBeaverExportResult = {
  fileName: 'data-sources-sqldiff.json';
  content: string;
  exportedCount: number;
  warnings: string[];
}
```

`DBeaverExportResult` is a module-specific result kept beside the exporter and re-exported by `preload.ts`; it is not a `NodeMeta`/`SecretBundle` core contract.

The main handler accepts `unknown` at runtime, validates it through `resolveDBeaverNodes`, and returns the typed result. The preload method is a thin `ipcRenderer.invoke` bridge.

Renderer download helpers in `src-renderer/sql.ts` (the module may import bridge types from `src-main/preload.ts` with `import type`):

```ts
downloadTextFile(filename: string, text: string, mimeType: string): void
downloadJsonFile(filename: string, text: string): void
```

`downloadJsonFile` delegates to the existing Blob/`will-download` path; it must not add a renderer-side filesystem write.

## 3. Contracts

- The result filename is `data-sources-sqldiff.json`, which matches DBeaver's `data-sources*.json` discovery pattern and can be placed in a `.dbeaver/` directory.
- The document contains `folders`, `connections`, and `connection-types`. Connections use stable ids derived from `NodeMeta.id` and are sorted by id, so the same node set produces byte-stable content.
- Each MySQL connection uses `provider: 'mysql'`, `driver: 'mysql8'`, `configurationType: 'MANUAL'`, `auth-model: 'native'`, and `auth-properties.userName` from `NodeMeta.user`.
- Enabled SSH produces `configuration.handlers.ssh_tunnel` with host, port, user, and `PASSWORD` or `PUBLIC_KEY`. `privateKey` auth omits both `keyPath` and `keyValue` because SqlDiff stores key material rather than a trusted key-file path, and adds a warning.
- `save-password` is `false` at both connection and SSH-handler levels. The literal control key `save-password` is allowed only with that value; no secret-valued field such as `password`, `sshPassword`, `privateKey`, `passphrase`, `userPassword`, `keyValue`, or Vault ciphertext may appear in the document, warnings, or toast. Audit prose may name forbidden keys, but task evidence must never contain their values or ciphertext.
- The export path must not call `Vault.getNodeSecret` or accept a `SecretBundle`; the main handler reads `NodeMeta` only.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| `ids` is not an array or is empty | Throw `nodes: DBeaver 导出请至少选择一个节点` |
| An id is not a non-empty string | Throw `nodes: DBeaver 导出节点 id 非法` |
| The same id occurs twice | Throw `nodes: DBeaver 导出节点 id 重复` |
| An id is not present in loaded nodes | Throw `nodes: DBeaver 导出包含未知节点，请刷新后重试` |
| A node has invalid port/SSH fields | Throw a `dbeaver:` validation error before building output |
| A private-key SSH node is exported | Return topology plus a re-select-key warning; never throw for the missing key path |
| Any secret field is present on a runtime-polluted object | Ignore it and emit only the topology allow-list |

All errors are domain-prefixed and may be shown after `sanitizeIpcError` at the renderer boundary.

## 5. Good / Base / Bad Cases

- Good: three nodes (direct, password SSH, private-key SSH) produce three connections, two tunnel handlers, one private-key warning, and no secret values.
- Base: a direct node produces a MANUAL MySQL connection with a username and `save-password: false`.
- Bad: selecting no nodes, passing an unknown id, or building from an invalid port fails before any file is generated.
- Bad: adding `userPassword`, `keyPath`, a random UUID, or a timestamp would violate the topology-only or deterministic contract; do not add these fields without a new approved product decision.

## 6. Tests Required

- `src-main/converters/dbeaver.test.ts` must assert direct, password-SSH, private-key-SSH, multi-node deterministic ordering, duplicate/empty/invalid input, warning behavior, and a sentinel-polluted object with no secret output.
- The full gate must run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` from `apps/desktop`.
- UI/export changes require a trusted CDP pass: open the selection modal, toggle all/none, click export with `Input.dispatchMouseEvent`, and verify the `will-download` file exists and parses as the returned JSON.
- The CDP harness remains temporary; persist only the report and non-sensitive evidence.

## 7. Wrong vs Correct

### Wrong

```ts
const doc = vault.exportEncrypted(nodes); // leaks/depends on secret material
const ids = [...new Set(idsFromRenderer)]; // silently hides duplicate input
```

### Correct

```ts
const selected = resolveDBeaverNodes(loadNodes(userDataDir), ids);
const result = createDBeaverExportResult(selected);
// renderer downloads result.content; no Vault call and no SecretBundle crosses IPC
```

Likewise, use trusted input and a real download assertion for the UI path:

```ts
// Wrong: el.click() alone does not prove a saved file.
element.click();

// Correct: dispatch a trusted mouse event and inspect the will-download target.
cdp.send('Input.dispatchMouseEvent', trustedClick);
await waitForDownload('data-sources-sqldiff.json');
```
