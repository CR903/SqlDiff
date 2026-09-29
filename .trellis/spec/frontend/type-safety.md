# Type Safety

## Compiler Contract

`apps/desktop/tsconfig.json` enables `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, and consistent filename casing. `tsconfig.main.json` separately emits the main process as CommonJS. Keep both configurations passing; do not weaken strictness to make a renderer or Electron type error disappear.

Main-process modules use default imports for Node built-ins (`fs`, `path`, and `net`). Keep `esModuleInterop: true` in `tsconfig.json`: removing it can leave synthetic type imports that compile but fail when the CommonJS main process starts. If import style changes, verify `npm run build` and an Electron launch, not typecheck alone.

## Type Ownership

- Put domain contracts shared by main and renderer in `src-core/types.ts`: `NodeMeta`, `SecretBundle`, `DiffItem`, `CompareRequest`, `CompareResult`, `DataTableStatus`, and their literal unions.
- Put bridge-only inputs and the exposed API beside the bridge in `src-main/preload.ts`: `NodeCreateInput`, `NodeUpdateInput`, `DataTableLists`, `CompareProgressEvent`, and `SqlDiffApi`.
- Keep module-specific result shapes near their module, such as `RiskAssessment` in `risk.ts`, `TunnelEntry` in `connection.ts`, and `FetchAllOptions` in `data-fetch.ts`.
- Use `import type` for type-only cross-layer imports. `App.tsx`, `store.ts`, and `sql.ts` import bridge types from `preload.ts`; `compare.ts` and `demo.ts` import `DatabaseMetadata` from `metadata.ts` as a type.
- Use literal unions and discriminated decisions rather than broad strings. `ChangeType`, `StmtAspect`, `Verb`, `DataTableStatusKind`, `ResultSource`, and `CoverageReason` are declared in `src-core/types.ts`; `IdentityDecision` is declared in `src-main/data-run.ts`.

## Result Source and Coverage Contract

`CompareResult` gained optional `source` and `coverage` fields. They are optional by design, so treat them as load-bearing at every producer.

### Signatures

```ts
export type ResultSource = 'real' | 'demo';

export type CoverageReason =
  | 'permission-denied'   // MySQL access denied (errno 1044/1142/1143/1227/1370, ER_*ACCESS_DENIED*)
  | 'object-missing'      // SHOW CREATE returned no row/column, or the object vanished mid-scan
  | 'aborted'             // code === 'ABORTED' (aligns with data-run.isAbortErr)
  | 'unknown';            // anything else — the catch-all, never an errno passthrough

export interface CoverageSkip { name: string; objectType: ObjectType; reason: CoverageReason }
export interface StructureCoverage { ok: Record<ObjectType, number>; skipped: CoverageSkip[] }

export interface CompareResult {
  items: DiffItem[];
  stats: CompareStats;
  dataTables?: DataTableStatus[];
  source?: ResultSource;      // absent reads as 'real'
  coverage?: StructureCoverage; // absent means coverage was not collected
}
```

`fetchMetadata` in `src-main/metadata.ts` returns `MetadataSnapshot { meta, skipped }` instead of a bare `DatabaseMetadata`. `meta` keeps its `Record<string, string | null>` shape — that shape is the null-skip invariant documented in [Database Guidelines](../backend/database-guidelines.md), do not flatten it.

### Validation and error matrix

| Condition | Classification | Result effect |
|---|---|---|
| `SHOW CREATE` returns no usable text | `object-missing` | `meta[name] = null`; object skipped by `compareRun` |
| MySQL access-denied errno/code | `permission-denied` | same skip, reported to the user |
| `code === 'ABORTED'` | `aborted` | same skip, reported to the user |
| Unrecognized error shape | `unknown` | same skip; never leaks the raw error |
| `Promise.reject()` with no value | `unknown` | classification must not depend on `err === undefined` |

### Good / base / bad

- **Good**: a real comparison returns `source: 'real'` and a `coverage` whose `skipped` matches the permission-blind tables.
- **Base**: `runDemoCompare` returns `source: 'demo'` with no `coverage`; `compareRun` and `postFilterResult` construct results with `source` undefined.
- **Bad**: a new result producer forgets `source`; the result silently reads as real.

### Tests required

`classifyCoverageReason` branches; `fetchMetadata` producing each reason; `mergeCoverage` accumulation and `scopes` filtering; null-skip never producing a false CREATE/DROP; `runDemoCompare` marked `demo`; the `no-ipc`-versus-real-failure fork in `store.runCompare`. The real path's `source: 'real'` needs real pools, so it is asserted indirectly through the default semantics until the compare/data service integration tests exist.

### Wrong vs correct

```ts
// Wrong: tolerant-style catch that discards the error, so the gap is invisible
const tolerant = (p: Promise<string | null>) => p.catch(() => null);

// Wrong: propagating the driver error into a renderer-visible contract
skipped.push({ name, objectType, reason: String(err) });

// Correct: classify at the boundary, keep the coarse code in the contract,
// and still write null so the null-skip invariant holds
const collect = async (name, objectType, run) => {
  try { const v = await run(); return { v, skip: v == null }; }
  catch (err) { return { v: null, skip: { name, objectType, reason: classifyCoverageReason(err) } }; }
};
```

## Runtime Boundaries

TypeScript types disappear at runtime. The project does not use Zod, Yup, or another schema library.

- Revalidate renderer/import data in main. `buildNodeMeta` validates node fields, `store-json.ts` exposes `isNodeMeta` and `isHistoryEntry`, and `Vault.importDecrypted` validates version, array shape, basic metadata, and encrypted fields.
- Treat persisted JSON as `unknown` before a type guard. Do not let a newly added optional field be assumed present during deserialization.
- Typed preload methods are the renderer's contract, but main remains the authority. For example, `App.handleImportFile` parses JSON, while `nodes.import` and `Vault.importDecrypted` perform the real shape and encryption checks.
- Keep fake boundaries minimal and typed. `DbQueryable`, `TunnelClient`, `DownloadSessionLike`, and `SafeStorageLike` let tests inject narrow doubles without Electron or a live database.

## Assertions

- Production code does not use `any`; the codebase relies on `unknown`, guards, and narrow interfaces. Keep it that way.
- Do not add a type assertion to silence a contract mismatch. First decide whether the main handler needs validation or the shared type is incomplete.
- Assertions are used at deliberate boundaries: parsing JSON (`store-json.ts`, `App.handleImportFile`), unpacking mysql rows (`rowsOf`), adapting a `Pool` to the deliberately small `DbQueryable` shape, typing `ipcRenderer.invoke` results in `preload.ts`, and narrowing validated values. Keep each one justified by the boundary it crosses.
- If a third-party response shape is genuinely uncertain, parse it as `unknown` and narrow it. `rowsOf`, `strCell`, and `isSecretBundle` are the local examples.

## Component and State Types

- Type component props explicitly; do not introduce `PropTypes` alongside TypeScript.
- Keep editable numeric inputs as strings at the DOM edge and normalize them through `normalizeBatchRows`, `normalizeRowThreshold`, or `normalizeInsertBatch`. Store normalized numbers, not `unknown` values.
- Use `ReadonlyArray` or `readonly` parameters for pure helpers that do not mutate input, as `mapWithLimit` and `fetchPageByPK` do.
- Keep the renderer store interface private and export only the store plus UI-specific literal types/constants that components need.

When a contract changes, update both sides of the bridge and add a runtime guard where the value can originate from IPC, JSON, the filesystem, or MySQL.
