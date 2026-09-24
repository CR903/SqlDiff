# Hook Guidelines

## Current Pattern

There are no project-specific `use*.ts` hooks and no `src-renderer/hooks/` directory. Hooks are used locally where the state belongs:

- `App` owns global selectors, initial refresh effects, the toast timer, the Cmd/Ctrl+Enter listener, and memoized filtering;
- `SqlPreview` memoizes export/highlight output;
- `DataOptionsInputs` keeps editable strings local and synchronizes them when normalized store values change;
- `DataSection` keeps pending table selections local;
- `NodeModal` owns its form and async flags;
- `NodeLibrary` uses a `useRef<HTMLInputElement>` for the hidden file picker.

Do not invent a custom-hook convention merely to move a few lines. A future shared stateful renderer behavior may become a `use<Capability>` hook, but that would be a new structure and should include focused tests.

## Effects and Cleanup

- Effects that register external resources must return cleanup. `App` removes the keyboard listener and clears the toast timeout; its initial refresh promises are explicitly caught.
- Keep subscription unsubscribe functions. `store.runCompare` saves the function returned by `api.compare.onProgress` and calls it in `finally`; the preload API returns that unsubscribe function.
- Effects should synchronize external state only when needed. `DataOptionsInputs` uses one effect per normalized prop rather than duplicating numeric values in the store as editable strings.
- Do not use an effect to compute filtered rows, counts, SQL text, or risk text. Those are synchronous derivations owned by `useMemo` or pure functions.

## Memoization and Dependencies

- Build memo stages from stable primitives/state, as `App` does with `byKw -> byObj -> byAspect -> tabItems`.
- Include every referenced value that can change. `SqlPreview.exportText` intentionally depends on `tabItems`, `selectedId`, `aName`, and `bName`, not the freshly allocated `current` array; its comment records that reason.
- Do not put a new object/array reference created during render into a dependency unless it is itself the intended trigger. A common source of accidental repeated work is adding an inline filtered list or callback to a `useMemo`/`useEffect` dependency.
- Keep pure calculations in `node-filter.ts` or `src-core` when they do not need React; `visibleNodes`, `verbOf`, and `postFilterResult` are directly testable examples.

## Data Fetching

There is no React Query, SWR, or data-fetch hook layer. IPC refreshes and mutations live in Zustand actions (`refreshNodes`, `refreshHistory`, `refreshDataTables`, `runCompare`, node CRUD). Components select those actions and manage only presentation-local pending state. When adding a new IPC-backed resource, follow that action boundary instead of each component fetching independently.
