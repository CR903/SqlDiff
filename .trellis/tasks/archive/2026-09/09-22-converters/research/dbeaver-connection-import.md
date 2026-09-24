# Research: DBeaver connection import format

- **Query**: How to import MySQL connections into DBeaver (data-sources config file location/format incl. host/port/user/database/SSH tunnel fields; whether CSV or other import exists; password handling — can passwords be imported?)
- **Scope**: external (DBeaver official docs v24+, wiki, community) + internal (converter stub)
- **Date**: 2026-09-22

## Findings

### Files Found

| File Path | Description |
|---|---|
| `<workspace>/General/.dbeaver/data-sources.json` | Main connection store; map of connection definitions keyed by connection ID (docs: `Data-Sources-Json-Reference`) |
| `<workspace>/General/.dbeaver/credentials-config.json` | Encrypted credential store (usernames/passwords, SSH secrets), keyed by connection ID |
| `apps/desktop/src-main/converters/index.ts:1-33` | Internal `NodeConverter` interface stub; phase-2 `fromDBeaver` to be registered here, output `{ meta, secret }` via Vault (never plaintext files) |

Workspace roots by OS (default install): macOS `~/Library/DBeaverData/workspace6/`, Windows `%APPDATA%\DBeaverData\workspace6\`, Linux `~/.local/share/DBeaverData/workspace6/` (or `$XDG_DATA_HOME`). Relative path inside workspace is always `General/.dbeaver/data-sources.json` (docs: `Configuration-files-in-DBeaver`).

### Code Patterns

**1. `data-sources.json` top-level structure** (docs: `Data-Sources-Json-Reference`):

```json
{
  "folders": {},
  "connections": { "<connection-id>": { "provider": "mysql", "driver": "mysql8", "...": "...", "configuration": { "...": "..." } } },
  "connection-types": { "<type-id>": { "...": "..." } }
}
```

Connection-level fields: `provider` (e.g. `mysql`), `driver` (driver ID — verify via Driver Manager → Edit → ID field, e.g. `mysql8`), `name` (display name), `description`, `save-password` (bool, default `false`), `read-only`, `folder`, `custom-properties`, `configuration`.

`configuration` fields: `host`, `port`, `database`, `server`, `url` (full JDBC URL; when set overrides host/port/database/server), `configurationType` (`MANUAL` | `URL`), `type` (connection-type label id, default `dev`), `auth-model` (`native` for MySQL user/password), `auth-properties`, `properties` (raw JDBC driver props), `bootstrap`, `handlers` (SSH/SSL/proxy), `config-profile`.

**2. MySQL auth** (docs: `Auth-Model-Reference`): `auth-model: "native"` with `auth-properties: { "userName": "<user>", "userPassword": "<secret>" }`. Doc example shows plaintext `userPassword` in the JSON reference, BUT on disk DBeaver moves secrets into encrypted `credentials-config.json` (see password handling below).

**3. SSH tunnel = `configuration.handlers.ssh_tunnel`** (docs: `Network-Handlers-Reference`, `SSH-Configuration`):

```json
"handlers": {
  "ssh_tunnel": {
    "type": "TUNNEL", "enabled": true, "save-password": true,
    "properties": {
      "host": "<ssh-host>", "port": 22,
      "authType": "PUBLIC_KEY",
      "user": "<ssh-user>",
      "keyPath": "${project.path}/Keys/id_rsa",
      "implementation": "jsch"
    }
  }
}
```

`authType`: `PASSWORD` (+ `password`), `PUBLIC_KEY` (+ `keyPath` and/or `keyValue`), `AGENT`. Other props: `bypassHostVerification`, `shareTunnels`, `localHost`/`localPort`/`remoteHost`/`remotePort` (port forwarding; default random local port), `aliveInterval`, `sshConnectTimeout`, `implementation` (`jsch`|`sshj`). Jump servers: `jumpServer.count` + indexed `jumpServerN.host/port/name/authType/enabled`. UI guidance: Main-tab DB host is resolved from the SSH server side — use `localhost` when the DB runs on the SSH host itself.

**4. Minimal MySQL+SSH example** (synthesized strictly from the documented fields above):

```json
{
  "folders": {},
  "connections": {
    "mysql-ssh-demo-0001": {
      "provider": "mysql",
      "driver": "mysql8",
      "name": "prod mysql (ssh)",
      "save-password": true,
      "configuration": {
        "host": "127.0.0.1",
        "port": "3306",
        "database": "appdb",
        "configurationType": "MANUAL",
        "type": "dev",
        "auth-model": "native",
        "auth-properties": { "userName": "appuser" },
        "handlers": {
          "ssh_tunnel": {
            "type": "TUNNEL",
            "enabled": true,
            "save-password": true,
            "properties": {
              "host": "bastion.example.com",
              "port": 22,
              "authType": "PUBLIC_KEY",
              "user": "sshuser",
              "keyPath": "~/.ssh/id_rsa"
            }
          }
        }
      }
    }
  }
}
```

Required vs optional: required = `provider`, `driver`, `name`, `configuration.host/port/database` (or `url` + `configurationType: URL`), `auth-model`; optional = `description`, `folder`, `properties`, `bootstrap`, `handlers.*` (SSH only when tunneling), passwords/keys (re-entered by user). `folders` may be `{}`.

**5. Import mechanics — menu-driven AND file-drop:**
- Menu: `File → Import → Third Party Configuration` tab → pick source tool (DBVisualizer ≤ v7, MySQL Workbench, DataGrip/JetBrains IDE, Navicat, Oracle SQL Developer, pgAdmin 4, SQL Squirrel, Toad) or `Custom` for generic `XML`/`CSV` (choose driver → input type → file path → encoding → Finish). DataGrip sub-option also accepts `Project folder` mode or `Paste configuration` of `#DataSourceSettings#` blocks (docs: `How-to-import-Connections-from-External-Tools`).
- File-drop equivalent: any file matching `.dbeaver/data-sources*.json` in the project folder (e.g. a generated `data-sources-2.json`) is loaded on startup (wiki: `Admin-Manage-Connections`). So a converter can emit a JSON file the user drops next to `data-sources.json`.
- Legacy (< 6.1.3): XML file `.dbeaver-data-sources.xml`; current format is JSON.

**6. Password handling — passwords canNOT be imported:**
- Official note: "Secure data, such as SSH keys and passwords, are not imported automatically for security reasons. You will need to enter this information manually in DBeaver after the import process." (applies to third-party AND Custom CSV/XML import.)
- At rest: usernames/passwords/SSH secrets live encrypted in `credentials-config.json` (default AES-128-CBC with a publicly-known fixed key — decryptable by third-party tools; NOT secure), or OS secure storage / master password / PRO secret providers (docs: `Project-security`, `Security`). `save-password: true` + handler `save-password: true` opt into persisting secrets.
- Consequence for a converter: emit connection topology (host/port/db/user/SSH host/key path) WITHOUT secrets; user types DB + SSH passwords/passphrases on first connect.

### External References

- [data-sources.json reference](https://dbeaver.com/docs/dbeaver/Data-Sources-Json-Reference/) — full field tables + examples; basis of §1–2
- [Network handlers reference](https://dbeaver.com/docs/dbeaver/Network-Handlers-Reference/) — `ssh_tunnel` property table + jump-server example; basis of §3
- [SSH configuration](https://dbeaver.com/docs/dbeaver/SSH-Configuration/) — UI field semantics, `localhost` Main-host rule, port-forwarding/URL-connection caveat
- [Import connections from external tools](https://dbeaver.com/docs/dbeaver/How-to-import-Connections-from-External-Tools) — File→Import wizard, Custom CSV/XML, DataGrip paste-block example
- [Configuration files](https://dbeaver.com/docs/dbeaver/Configuration-files-in-DBeaver) — workspace-relative locations
- [Auth model reference](https://dbeaver.com/docs/dbeaver/Auth-Model-Reference) — `native` + `userName`/`userPassword`
- [Admin Manage Connections (wiki)](https://github.com/dbeaver/dbeaver/wiki/Admin-Manage-Connections) — multiple `data-sources*.json` auto-load on startup
- [Project security](https://dbeaver.com/docs/dbeaver/Project-security) — `credentials-config.json` default DES/AES fixed-key encryption caveat

### Related Specs

- `.trellis/spec/backend/*` (database/error-handling/logging guidelines) — converter error messages and logging must follow these when `fromDBeaver` is implemented
- `.trellis/tasks/09-22-converters/prd.md` — task goal: export nodes as DBeaver/DataGrip-importable formats

## Caveats / Not Found

- Exact `Custom` CSV/XML **column schema is undocumented** in the fetched official docs (no public header list found). Prefer emitting `data-sources.json` over CSV. Mark: not found.
- Whether hand-written plaintext `userPassword` inside `auth-properties` is honored on startup (vs. migrated to `credentials-config.json` or ignored) is **not documented**; converter must NOT rely on it — ship without secrets.
- MySQL `driver` ID string (`mysql8` vs variant IDs per distribution) must be verified at implementation time via Driver Manager → Edit → ID; provider ID likewise.
- URL-based connections + SSH require manual port-forwarding config (DBeaver cannot rewrite arbitrary JDBC URLs); prefer `MANUAL` host/port/database output.
