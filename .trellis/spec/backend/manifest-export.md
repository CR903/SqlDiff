# Review Manifest Export Contract

## 1. Scope / Trigger

Use this contract whenever adding or changing SqlDiff's review-manifest export (`导出审查报告`). The manifest turns one real comparison into a versioned, secret-free JSON/Markdown artifact for handoff. It is a deterministic projection of `CompareResult`, not a new data store: no re-run, no persistence, no SQL execution entry point.

Source of truth: `apps/desktop/src-core/manifest.ts`, the `导出审查报告` button in `src-renderer/App.tsx`, and the `app.version` IPC handler in `src-main/main.ts` / `src-main/preload.ts`.

## 2. Signatures

```ts
// src-core/types.ts
export const REVIEW_MANIFEST_VERSION = 1;
export type CoverageStatusKind =
  | 'ok' | 'permission-denied' | 'no-row-identity'
  | 'over-threshold' | 'aborted' | 'error' | 'grant-invisible';
export interface CoverageStatus { kind: CoverageStatusKind; counts: Partial<Record<CoverageStatusKind, number>> }
export interface ReviewManifestItem { id; objectType; objectName; changeType; dml?; aspects; risk; sql }
export interface ReviewManifest { schemaVersion; appVersion; exportedAt; aAlias; bAlias; scope; source: 'real'; stats; items; dataTables?; coverage?; visibility?; coverageStatus }
export interface ManifestBuildInput { result: CompareResult; request: CompareRequest; aAlias; bAlias; appVersion }

// src-core/manifest.ts（纯函数，跨宿主）
export function deriveCoverageStatus(result: CompareResult): CoverageStatus;
export function redactDmlSql(sql: string): string;
export function buildManifest(input: ManifestBuildInput): ReviewManifest;
export function serializeManifest(m: ReviewManifest): string;   // JSON.stringify(m, null, 2) + '\n'
export function manifestToMarkdown(m: ReviewManifest): string;
export function manifestFileNames(exportedAt: string): { jsonFileName: string; markdownFileName: string };
```

IPC contract:

```ts
SqlDiffApi.app.version(): Promise<string>   // ipcRenderer.invoke('app.version') -> app.getVersion()
SqlDiffApi.file.save(request: SaveRequest): Promise<SaveResult>   // system save dialog + real disk write
```

`file.save` is the only file-writing channel shared by all exports (see [Quality Guidelines](./quality-guidelines.md#export-save-path)).

Manifest build and serialization run entirely in the renderer as pure functions. The main process only supplies the app version; it never receives the result, request, or manifest.

## 3. Contracts

- **Real-only**: `buildManifest` throws `manifest: 演示结果不可导出审查报告，请先完成一次真实比较` when `result.source === 'demo'`. The UI disables the export button unless `resultSource === 'real'` and `lastCompareRequest` is set.
- **Deterministic projection**: field order is the type-declaration order (object literal insertion order); `serializeManifest` is byte-stable for identical input, matching the DBeaver export determinism contract.
- **No rollback / explain**: `ReviewManifestItem` deliberately omits both. Achieved by not copying the fields, never by copy-then-delete.
- **Secret boundary**: manifest JSON/Markdown must never contain `password`, `sshPassword`, `privateKey`, `passphrase`, `vaultCiphertext`, `userPassword`, `SecretBundle`, or connection strings. `redactDmlSql` is applied inside `serializeManifest` / `manifestToMarkdown` to `objectType === 'data'` items only. The in-memory manifest keeps original SQL because the renderer already owns the real DML for the data panel; the downloaded artifacts are redacted.
- **Filename**: `sqldiff-review-<exportedAt with : and . replaced by ->.json` / `.md`, e.g. `sqldiff-review-2026-09-30T10-00-00-000Z.json`. Both files are written in one call through `saveTextFiles` (`kind: 'bundle'`), which prompts for a single directory instead of two consecutive save dialogs.
- **No execution entry**: manifest modules never call a pool, never execute SQL, and never touch Vault. `mysqldiff/` is untouched.

## 4. CoverageStatus Mapping

`deriveCoverageStatus` maps each source to the unified enum and accumulates `counts`:

| Source | Original state | Maps to |
|---|---|---|
| nothing wrong | — | `ok` |
| `coverage.skipped[].reason === 'permission-denied'` | — | `permission-denied` |
| `coverage.skipped[].reason === 'object-missing' \|\| 'unknown'` | — | `error` |
| `coverage.skipped[].reason === 'aborted'` | — | `aborted` |
| `dataTables[].reason === 'no-pk' \|\| 'pk-mismatch'` (any status) | — | `no-row-identity` |
| `dataTables[].reason === 'over-threshold'` or `status === 'confirm-needed'` | — | `over-threshold` |
| `dataTables[].reason === 'aborted'` | — | `aborted` |
| `dataTables[].reason === 'fetch-failed'` or `status === 'error'` | — | `error` |
| `visibility.excluded.length > 0` | — | `grant-invisible` |

`kind` priority: `grant-invisible` > `permission-denied` > `over-threshold` > `no-row-identity` > `error` > `aborted` > `ok`. With no issues, `counts` is `{ ok: 1 }`; otherwise each contributing source adds 1 (each excluded object adds 1 to `grant-invisible`).

Note: `pk-mismatch` is produced by `data-run.ts` with `status: 'error'` but is semantically a row-identity problem, so it maps to `no-row-identity` (reason wins over status).

## 5. DML Redactor Rules

`redactDmlSql(sql)` is a single-pass character scanner:

- Single-quoted string literals (including dates and Buffer escape strings) → `'***'`
- Numeric literals → `0` (negative sign stays as operator: `-1` → `-0`; scientific notation handled)
- `NULL` / `TRUE` / `FALSE` preserved
- Backtick identifiers (including doubled-backtick escapes) preserved verbatim
- Comments (`--`, `/* */`) and keywords/operators preserved
- Escaped quotes (`\'`) and doubled quotes (`''`) inside strings handled

The scanner is used instead of a two-pass regex because it correctly handles doubled backticks in identifiers and backticks inside string literals. `redactDmlSql` is only ever called on `objectType === 'data'` items during serialization; DDL is never redacted.

## 6. Validation & Error Matrix

| Condition | Result |
|---|---|
| `result.source === 'demo'` | `buildManifest` throws `manifest:` error; UI disables button |
| `lastCompareRequest` null | UI toast `暂无可导出的审查报告（先完成一次真实比较）` |
| `app.version` IPC unavailable (no backend) | App falls back to `'0.0.0'` |
| Data DML with real values | JSON/Markdown contain `'***'` / `0`, never the real values |
| Polluted manifest input with secret fields | Serialization only emits the allow-listed `ReviewManifest` fields |

## 7. Good / Base / Bad Cases

- Good: a real comparison with structural + data diffs, coverage skips, and excluded objects exports a JSON manifest whose `items[].sql` redacts data values, plus a Markdown report with header, summary table, DDL blocks, coverage/visibility notes, and confidentiality statement.
- Base: a real zero-diff comparison exports a valid manifest with `coverageStatus.kind === 'ok'`.
- Bad: exporting a demo result, including rollback/explain, leaking row values or secrets, or adding a SQL execution entry point.

## 8. Tests Required

`src-core/manifest.test.ts` must cover: every `deriveCoverageStatus` branch (ok / permission-denied / no-row-identity / over-threshold / aborted / error / grant-invisible), `redactDmlSql` (string / number / date / Buffer / NULL / backtick-with-quote / doubled backtick / multiline / comments), byte-stable `serializeManifest`, `manifestToMarkdown` sections, the demo rejection, the rollback/explain exclusion, secret-field absence, and the AC3 round-trip (real result → manifest → parse back to equivalent semantics).

The full gate runs `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` from `apps/desktop`.

## 9. Wrong vs Correct

```ts
// Wrong: letting demo results produce a manifest that reads as real
const m = buildManifest({ result: demoResult, ... });

// Wrong: copying rollback/explain then deleting (future edits may forget)
const item = { ...diffItem };
delete item.rollback;
delete item.explain;

// Wrong: serializing the in-memory sql directly, leaking row values
saveTextFiles([{ name, content: JSON.stringify(m.items, null, 2) }], '导出');

// Correct: redaction happens in the output layer, DDL untouched
// One directory pick, both files written; the toast reports the real path.
const names = manifestFileNames(m.exportedAt);
const outcome = await saveTextFiles([
  { name: names.jsonFileName, content: serializeManifest(m) },
  { name: names.markdownFileName, content: manifestToMarkdown(m) },
], '导出审查报告（JSON + Markdown）');
if (outcome.status === 'canceled') return;
```