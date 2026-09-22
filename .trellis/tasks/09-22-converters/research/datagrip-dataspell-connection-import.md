# Research: DataGrip/DataSpell connection import format

- **Query**: DataGrip/DataSpell connection import format — dataSources.xml structure (jdbc:mysql URL, user, SSH config format, password storage behavior on import); minimal MySQL+SSH example; required vs optional fields; file-drop vs menu-driven import
- **Scope**: external (JetBrains docs 2026.2, JetBrains blog, JetBrains support answers Nov–Dec 2025, JetBrains intellij-samples repo) + internal (converter stub)
- **Date**: 2026-09-22

## Findings

### Files Found

| File Path | Description |
|---|---|
| `<project>/.idea/dataSources.xml` | Project-level shared data-source definitions (no secrets); confirmed live example in JetBrains intellij-samples repo |
| `<project>/.idea/dataSources.local.xml` | Per-user layer: user names, SSH/SSL configs, schema visibility (per JetBrains staff, Nov 2025); newer component name `dataSourceStorageLocal` |
| `<config>/options/` (global sources) | Global-level data sources, visible to all projects of that IDE version; `<config>` = `~/Library/Application Support/JetBrains/<product><version>/` on macOS |
| `apps/desktop/src-main/converters/index.ts:15-23` | Internal `NodeConverter` stub where `fromDataGrip` will be registered |

Config-dir roots (docs: `Directories used by the IDE`): macOS `~/Library/Application Support/JetBrains/DataGrip<version>/` (e.g. `DataGrip2026.2`); Windows `%APPDATA%\JetBrains\DataGrip<version>\`; Linux `~/.config/JetBrains/DataGrip<version>/`. Default project lives under `<config>/projects/`; global sources under `<config>/options/` at the same level as `projects/` (blog 2018). DataSpell (same IntelliJ platform) uses the identical mechanism with its own `<product><version>` dir.

### Code Patterns

**1. Shared side — `dataSources.xml`** (verbatim shape from JetBrains intellij-samples `.idea/dataSources.xml`, MySQL entry, uuid shared with local file):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
    <data-source source="LOCAL" name="@localhost" uuid="de07e21d-256a-4e7b-a80c-698618221856">
      <driver-ref>mysql.8</driver-ref>
      <synchronize>true</synchronize>
      <jdbc-driver>com.mysql.cj.jdbc.Driver</jdbc-driver>
      <jdbc-url>jdbc:mysql://localhost:3306</jdbc-url>
      <working-dir>$ProjectFileDir$</working-dir>
    </data-source>
  </component>
</project>
```

Verified MySQL constants: `<driver-ref>mysql.8</driver-ref>`, `<jdbc-driver>com.mysql.cj.jdbc.Driver</jdbc-driver>`, `<jdbc-url>jdbc:mysql://<host>:3306[/<db]>`. The `jdbc-url` SHOULD include the database (`jdbc:mysql://host:3306/mydb`; docs example `jdbc:mysql://my-endpoint.amazonaws.com:3306/testdb`; alternate Connector/J address-equals form also accepted). `uuid` must be a fresh v4 UUID per data source (community-verified generation recipe). `<database-info>` is introspection output filled after first connect — omit when generating.

**2. Local side — `dataSources.local.xml`** (verbatim shape from intellij-samples, same uuid):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="dataSourceStorageLocal" created-in="IU-253.28294.169">
    <data-source name="@localhost" uuid="de07e21d-256a-4e7b-a80c-698618221856">
      <database-info product="MySQL" version="8.0.26" ... dbms="MYSQL" ...>
        <extra-name-characters>#@</extra-name-characters>
        <identifier-quote-string>`</identifier-quote-string>
      </database-info>
      <case-sensitivity plain-identifiers="exact" quoted-identifiers="exact" />
      <secret-storage>master_key</secret-storage>
      <user-name>root</user-name>
      <schema-mapping>
        <introspection-scope>
          <node kind="schema">
            <name qname="@" />
            <name qname="sakila" />
          </node>
        </introspection-scope>
      </schema-mapping>
    </data-source>
  </component>
</project>
```

Per JetBrains staff (support thread, Nov 2025): `dataSources.local.xml` stores **user names, SSH, and SSL configurations**. Note older docs/threads show component `DataSourceManagerImpl` for both files; current real file uses `dataSourceStorageLocal` — generator should copy the current shape.

**3. SSH semantics (UI-level, docs `Connect to a database with SSH` + `Data Sources and Drivers dialog`):** SSH/SSL tab → `Use SSH tunnel` → SSH Configurations dialog (Add): Host/Port of jump host, Username, Auth type (`Key pair` + Private key file + Passphrase | `Password` | `OpenSSH config and authentication agent` + Proxy host/user/port), Test Connection. DB General tab: host **as seen from the SSH proxy** + port + Database + User & Password auth; DataGrip builds `jdbc:mysql://…` automatically. Local port is dynamic by default (settable). SSH secrets/passwords are never in the XML — same rule as clipboard copy below.

**4. Minimal MySQL+SSH example** (fields limited to verified elements; SSH tunnel itself is attached in-IDE after import — see caveat):

`dataSources.xml`:
```xml
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
    <data-source source="LOCAL" name="prod mysql (ssh)" uuid="3f6a9c2e-1b4d-4e8f-a5c6-7d8e9f0a1b2c">
      <driver-ref>mysql.8</driver-ref>
      <synchronize>true</synchronize>
      <jdbc-driver>com.mysql.cj.jdbc.Driver</jdbc-driver>
      <jdbc-url>jdbc:mysql://db.internal.example.com:3306/appdb</jdbc-url>
      <working-dir>$ProjectFileDir$</working-dir>
    </data-source>
  </component>
</project>
```

`dataSources.local.xml`:
```xml
<project version="4">
  <component name="dataSourceStorageLocal">
    <data-source name="prod mysql (ssh)" uuid="3f6a9c2e-1b4d-4e8f-a5c6-7d8e9f0a1b2c">
      <secret-storage>master_key</secret-storage>
      <user-name>appuser</user-name>
    </data-source>
  </component>
</project>
```

Required vs optional: required = `name`, `uuid` (v4, stable across both files), `<driver-ref>mysql.8</driver-ref>`, `<jdbc-url>`; recommended = `<synchronize>true</synchronize>`, `<working-dir>$ProjectFileDir$</working-dir>`, `<user-name>` in local file; optional = `<jdbc-driver>`, `<database-info>`, `<schema-mapping>`, `<secret-storage>` (omit introspection output in generated files). SSH tunnel + DB/SSH passwords are user-attached post-import.

**5. Import mechanics — clipboard/file-drop AND menu-driven:**
- Clipboard (≥ 2021.1, primary path): in Database Explorer select source → `Ctrl/Cmd+C` (`Copy Data Source`) produces `#DataSourceSettings# / #LocalDataSource: <name> / #BEGIN# <data-source …>…</data-source> / #END#` (multi-block paste supported; INCLUDES SSH/SSL settings, EXCLUDES password). Target IDE: `+ → Import from Clipboard` or `Ctrl/Cmd+V` in Database Explorer. A converter can print this exact wrapper so users paste it in — no files involved.
- File-drop: place generated `dataSources.xml` (+ optional `dataSources.local.xml`) under the target project's `.idea/` (same uuid in both), or copy a whole project dir; file is VCS-shareable by design (docs: `Data sources`).
- Menu-driven (global level): `Make Global` toggle per source → `File → Manage IDE Settings → Export/Import Settings…` → `settings.zip` with `Database: drivers / settings / global sources` components; import reverses it with IDE restart. Global sources are version-pinned (visible only to same-version IDE).

**6. Password storage on import:** passwords are NEVER in `dataSources.xml`, clipboard XML, or the community generation recipe. Stored in KeePass on Windows / native keychain on macOS+Linux (settable to KeePass everywhere via Settings → Appearance & Behavior → System Settings → Passwords); save options Never / Until restart / For session / Forever. Users re-enter DB password + SSH passphrase/key on first connect. Duplicate-within-project is the only flow that keeps the password.

### External References

- [Data sources (2026.2)](https://www.jetbrains.com/help/datagrip/managing-data-sources.html) — project vs global levels, VCS sharing, clipboard + ZIP import flows
- [Connect to a database with SSH](https://www.jetbrains.com/help/datagrip/connect-to-a-database-with-ssh.html) — MySQL-over-SSH worked example (`jdbc:mysql://…:3306/testdb`, key-pair SSH config)
- [Copy and Share Data Sources (blog, 2018, upd. 2021.1+)](https://blog.jetbrains.com/datagrip/2018/05/21/copy-and-share-data-sources-in-datagrip) — clipboard flow, `projects/` vs `options/` paths per OS
- [Directories used by the IDE](https://www.jetbrains.com/help/datagrip/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html) — current per-OS config paths incl. `DataGrip2026.2` example
- [Support: generate dataSources semi-automatically (Nov–Dec 2025)](https://intellij-support.jetbrains.com/hc/en-us/community/posts/30812491105298-Structered-way-to-generate-projects-data-source-connections-semi-automatically) — staff XML skeleton, `dataSources.local.xml` holds user/SSH/SSL, uuid + clipboard format notes
- [intellij-samples .idea/dataSources.xml + dataSources.local.xml](https://github.com/JetBrains/intellij-samples/blob/main/.idea/dataSources.xml) — live MySQL entries quoted above
- [Data Sources and Drivers dialog](https://www.jetbrains.com/help/datagrip/data-sources-and-drivers-dialog.html) — Host/Port/Database + SSH/SSL tab field semantics

### Related Specs

- `.trellis/spec/backend/*` — follow for converter errors/logging when `fromDataGrip` is implemented
- `.trellis/tasks/09-22-converters/prd.md` — task goal: export nodes as DBeaver/DataGrip-importable formats

## Caveats / Not Found

- **SSH tunnel XML element names are NOT published** in the fetched official docs: staff confirms SSH configs ride in `dataSources.local.xml`/clipboard XML (minus secrets), but exact tags/attributes for the SSH tunnel block (host, key path, auth type) were not found in citable sources. Safest converter output: emit `jdbc-url` + `user-name` and instruct attaching the SSH tunnel in-IDE (or reverse-engineer one real export at implementation time and snapshot it as a fixture). Mark: not found — do not invent tag names.
- Blog paths (2018) predate versioned config dirs; always resolve `<product><version>` dynamically, never hardcode.
- DataSpell inherits all of the above via the shared IntelliJ platform; no DataSpell-specific deviation found in sources.
- Second community comment's minimal `<data-source … jdbc-url="…">` attribute-style skeleton contradicts the official nested `<jdbc-url>` element style — prefer the official/nested style plus the live intellij-samples files.
