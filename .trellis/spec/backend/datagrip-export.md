# DataGrip Export Contract

## 1. Scope / Trigger

Use this contract whenever adding or changing SqlDiff → DataGrip connection export. The exporter is topology-only and additive; it does not import DataGrip configuration or migrate secrets.

Source of truth: `apps/desktop/src-main/converters/datagrip.ts` and the `nodes.export-datagrip` handler in `src-main/main.ts`.

DataGrip export produces three files (two always, one conditional):
- `dataSources.xml` — always present; shared data-source topology.
- `dataSources.local.xml` — always present; per-user SSH/SSL config references.
- `sshConfigs.xml` — only when at least one selected node has SSH enabled; SSH tunnel definitions.

## 2. Signatures

```ts
resolveDatagripNodes(nodes: readonly NodeMeta[], ids: unknown): NodeMeta[]

buildDatagripDocuments(nodes: readonly NodeMeta[]): {
  dataSourcesXml: string;
  dataSourcesLocalXml: string;
  sshConfigsXml?: string;
  warnings: string[];
}

createDatagripExportResult(nodes: readonly NodeMeta[]): DatagripExportResult
```

IPC contract:

```ts
SqlDiffApi.nodes.exportDatagrip(ids: string[]): Promise<DatagripExportResult>

DatagripExportResult = {
  files: DatagripFile[];
  exportedCount: number;
  warnings: string[];
}

DatagripFile = {
  fileName: 'dataSources.xml' | 'dataSources.local.xml' | 'sshConfigs.xml';
  content: string;
}
```

`DatagripExportResult` and `DatagripFile` are module-specific types kept beside the exporter and re-exported by `preload.ts`; they are not `NodeMeta`/`SecretBundle` core contracts.

The main handler accepts `unknown` at runtime, validates it through `resolveDatagripNodes`, and returns the typed result. The preload method is a thin `ipcRenderer.invoke` bridge.

Renderer export helpers in `src-renderer/sql.ts`:

```ts
saveTextFiles(files: Array<{ name: string; content: string }>, title: string): Promise<ExportOutcome[]>
exportSavedMessage(prefix: string, filePath: string): string
```

`saveTextFiles` goes through `file.save` (`kind: 'bundle'`) so the user picks the directory in the system save dialog; the returned paths are echoed in the success toast. It must not add a renderer-side filesystem write. `saveTextFile` (singular) remains as a thin wrapper for single-file callers; both DBeaver and DataGrip exports now route through `saveTextFiles`.

## 3. Contracts

- **XML well-formed**: all files start with `<?xml version="1.0" encoding="UTF-8"?>` and contain `<project version="4">` root. `sshConfigs.xml` uses `<?xml version="1.0" encoding="UTF-8"?>` (version 1.0, not 1.0.0).
- **UUID determinism**: data-source UUIDs are v5-derived from `NodeMeta.id` using the RFC 4122 URL namespace (`6ba7b811-9dad-11d1-80b4-00c04fd430c8`), so the same node produces the same UUID across runs. SSH config UUIDs are v5-derived from `(host, port, user, authType)` using a reserved private namespace (`f81d4fae-7dec-718f-e42a-4a04728f92ff`); two nodes sharing the same jump host collapse to one `<sshConfig>`.
- **Cross-file UUID consistency**: the same `<data-source uuid>` value appears in both `dataSources.xml` and `dataSources.local.xml`. When SSH is enabled, `<ssh-config-id>` in `dataSources.local.xml` matches `<sshConfig id>` in `sshConfigs.xml`.
- **Driver constants**: `driver-ref=mysql.8`, `jdbc-driver=com.mysql.cj.jdbc.Driver`, `working-dir=$ProjectFileDir$`, `secret-storage=master_key`.
- **Component names**: `DataSourceManagerImpl` (dataSources.xml), `dataSourceStorageLocal` (dataSources.local.xml), `SshConfigs` (sshConfigs.xml).
- **authType mapping**: `password` → `PASSWORD`, `privateKey` → `PRIVATE_KEY`.
- **No secrets**: the export path must not call `Vault.getNodeSecret` or accept a `SecretBundle`; the main handler reads `NodeMeta` only. No secret-valued field such as `password`, `sshPassword`, `privateKey`, `passphrase`, `userPassword`, `keyValue`, `keyPath`, `vaultCiphertext`, or `BEGIN OPENSSH PRIVATE KEY` may appear in any XML file, warning, or toast. Audit prose may name forbidden keys, but task evidence must never contain their values or ciphertext.
- **Private-key SSH**: `privateKey` auth omits `keyPath` (SqlDiff stores key material, not a trusted key-file path) and emits a per-node warning. The warning message must match the DBeaver re-select-key wording.
- **SSH collapse**: when N nodes share the same jump host `(host, port, user, authType)`, they produce one `<sshConfig>` entry and N `<ssh-config-id>` references. A collapse warning is emitted naming the collapsed aliases.
- **Byte stability**: identical input (same node set, any order) produces byte-identical XML across all three files. Attribute order is pinned; tests assert by string comparison.
- **sshConfigs.xml omission**: when no selected node has SSH enabled, `sshConfigsXml` is `undefined` and not pushed to `files[]`. The export yields exactly two files.
- **File order**: `files[]` is always `[dataSources.xml, dataSources.local.xml, (sshConfigs.xml?)]` — order is stable for deterministic CDP assertions.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| `ids` is not an array or is empty | Throw `nodes: DataGrip 导出请至少选择一个节点` |
| An id is not a non-empty string | Throw `nodes: DataGrip 导出节点 id 非法` |
| The same id occurs twice | Throw `nodes: DataGrip 导出节点 id 重复` |
| An id is not present in loaded nodes | Throw `nodes: DataGrip 导出包含未知节点，请刷新后重试` |
| A node has invalid port/SSH fields | Throw a `datagrip:` validation error before building output |
| A private-key SSH node is exported | Return topology plus a re-select-key warning; never throw for the missing key path |
| Any secret field is present on a runtime-polluted object | Ignore it and emit only the topology allow-list |
| No SSH nodes selected | Emit exactly 2 files; `sshConfigsXml` is `undefined` |

All errors are domain-prefixed and may be shown after `sanitizeIpcError` at the renderer boundary.

## 5. Good / Base / Bad Cases

- Good: three nodes (direct, password SSH, private-key SSH) produce three `<data-source>` entries in both `dataSources.xml` and `dataSources.local.xml`, two `<sshConfig>` entries in `sshConfigs.xml`, one private-key warning, and no secret values.
- Good: two nodes sharing a jump host collapse to one `<sshConfig>` with two `<ssh-config-id>` references and one collapse warning.
- Base: a direct node produces a `<data-source>` with `driver-ref=mysql.8`, `jdbc-url=jdbc:mysql://host:port/db`, and `<user-name>` from `NodeMeta.user`. No `<ssh-properties>` in `dataSources.local.xml`.
- Bad: selecting no nodes, passing an unknown id, or building from an invalid port fails before any file is generated.
- Bad: adding `keyPath`, `passphrase`, a random UUID, or a timestamp would violate the topology-only or deterministic contract; do not add these fields without a new approved product decision.
- Bad: emitting an empty `<configs/>` in `sshConfigs.xml` when no SSH is present violates the omission contract.

## 6. Tests Required

- `tests/converters/datagrip.test.ts` must assert:
  - Direct node: no `sshConfigs.xml`, correct driver constants, no `<ssh-properties>`.
  - UUID consistency across `dataSources.xml` and `dataSources.local.xml` (same UUID per alias).
  - Password SSH: `<ssh-properties>` reference + `<sshConfig authType="PASSWORD" host port username id>`.
  - Cross-file UUID reference integrity (`ssh-config-id` == `<sshConfig id>`).
  - Private-key SSH: `authType="PRIVATE_KEY"`, no `keyPath`, warning message exact.
  - Multi-node byte-stable sort (input order reversed → identical output).
  - Same-input-twice determinism including UUID stability.
  - XML escaping for `alias = 'prod & staging <tag> "quoted"'` — `&amp;`/`&lt;`/`&gt;`/`&quot;` in attributes and `&amp;` in text.
  - SSH collapse: two nodes sharing `(host, port, user, authType)` → one `<sshConfig>`, two refs, one warning.
  - No collapse when host/port/user match but `authType` differs.
  - No collapse when host or port differs.
  - Sentinel pollution: `password`/`sshPassword`/`privateKey`/`passphrase`/`vaultCiphertext`/`keyValue`/`keyPath`/`BEGIN OPENSSH PRIVATE KEY` all absent.
  - `resolveDatagripNodes` empty/illegal/duplicate/unknown boundaries.
  - `buildDatagripDocuments` validation errors (empty / duplicate id / bad port / missing host-or-user / bad authType).
- The full gate must run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` from `apps/desktop`.
- UI/export changes require a trusted CDP pass (see `10-03-datagrip-cdp-harness`): open the selection modal, toggle all/none, click export with trusted input, accept the native save dialog, verify 2–3 XML files exist at the returned path, parse each as well-formed XML, and assert UUID consistency across files.
- The CDP harness is separate from this task; the exporter and IPC contract are frozen at this spec's current state.

## 7. Wrong vs Correct

### Wrong

```ts
const doc = vault.exportEncrypted(nodes); // leaks/depends on secret material
const ids = [...new Set(idsFromRenderer)]; // silently hides duplicate input
const uuid = crypto.randomUUID();          // random UUID breaks determinism
const keyPath = node.ssh.privateKeyPath;   // SqlDiff stores key material, not a path
```

### Correct

```ts
const selected = resolveDatagripNodes(loadNodes(userDataDir), ids);
const result = createDatagripExportResult(selected);
// renderer saves result.files via saveTextFiles(file.save kind:'bundle'); no Vault call
```

Likewise, use trusted input and a real save assertion for the UI path:

```ts
// Wrong: el.click() alone does not prove saved files.
element.click();

// Correct: dispatch a trusted mouse event, then verify the paths file.save returned.
cdp.send('Input.dispatchMouseEvent', trustedClick);
await acceptNativeSaveDialog();
expect(fs.existsSync(await lastToastPath())).toBe(true);
```

## 8. IDE Smoke Test Status

Real DataGrip IDE import smoke testing is deferred to a follow-up task. The current environment has no DataGrip installation, so this task validates export correctness via XML structure assertions, UUID consistency, field mapping, and no-secret checks only. This mirrors the `09-22-converters` AC6 rationale for DBeaver. The deferred smoke test is tracked as a follow-up item in the task journal.
