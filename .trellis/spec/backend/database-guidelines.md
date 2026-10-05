# MySQL Read-Only Guidelines

## No Database Ownership Layer

SqlDiff does not own the inspected schemas and has no ORM, migrations, repositories, transactions, or write API for those databases. `apps/desktop/src-main/connection.ts` uses `mysql2/promise` directly; schema discovery lives in `metadata.ts`; row reads live in `data-fetch.ts`. Do not introduce a migration or persistence framework for the databases being compared.

## SQL Construction

- Parameterize values. The schema name is passed as `?` by `SQL_TABLES`, `SQL_VIEWS`, and `SQL_ROUTINES`, and keyset values are passed as parameters by `fetchPageByPK`.
- Escape identifiers in executed MySQL queries because MySQL does not parameterize table or column names. Use `escapeIdent` in `src-main/metadata.ts` / `src-main/data-fetch.ts`; generated DML uses `escapeDataIdent` in `src-core/data-diff.ts`. The legacy structural diff builder in `src-core/diff.ts` currently interpolates object names inside backticks, so hardening generated structural DDL is a separate product/security change and must not be assumed here.
- Keep generated DML text separate from executed SQL. `sqlLiteral` and `diffDataRows` escape values for output only; generated `INSERT`, `UPDATE`, and `DELETE` text is returned to the user and is never passed to a pool.
- Interpolate `LIMIT` only after integer normalization. `fetchPageByPK` passes the `normBatch` result into `LIMIT ${n}`; do not interpolate raw input.
- Preserve the compatibility SQL in `metadata.ts`: `SQL_TABLES` selects `BASE TABLE`, `SQL_VIEWS` selects `VIEW`, and `SQL_ROUTINES` reads distinct names/types from `information_schema.parameters`. `metadata.test.ts` asserts these predicates.

## Read Operations

The main process may execute only:

- `SELECT 1` for connection tests in `testConnection`, `pingDirect`, and `pingViaTunnel`;
- `SELECT COUNT(*)` and keyset-paginated `SELECT *` in `data-fetch.ts`;
- `information_schema` list queries and `SHOW CREATE` in `metadata.ts`;
- `SHOW GRANTS FOR CURRENT_USER()` in `grants.ts`. This is the only authorization query, it is a fixed literal with no parameters, and it reads **only the current user's own grants** — the module deliberately offers no `FOR <user>` entry point. Grant text is parsed in-process and never leaves `grants.ts` as text: only `VisibilityAssessment` (`byDatabase` + `reliable`) crosses back. Do not query other accounts' grants and do not surface grant text in results, UI, or exports.

Generated DDL and DML are comparison output. `data-run.ts` and `compare-run.ts` must never call `pool.query` with `DiffItem.sql` or `DataDiffResult` values.

### Preflight read-only extension

`src-main/preflight-collect.ts` adds a **Preflight-only** read-only surface for the v1 production preflight (see [Preflight Contract](./preflight.md#4-只读-sql-清单)). All Preflight statements are fixed literals with parameterized identifiers; the full list is:

- `SELECT VERSION(), @@version_comment, @@sql_mode, @@innodb_file_per_table, @@transaction_isolation, @@lower_case_table_names, @@character_set_server, @@collation_server` (server facts);
- `SELECT @@innodb_buffer_pool_size, @@max_connections, @@tmp_table_size, @@sort_buffer_size, @@thread_cache_size, @@innodb_page_size, @@max_allowed_packet` (variable facts);
- `SELECT table_name, table_rows, data_length, index_length, data_free, engine, row_format, auto_increment, update_time, checksum FROM information_schema.tables WHERE table_schema = ? AND table_name IN (?, ?, ...)` — batched with a `?` placeholder per table, 100 per batch;
- `SELECT table_name, index_name, column_name, seq_in_index, non_unique FROM information_schema.statistics WHERE table_schema = ? AND table_name IN (?, ?, ...)` — batched the same way;
- `SELECT table_name, constraint_name, column_name FROM information_schema.key_column_usage WHERE table_schema = ? AND referential_constraint IS NOT NULL` (foreign keys, once per database, filtered in-process by the target table list);
- `SHOW REPLICA STATUS` (MySQL 8.0.22+) with automatic fallback to `SHOW SLAVE STATUS` for 5.7 / 8.0.21-; both are fixed literals with no parameters;
- `SELECT @@server_id, @@read_only, @@super_read_only, @@log_bin, @@gtid_mode` (replication-related system variables);
- `SHOW GRANTS FOR CURRENT_USER()` — the same constant `SQL_SHOW_GRANTS` already used by `grants.ts`; grant text is parsed in-process through `src-core/visibility.ts` and only the structured `permissions.visibility` / `permissions.reliable` verdicts cross back.

**Hard boundary — never allowed in Preflight or anywhere else in the read-only surface:**

- `SET` statements (the substring inside `CONVERT TO CHARACTER SET` is a table-level ALTER clause and does not count as a `SET` statement);
- `INSERT` / `UPDATE` / `DELETE`;
- `SELECT ... FOR UPDATE` / `SELECT ... FOR SHARE`;
- `pool.query(diffItem.sql)` / `pool.execute(...)` or any other path that executes a `DiffItem.sql` value. `preflight-run.ts` and `preflight-collect.ts` are grepped in tests to enforce this;
- Any invocation of `pt-online-schema-change`, `gh-ost`, or cut-over commands.

Preflight reuses the same error classifier (`classifyCoverageReason`) and same pool abstraction (`DbQueryable`) as `metadata.ts` — no second read path, no new pool implementation.

## Connection and Concurrency

- Direct connections and one-hop SSH tunnels both return a `mysql2/promise` `Pool` from `createMysqlPool`. The pool limit is five; callers own `pool.end()`.
- Metadata `SHOW CREATE` calls use order-preserving `mapWithLimit` with `MAX_CONCURRENCY = 10` for each object-category map in each database, matching `fetchMetadata` and its tests. `fetchMetadata` runs the four category maps concurrently (and A/B metadata fetches run concurrently), so the constant is a per-map limit rather than a global pool-wide cap.
- Data tables are intentionally processed serially in `runDataCompare` to bound memory. A and B reads for one table run concurrently, but the next table waits.
- The orchestration paths close their assigned pools in `finally` with `Promise.allSettled`, as in `runCompareRequest`, `runDataCompare`, and the `data.tables` handler. Cleanup failure must not mask the comparison result. Pool construction is assigned only after both `Promise.all` calls settle; if one pool is created before the other fails, the current destructuring pattern has no reference to close, which remains a product cleanup gap rather than a guarantee to document as solved.
- SSH tunnels are cached by `nodeId`, concurrent `ensureTunnel` calls share an in-flight promise, and `main.ts` invokes `closeAll` from its `before-quit` hook (the hook is not awaited). `pickRandomPort` uses the legacy 32000-35000 range and `ensureTunnel` retries `EADDRINUSE` up to `MAX_TUNNEL_ATTEMPTS`. Pools and temporary ping connections do not own cached tunnels.

## Scopes Normalization: Respect Selection, Keep Fail-Safe

`normalizeScopes` in `src-core/compare-filter.ts` validates untrusted `CompareRequest.scopes`. It must distinguish two kinds of "empty", because conflating them silently executes work the user never selected.

| Input | Result | Reason |
|---|---|---|
| `['table','view']` | `['table','view']` (deduped) | Explicit structural selection |
| `['table','data','view']` | `['table','view']` | `'data'` is a valid token but not a structure type; drop it from the structural result |
| `['data']` | `[]` | "Compare data only" is a valid intent — an empty structural set, not a missing one |
| `[]` | `[]` | Explicitly nothing selected |
| `['data','bogus']` | `[]` | Contains a valid token, so intent is readable; structure set is empty |
| `null` / `undefined` / `42` / `'table'` / `{}` | `ALL_SCOPES` | Unreadable request → compare everything rather than silently nothing |
| `['bogus']` / `[true,123]` / `[null]` | `ALL_SCOPES` | Non-empty but no valid token: neither a selection nor readable intent → fail-safe |

**The discriminator is "does the raw array contain at least one known token" (`ALL_SCOPE_TOKENS` = `ALL_SCOPES` + `'data'`), not "how many survive filtering".** `['data']` also filters down to zero, but it expresses a real choice. Derive both the filter predicate and the token set from the single `ALL_SCOPES` source so the filter and the fail-safe check cannot drift apart.

Why this matters: before this contract, `['data']` fell into the same `kept.length === 0` branch as `['bogus']` and returned `ALL_SCOPES`. Unchecking all four structure checkboxes while leaving data checked therefore ran a full structural comparison, while both the UI and `lastComboText` reported `data` — an unrequested operation with no visible trace. A read-only tool must not widen its own scope.

Do not "fix" this by blocking data-only runs in the UI. The IPC path and `compare-run.ts:206` bypass renderer validation, so `normalizeScopes` stays the enforcement point. Downstream, an empty structural set is safe: `filterMetadataByScopes` empties all four maps, `postFilterResult` lets `data` rows bypass the structural filter, `mergeCoverage` reports zero `ok` with no misleading `skipped`, and `resolveDataPairs` reads the **unfiltered** snapshots so data pairing still works.

> **Warning**: `lastComboText` must render the executed scope set, not the checkbox state. Concatenating `scopes.join('/')` with a hardcoded `'/data'` suffix emits a leading-slash `· /data` when no structure type is checked, which hides exactly the condition above.

### Two Rules on One Array — Verified Safe, Do Not "Fix" It

`hasDataScope(scopes, includeData)` and `normalizeScopes(scopes)` both read `CompareRequest.scopes` but answer different questions with different rules: the `'data'` token decides *whether data comparison runs*, while `includeData` does too, and `normalizeScopes` separately decides the structural set. They are **not** redundant, and the overlap is intentional, documented on `CompareRequest` in `src-core/types.ts:137-141` as "`'data'` … equivalent to `includeData`, kept for old callers".

Verified on 2026-10-05, so this is recorded as a known-safe state rather than a pending defect:

- `CompareRequest` has exactly one construction site in the product (`store.ts:609`), and it sends `includeData` and the `'data'` token together.
- A hypothetical caller sending only `includeData: true` without the token gets `normalizeScopes` → the structural set implied by its own `scopes`, plus data on. That is the intuitive reading, not a silent divergence.

When adding a second caller, send both fields as `store.ts` does. Collapsing `hasDataScope` to read only `includeData` would be a behavior change to a documented compatibility path, not a cleanup — take it to a product decision first.

## Snapshot and Direction Semantics

- A is the source/expected database; B is the target/database to upgrade. `compareRun` and `diffDataRows` generate SQL that changes B toward A.
- `fetchMetadata` returns a `MetadataSnapshot` (`{ meta, skipped }`), not a bare `DatabaseMetadata`. `meta` keeps the `Record<string, string | null>` maps unchanged: a missing map key means the object is absent, and a `null` value means there is no usable `SHOW CREATE` text (the query failed, the row/column was missing, or the value was empty). `pick` and the `compareRun` null checks still skip such objects.
- **The null-skip invariant is narrower than it looks, and the earlier claim that it "prevents a permission error from becoming a false CREATE/DROP" was falsified on 2026-09-29.** A `null` only covers objects that *were enumerated* but whose `SHOW CREATE` failed. It says nothing about objects that are **invisible to the connection account at all** — those never reach `information_schema`, so `compareRun` saw a genuinely missing key and emitted a correct-looking `DROP TABLE`. The measured case (isolated MySQL 5.7.18): a table-level account could not see `secret_tbl` in A, could see it in B, and the pre-fix output was `DROP TABLE \`secret_tbl\`;` with `stats.DROP = 1`. Treat the two gaps as separate and cover both.
- **Invisible objects are handled by pre-comparison narrowing, not by the null skip.** `assessVisibility` in `grants.ts` probes `SHOW GRANTS FOR CURRENT_USER()`, `parseGrantLines` in `src-core/visibility.ts` decides per database whether full visibility is provable, and `narrowToSharedVisibility` in `compare-run.ts` narrows the metadata to the objects visible on **both** sides. Single-side objects leave the comparison and are reported as `CompareResult.visibility.excluded`; they never produce CREATE or DROP. Narrowing happens **before** `compareRun` because the false DROP is generated inside `compare.ts` (a `missing` side is passed as an empty string), and filtering `items` afterwards cannot distinguish a true DROP from a false one. `compareRun` therefore stays a pure function with no grant or visibility knowledge.
- The conservatism is one-directional and must not be reversed: `reliable: false` (query failure, an unrecognized `SHOW GRANTS` shape, or a MySQL 8.0 `GRANT \`role\` TO` line that does not expand table-level grants) always narrows as `partial`. Treating an unprovable assessment as `full` would re-admit the false DROP. Database-level `SELECT` / `ALL PRIVILEGES` is a sufficient condition for `full` (measured: a `GRANT SELECT ON db.*` account enumerates every object including ones a table-level account cannot see); a table-level grant, a database-level grant without read privilege, or a database absent from the grant list is `partial`. A database with both levels resolves to `full`, because the database-level grant is a strict superset.
- **Database names are matched exactly, never case-insensitively.** `lower_case_table_names = 0` is the Linux default (including the 5.7.18 fixture), where `Foo` and `foo` are two different schemas, so a `GRANT ... ON \`Foo\`.*` proves nothing about a node configured with `foo`. A case-insensitive fallback fabricates `full`, skips the narrowing, and turns the whole A-side schema into a silent false `DROP TABLE` when that connection can read nothing (the usual cause is a database name typed in the wrong case). `lower_case_table_names != 0` platforms lose the convenience — when both sides enumerate the same objects the intersection equals the original set, so `excluded` stays empty and the UI stays silent.
- Skipping stays silent for the diff but is never silent for the user: `skipped` records `{ name, objectType, reason }` for every object whose `SHOW CREATE` did not produce text. `classifyCoverageReason` in `src-main/metadata.ts` maps the failure to one of `permission-denied` / `object-missing` / `aborted` / `unknown`; unrecognized shapes degrade to `unknown`, and MySQL `errno` and raw messages are not passed through. `mergeCoverage` in `compare-run.ts` merges the A/B snapshots into `CompareResult.coverage`, filtered by the same `scopes` as `filterMetadataByScopes`. The two sides are not labeled: a same-named object on both sides produces two `skipped` entries, which is the intended conservative reading of "at least one side was not checked".
- `coverage` and `visibility` are different reports and both are needed. `coverage` answers "which enumerated objects could not be read"; `visibility` answers "which objects could not even be enumerated, and how much of the comparison the account can prove it covered". A result may have either, both, or neither.
- `compare-run.ts` marks the real path with `source: 'real'`; `src-renderer/demo.ts:runDemoCompare` is the only place that marks `source: 'demo'`. The field is optional because `compareRun` and `postFilterResult` construct results inside `src-core` and cannot know their caller; a missing `source` is treated as `'real'`.
- Data comparison requires matching row identity. `decideIdentity` prefers a primary key, then a matching all-`NOT NULL` UNIQUE key, and returns a typed skip or mismatch decision otherwise.
- Row reads use keyset pagination, not the legacy `LIMIT 5000`. Oversized tables require confirmation through `DataThresholdError`; cancellation uses an `ABORTED` error code and `AbortSignal`.

## Schema Names and Identifiers

SqlDiff does not rename tables or columns. Preserve names and case returned by MySQL, and compare them case-insensitively only where the existing filters explicitly do so. Executed queries use the escaping helpers above; generated structural DDL currently follows the legacy backtick interpolation in `src-core/diff.ts`. Database object ordering uses `localeCompare` plus the numeric `DiffItem.id` tie-breaker in `sortDiffItems`.
