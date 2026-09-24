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
- `information_schema` list queries and `SHOW CREATE` in `metadata.ts`.

Generated DDL and DML are comparison output. `data-run.ts` and `compare-run.ts` must never call `pool.query` with `DiffItem.sql` or `DataDiffResult` values.

## Connection and Concurrency

- Direct connections and one-hop SSH tunnels both return a `mysql2/promise` `Pool` from `createMysqlPool`. The pool limit is five; callers own `pool.end()`.
- Metadata `SHOW CREATE` calls use order-preserving `mapWithLimit` with `MAX_CONCURRENCY = 10` for each object-category map in each database, matching `fetchMetadata` and its tests. `fetchMetadata` runs the four category maps concurrently (and A/B metadata fetches run concurrently), so the constant is a per-map limit rather than a global pool-wide cap.
- Data tables are intentionally processed serially in `runDataCompare` to bound memory. A and B reads for one table run concurrently, but the next table waits.
- The orchestration paths close their assigned pools in `finally` with `Promise.allSettled`, as in `runCompareRequest`, `runDataCompare`, and the `data.tables` handler. Cleanup failure must not mask the comparison result. Pool construction is assigned only after both `Promise.all` calls settle; if one pool is created before the other fails, the current destructuring pattern has no reference to close, which remains a product cleanup gap rather than a guarantee to document as solved.
- SSH tunnels are cached by `nodeId`, concurrent `ensureTunnel` calls share an in-flight promise, and `main.ts` invokes `closeAll` from its `before-quit` hook (the hook is not awaited). `pickRandomPort` uses the legacy 32000-35000 range and `ensureTunnel` retries `EADDRINUSE` up to `MAX_TUNNEL_ATTEMPTS`. Pools and temporary ping connections do not own cached tunnels.

## Snapshot and Direction Semantics

- A is the source/expected database; B is the target/database to upgrade. `compareRun` and `diffDataRows` generate SQL that changes B toward A.
- `fetchMetadata` returns name-to-`SHOW CREATE` maps. A missing map key means the object is absent; a `null` value means there is no usable `SHOW CREATE` text (the query failed, the row/column was missing, or the value was empty), and the object must be skipped, as implemented by `pick` and the `compareRun` null checks. This prevents a permission error from becoming a false CREATE/DROP.
- Data comparison requires matching row identity. `decideIdentity` prefers a primary key, then a matching all-`NOT NULL` UNIQUE key, and returns a typed skip or mismatch decision otherwise.
- Row reads use keyset pagination, not the legacy `LIMIT 5000`. Oversized tables require confirmation through `DataThresholdError`; cancellation uses an `ABORTED` error code and `AbortSignal`.

## Schema Names and Identifiers

SqlDiff does not rename tables or columns. Preserve names and case returned by MySQL, and compare them case-insensitively only where the existing filters explicitly do so. Executed queries use the escaping helpers above; generated structural DDL currently follows the legacy backtick interpolation in `src-core/diff.ts`. Database object ordering uses `localeCompare` plus the numeric `DiffItem.id` tie-breaker in `sortDiffItems`.
