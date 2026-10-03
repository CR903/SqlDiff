# Technical Design — DataGrip Export

## Boundary and Direction

This task exports SqlDiff `NodeMeta` to DataGrip. It is a third exporter sitting beside `dbeaver.ts` and the existing JSON/Markdown manifest serializers. It does not use or change the `NodeConverter` contract in `src-main/converters/index.ts`; that interface remains the future reverse-import seam and would otherwise force secrets through the wrong boundary.

The exporter is deterministic and pure. Main process owns node lookup, XML validation, and IPC validation; renderer owns selection UI and the existing trusted `file.save` bundle path.

## Data Flow

```text
NodeLibrary export menu
  -> DatagripExportModal (local selected ids, all/none, warning)
  -> Zustand exportDatagrip(ids)
  -> preload SqlDiffApi.nodes.exportDatagrip(ids)
  -> main nodes.export-datagrip handler
  -> resolveDatagripNodes(loadNodes(userDataDir), ids) + createDatagripExportResult(selected)
  -> DatagripExportResult { files, exportedCount, warnings }
  -> renderer saveTextFiles(result.files, title)   // file.save kind:'bundle'
  -> renderer success toast with the saved directory path
```

No Vault read occurs on this path. The handler returns topology only; it must not accept or return a `SecretBundle`.

## Main-Process Module

Add `src-main/converters/datagrip.ts` with a typed document builder and result types. The builder accepts `readonly NodeMeta[]` and defensively validates the node shape before returning the three XML documents plus warnings. Keep the driver / component-name / auth constants in this module.

Suggested public shape:

```ts
export type DatagripSshAuthType = 'PASSWORD' | 'PRIVATE_KEY';

export interface DatagripExportResult {
  files: { fileName: 'dataSources.xml' | 'dataSources.local.xml' | 'sshConfigs.xml'; content: string }[];
  exportedCount: number;
  warnings: string[];
}

export function resolveDatagripNodes(nodes: readonly NodeMeta[], ids: unknown): NodeMeta[];
export function buildDatagripDocuments(nodes: readonly NodeMeta[]): {
  dataSourcesXml: string;
  dataSourcesLocalXml: string;
  sshConfigsXml?: string;   // only present when at least one node has ssh.enabled
  warnings: string[];
};
export function createDatagripExportResult(nodes: readonly NodeMeta[]): DatagripExportResult;
```

### XML shapes (authoritative, from research Addendum 2026-10-03)

`dataSources.xml` — shared layer, one `<data-source>` per node:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
    <data-source source="LOCAL" name="&lt;alias&gt;" uuid="&lt;uuid&gt;">
      <driver-ref>mysql.8</driver-ref>
      <synchronize>true</synchronize>
      <jdbc-driver>com.mysql.cj.jdbc.Driver</jdbc-driver>
      <jdbc-url>jdbc:mysql://&lt;host&gt;:&lt;port&gt;/&lt;database&gt;</jdbc-url>
      <working-dir>$ProjectFileDir$</working-dir>
    </data-source>
  </component>
</project>
```

`dataSources.local.xml` — per-user layer, same UUID per `<data-source>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="dataSourceStorageLocal">
    <data-source name="&lt;alias&gt;" uuid="&lt;uuid&gt;">
      <secret-storage>master_key</secret-storage>
      <user-name>&lt;user&gt;</user-name>
      &lt;!-- Only when node.ssh.enabled: --&gt;
      <ssh-properties>
        <enabled>true</enabled>
        <ssh-config-id>&lt;sshUuid&gt;</ssh-config-id>
      </ssh-properties>
    </data-source>
  </component>
</project>
```

`sshConfigs.xml` — only emitted when at least one node has `ssh.enabled`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="SshConfigs">
    <configs>
      <sshConfig authType="PASSWORD|PRIVATE_KEY" host="&lt;ssh.host&gt;" id="&lt;sshUuid&gt;"
                 port="&lt;ssh.port&gt;" username="&lt;ssh.user&gt;" />
    </configs>
  </component>
</project>
```

### UUID strategy

- Data-source UUID: **deterministic** v4 derived from `NodeMeta.id` (e.g. `uuidv5('sqldiff-ds', node.id)`). Deterministic keeps the same node set byte-stable across exports and lets tests assert exact UUIDs. This differs from the community recommendation "fresh v4 UUID per data source" — that guidance is for humans hand-generating an import; SqlDiff's export is a repeatable projection, matching the DBeaver `connectionId(nodeId)` contract.
- SSH config UUID: **deterministic** v5 keyed on `sqldiff-ssh`, `node.id`, `ssh.host`, `ssh.port`. If two nodes reuse the same jump host (same `host` + `port` + `user` + `authType`), collapse to one `<sshConfig>` entry — DataGrip allows multiple `<data-source>` to reference the same `<sshConfig id>`. Emit the collapsed count in `warnings` when collapse actually happened, so the user sees how many SSH configs were exported vs. nodes.

Implementations of the v5 variant must not import a new dependency. Either pin a small local v5 implementation beside the file (mirroring `compare-filter.ts`-style self-contained helpers) or reuse an existing utility if one is already in `src-core`. Prefer self-contained: the export path must stay free of new runtime deps.

### Secret boundary

- Emit `user-name` from `NodeMeta.user` (not secret).
- Emit `<secret-storage>master_key</secret-storage>` as an IDE hint marker — the IDE will re-prompt and store the value in the OS keychain.
- **Never** emit `<password>`, `<keyPath>`, `<passphrase>`, `<secret>`, Vault ciphertext, or any field containing secret values.
- For `authType: 'privateKey'`, emit `authType="PRIVATE_KEY"` without a `keyPath` attribute; add a warning mirroring DBeaver: `"<alias>：SSH 私钥需在 DataGrip 中重新选择。"`.
- Warnings, toast strings, and task evidence must be free of secret values. Audit prose may name forbidden keys, but exported payloads and evidence must never contain secret content.

### Field mapping table

| SqlDiff `NodeMeta` | DataGrip XML |
|---|---|
| `alias` | `data-source @name` (both files) |
| `id` (via v5) | `data-source @uuid` (both files) |
| `host`, `port`, `database` | `<jdbc-url>jdbc:mysql://host:port/db</jdbc-url>` |
| `user` | `<user-name>user</user-name>` |
| (constant) | `<driver-ref>mysql.8</driver-ref>` |
| (constant) | `<jdbc-driver>com.mysql.cj.jdbc.Driver</jdbc-driver>` |
| (constant) | `<synchronize>true</synchronize>` |
| (constant) | `<working-dir>$ProjectFileDir$</working-dir>` |
| `ssh.enabled=true` | `<ssh-properties><enabled>true</enabled><ssh-config-id>…</ssh-config-id></ssh-properties>` |
| `ssh.host`, `ssh.port`, `ssh.user` | `<sshConfig host port username>` (with `id`, `authType`) |
| `ssh.authType='password'` | `<sshConfig authType="PASSWORD">` |
| `ssh.authType='privateKey'` | `<sshConfig authType="PRIVATE_KEY">` + warning |
| (secret fields) | — not emitted |

### XML serialization rules

- Attribute escaping: `& < > " '` and newline must be XML-escaped in attribute values. Hostnames and aliases can legitimately contain `&` or `'`.
- Text-node escaping: same rules for `<jdbc-url>`, `<user-name>`, `<working-dir>` text content.
- Attribute order is deterministic: emit `authType`, `host`, `id`, `port`, `username` in that fixed order for `<sshConfig>`; `name`, `source`, `uuid` in that order for `<data-source>` (in `dataSources.xml`), and `name`, `uuid` in `dataSources.local.xml`.
- 2-space indent, LF line endings, trailing newline on the file.
- The XML declaration is `<?xml version="1.0" encoding="UTF-8"?>` for both `<project>` files. This matches the live intellij-samples and the DBeaver plugin test fixtures.
- No `<database-info>`, no `<schema-mapping>` — those are IDE-populated introspection output; research material marks them optional and out of scope.

### Validation & error matrix

| Condition | Result |
|---|---|
| `ids` not an array or empty | Throw `nodes: DataGrip 导出请至少选择一个节点` |
| Non-empty string id fails trim | Throw `nodes: DataGrip 导出节点 id 非法` |
| Duplicate id | Throw `nodes: DataGrip 导出节点 id 重复` |
| Unknown id | Throw `nodes: DataGrip 导出包含未知节点，请刷新后重试` |
| Node has invalid port/SSH fields | Throw `datagrip:` validation error before XML construction |
| `authType` not in `{password, privateKey}` | Throw `datagrip: 节点 SSH 认证类型非法` |
| Private-key SSH node exported | Return topology + re-select-key warning; never throw |
| Any secret-valued field on a polluted object | Ignore it; emit only allow-listed fields |

All errors use the `nodes:` or `datagrip:` domain prefix and are safe for `sanitizeIpcError`.

## Renderer and Download

Add `nodes.exportDatagrip(ids: string[]): Promise<DatagripExportResult>` to `SqlDiffApi`, mirror the DBeaver pattern in `src-main/preload.ts`, `src-main/main.ts`, and `src-renderer/store.ts`.

UI policy:

- **Option A (preferred)**: extend the existing `DBeaverExportModal` to accept a `target: 'dbeaver' | 'datagrip'` prop and route the download accordingly. Shared selection state, shared warning banner pattern, shared CDP fixture.
- **Option B**: extract a generic `ExportTargetsModal` where the user picks the target from a radio list (`DBeaver` / `DataGrip`) and a single export click fans out through the store action for the selected target.

Prefer Option A first: it minimizes UI change surface and keeps the DBeaver CDP suite intact. Move to Option B if the second target needs distinct affordances (which it does not — both are topology-only).

Reuse the existing trusted save path:

- DBeaver export already uses `saveTextFile` (`file.save kind:'file'`, one file per call). DataGrip produces 2 or 3 files, so promote the helper to `saveTextFiles(files, title)` with `kind:'bundle'`, mirroring `manifestFileNames` in `src-core/manifest.ts`. If `saveTextFiles` already exists in `src-renderer/sql.ts` from the manifest work, reuse it directly.
- The renderer must not import Node APIs. `saveTextFiles` is a thin bridge to `SqlDiffApi.file.save`, which is already exposed via preload.
- Success toast reports the saved directory (not individual file paths) so a bundle readout stays short: `已导出 3 个 XML 到 <dir>` with `<count>` warnings appended.
- Warnings from `createDatagripExportResult` are surfaced in the modal before the export click, so users see "SSH 私钥需在 DataGrip 中重新选择" before picking a directory.

## Compatibility and Rollback

- Existing DBeaver export remains untouched; `dbeaver.ts`, `nodes.export-dbeaver` handler, and `DBeaverExportModal` keep their current behavior.
- `src-main/converters/index.ts` remains the future reverse-import seam and is unchanged.
- Removing `datagrip.ts`, the `nodes.export-datagrip` handler, the `SqlDiffApi.nodes.exportDatagrip` bridge, and the DataGrip entry in the export modal restores the previous state.
- If a target DataGrip version rejects a specific attribute or omits a required one discovered during real-world smoke testing, update the constants in `datagrip.ts` (single source of truth for driver/component names) and regenerate the XML; do not add format fallbacks that emit guessed fields.
- If users report that `authType="PASSWORD"` should instead be `PASSWORD_AUTH` or the like in a specific DataGrip version, change the constant in one place.

## Tests

- `src-main/converters/datagrip.test.ts` asserts:
  - Direct node produces a `<data-source>` block with `driver-ref=mysql.8`, `jdbc-driver=com.mysql.cj.jdbc.Driver`, `jdbc-url=jdbc:mysql://host:port/db`, `<user-name>user</user-name>`, `<secret-storage>master_key</secret-storage>`, and no `<ssh-properties>`.
  - Password SSH node produces the same DB block plus `<ssh-properties><enabled>true</enabled><ssh-config-id>…</ssh-config-id></ssh-properties>` in local XML and one `<sshConfig authType="PASSWORD" host port username id>` in `sshConfigs.xml`.
  - Private-key SSH node emits `authType="PRIVATE_KEY"` and adds the re-select-key warning; no `keyPath` attribute appears anywhere.
  - Two nodes sharing an SSH jump host collapse to one `<sshConfig>` and are both referenced.
  - Deterministic ordering: same node set produces byte-identical XML across calls (sort by `id`; no timestamps, no random UUIDs).
  - Deterministic UUIDs: same `NodeMeta.id` maps to the same v5 UUID across runs.
  - Empty / unknown / duplicate id handling mirrors DBeaver.
  - Sentinel-polluted object with extra `password`/`keyValue`/`passphrase` fields emits only the allow-list.
  - XML escaping: alias containing `&`, `'`, `"` is escaped in attributes.
  - `sshConfigsXml` is undefined when no node has `ssh.enabled` — do not emit an empty `<configs/>`.

- The full gate runs `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` from `apps/desktop`.

- CDP pass: open the export menu → select the DataGrip target → toggle all/none → trusted `Input.dispatchMouseEvent` on Export → accept the native save dialog → verify 2–3 files exist at the returned directory and each parses as well-formed XML with matching UUIDs. Same harness and evidence format as DBeaver's CDP suite; persist only the report and non-sensitive evidence.

## Wrong vs Correct

```ts
// Wrong: pulling the SSH topology into dataSources.local.xml
// (host/port/username live in sshConfigs.xml, not here)
localXml = `<ssh-properties>
  <host>${node.ssh.host}</host>
  <port>${node.ssh.port}</port>
</ssh-properties>`;

// Correct: ssh-properties only carries enabled + a config-id reference
localXml = `<ssh-properties>
  <enabled>true</enabled>
  <ssh-config-id>${sshConfigId}</ssh-config-id>
</ssh-properties>`;

sshXml = `<sshConfig authType="${authType}" host="${node.ssh.host}"
    id="${sshConfigId}" port="${node.ssh.port}" username="${node.ssh.user}" />`;
```

```ts
// Wrong: fabricating a key path
sshXml = `<sshConfig … keyPath="${node.ssh.keyPath}" />`;
// SqlDiff does not store a trustworthy key-file path; user re-selects in IDE.

// Correct: omit keyPath entirely, add warning
sshXml = `<sshConfig authType="PRIVATE_KEY" host="…" id="…" port="…" username="…" />`;
warnings.push(`${node.alias}：SSH 私钥需在 DataGrip 中重新选择。`);
```

```ts
// Wrong: emitting an empty <configs/> file when no node has SSH
result.files = [..., { fileName: 'sshConfigs.xml', content: emptyShell }];

// Correct: omit the file entirely; saveTextFiles writes exactly 2 files
result.files = dataSourcesXml ? [...base, ...(sshXml ? [{fileName:'sshConfigs.xml', content: sshXml}] : [])] : ...;
```

```ts
// Wrong: pulling a SecretBundle through IPC to "helpfully" include passwords
mainHandler: async (ids) => vault.getNodeSecrets(nodes, ids);

// Correct: topology-only, same boundary as DBeaver
const selected = resolveDatagripNodes(loadNodes(userDataDir), ids);
const result = createDatagripExportResult(selected);
```
