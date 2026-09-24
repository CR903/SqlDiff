# Renderer Directory Structure

## Current Layout

```text
apps/desktop/
├── index.html                         # Vite HTML entry
├── src-renderer/
│   ├── main.tsx                       # React root and StrictMode
│   ├── App.tsx                        # App composition plus local components
│   ├── store.ts                       # single Zustand store and async actions
│   ├── sql.ts                         # format/highlight/copy/download helpers
│   ├── node-filter.ts                 # pure left-panel filtering
│   ├── demo.ts                        # no-IPC comparison fixture
│   ├── styles.css                     # global dark desktop styles
│   ├── vite-env.d.ts
│   └── *.test.ts                      # colocated pure renderer tests
├── src-core/                          # domain logic/types shared with main
└── src-main/preload.ts                # typed contextBridge API and renderer-facing inputs
```

There is intentionally no `pages/`, `routes/`, `components/`, `hooks/`, or CSS-module tree. The current UI is small enough that named components live together in `src-renderer/App.tsx`: `NodeLibrary`, `NodeCard`, `HistoryRow`, `Slot`, `CompareSlots`, `DiffTable`, `DataOptionsInputs`, `DataSection`, `SqlPreview`, `DBeaverExportModal`, and `NodeModal`.

## Placement Rules

- `main.tsx` owns only mounting and global stylesheet import. Keep startup side effects in `App` or store actions, not the React root bootstrap.
- `App.tsx` is the current composition boundary. It selects shared state, derives the visible diff list, and passes data/callbacks to local components. A component that needs a large independent state machine may justify a new file, but no such split currently establishes a directory convention.
- `store.ts` owns shared domain state and IPC side effects. Do not call `window.sqldiff` independently from several presentational components for the same resource; route refresh/mutation through store actions as `refreshNodes`, `refreshDataTables`, and `runCompare` do.
- `node-filter.ts` and the pure highlighter/export helpers in `sql.ts` are renderer-local; `sql.test.ts` directly tests `highlightSql` and `buildExportText`. Move logic to `src-core` when it must be shared by main and renderer, as with `compare-filter.ts`; `ipc-error.ts` is a pure renderer-facing helper kept browser-safe in `src-core`.
- `demo.ts` is preview/fallback data, not a mock server. It calls the real `compareRun` core with in-memory metadata.
- `styles.css` contains global class names used by JSX. There is no CSS Modules or utility CSS framework in the production renderer. Monaco is installed as a dependency but is not imported; the current SQL view is the `<pre>` in `App.tsx`.
- `apps/desktop-mock/index.html` is a layout/interaction reference only. Production behavior belongs in the TypeScript renderer; do not update the mock as a side effect of a product fix.

## Runtime Import Boundary

Renderer modules may import from `src-core` and may import bridge types from `src-main/preload.ts` with `import type`. `App.tsx`, `store.ts`, and `sql.ts` demonstrate the preload type import; `demo.ts` demonstrates the main-process `DatabaseMetadata` type import. A type-only import is erased at build time; a normal import from a Node/Electron module would pull that runtime into the browser bundle and is forbidden.

Do not import runtime code from `src-main/main.ts`, `connection.ts`, `metadata.ts`, `vault.ts`, or data-fetch execution modules in the renderer. When a shared type is declared in `src-main`, such as `DatabaseMetadata`, preserve the type-only import boundary.

## Naming

- React components and local component types use PascalCase.
- Hooks use React's `useX` form; there are currently no project-specific custom hook files.
- Helpers and store actions use camelCase. Constants and exported filter collections use uppercase names such as `VERB_CHIPS` and `OBJECT_CHIPS`.
- Non-component modules are kebab-case (`node-filter.ts`); component files use PascalCase (`App.tsx`), and tests are colocated as `<module>.test.ts`.
- CSS classes are semantic kebab-case (`diff-row`, `drop-alert`, `data-status-row`) and are defined in `styles.css`, not inline as ad hoc style objects except for a few dynamic widths/colors.
