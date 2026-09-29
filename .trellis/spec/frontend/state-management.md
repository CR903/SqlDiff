# State Management

## Store Boundary

`src-renderer/store.ts` creates one Zustand store, `useDesktopStore`, with a private `DesktopState` interface. It owns domain state shared across the three panes and the async actions that talk through `SqlDiffApi`.

| State category | Current location and examples |
|---|---|
| Durable main-process data | `nodes`, `history`, refreshed by `refreshNodes` and `refreshHistory` |
| Cross-component workflow | `slotA`, `slotB`, `scopes`, `tableFilter`, `includeData`, `dataPairs`, `dataStatus`, comparison options |
| Result and view state | `items`, `selectedId`, `diffFilter`, object/aspect/verb filters, `comparing`, progress, toast |
| Renderer-only UI state | `nodeModal`, `dbeaverExportOpen`, `testingId`, and per-card latency live in `App`; form strings live in `NodeModal`; DBeaver selected ids live in `DBeaverExportModal`; add-row table drafts live in `DataSection`, while saved pair selections live in the store |
| Result-integrity state | `resultSource`, `coverage`, `visibility`, `resultError` — they describe the cross-pane result, so they live in the store; the expandable detail tables' open/closed state is `App`-local `coverageOpen` / `visibilityOpen` |
| Derived state | `visibleNodes(...)`, App's `byKw/byObj/byAspect/tabItems`, counts, selected SQL, and highlighted HTML |

Do not promote modal fields, input drafts, or memo results into Zustand. Promote a value only when multiple regions need the same workflow state or it must survive component replacement.

Node visibility is computed by `visibleNodes`, not stored twice. The `fav` tab includes a pinned node or any node with `useCount > 0`, then sorts by use count; do not reintroduce a minimum-frequency threshold that hides newly used nodes. The `all` tab must show a new node immediately.

## Update Patterns

- Use granular selectors. `App` subscribes to individual fields/actions rather than destructuring the entire store, limiting unrelated renders.
- Use functional `set` updates when the next value depends on prior state: slot assignment, filters, pair edits, star state, and node maps in `store.ts`.
- Keep filter arrays canonical. `toggleObjectType`, `toggleAspect`, and `toggleVerb` use `'ALL'` for an empty or full selection, otherwise arrays. The object/aspect/verb/diff filter setters and toggles clear `selectedId`; the current `setTableFilter` and `toggleScope` actions do not, and `SqlPreview` falls back if a selected id is no longer in `tabItems`.
- Reset result-dependent state together. A successful or demo comparison replaces `items`, `dataStatus`, `selectedId`, `diffFilter`, and `verbFilter`; successful compare also resets threshold confirmation.
- Star and use-count updates are optimistic, then persisted best-effort through `nodes.update`. CRUD methods update the local list only after the IPC call succeeds.

## Server/Main-Process State

There is no cache library. Refresh behavior is explicit:

- `refreshNodes` is the startup/refresh action; it applies a non-empty IPC node list, while an empty result or IPC failure leaves the current/seed nodes visible;
- `refreshHistory` replaces history with the IPC list;
- `refreshDataTables` loads A/B names and creates same-name pairs;
- `runCompare` owns request state, progress subscription, result replacement, and history refresh;
- `cancelCompare` sends the main-process abort request.

The last A/B selection is the only renderer persistence: `readLastCombo` / `writeLastCombo` use the `sqldiff.lastCombo` localStorage key with try/catch. Secrets, nodes, history, and diff results are not stored in localStorage.

## Filter and Copy Invariant

The renderer filter chain is keyword -> object -> aspect -> change tab plus verb, with OR inside multi-select groups and AND across groups. `postFilterResult` in `src-core/compare-filter.ts` is the shared semantic reference. `App` feeds the final `tabItems` to the table, `visibleCount`, selection lookup, and unselected bulk copy/export. If `selectedId` resolves inside `tabItems`, `SqlPreview` intentionally shows, copies, and exports only that one item; `visibleCount` remains `tabItems.length`. Change-tab and chip counters intentionally use an earlier stage (`byAspect`) so selecting a tab or verb does not hide the other choices.

Do not calculate a separate unselected copy/export list from unfiltered `items`, and do not update one counter without the same filter base used by the visible rows.

## Preview and Failure State

The seed nodes in `store.ts` and `runDemoCompare` in `demo.ts` support `npm run dev` without Electron.

`runCompare` splits its `catch` in two, and `isNoIpc` is the dividing line rather than a toast-wording branch:

- **Development / demo state** (`no-ipc`, no Electron backend): demo results are still filled in. `resultSource` becomes `'demo'` and the status bar is prefixed with `本地示例 ·`.
- **Real comparison failure** (bad credentials, connectivity, permissions, backend error): no demo fallback. `items` and `dataStatus` are cleared and `resultError` holds the `sanitizeIpcError` output; `App` renders an explicit error card in place of the diff list and points the user back at the A / B node configuration. Showing a well-formed example diff after a failed connection was the defect this replaced.

`resultSource`, `coverage`, and `visibility` live in Zustand because they describe the cross-pane result; the coverage detail table's expanded/collapsed state is `App`-local, per the renderer-only split above. The source marker, the coverage counter, and the comparison-scope notice are permanent footer text — none depends on the 2.2s toast. When `coverage.skipped` is empty, no coverage affordance renders at all.

The comparison-scope notice follows the same permanent-footer rule, with one deliberate exception to "show nothing when the count is zero": `visibility` renders when `excluded.length > 0` **or** `reliable === false`. A `reliable: false` result must not stay silent even when nothing was excluded, because silence would imply the account's coverage was proven complete, which is exactly what could not be established. The wording changes with the flag — `reliable === false` uses the stronger 「授权范围无法确认，已按最保守范围比较」 — and the detail card leads with the number of objects actually compared. When `excluded` is empty and `reliable` is true, no affordance renders. The human intervention point is configuring the account once, not reviewing each diff; do not turn this into a per-item warning.

Changes to fallback labeling or behavior still require an explicit product decision and UI regression coverage; the demo-fallback misread recorded in the archived E2E report is resolved in behavior (no fallback on real failure) but only covered here by unit tests for the source marker. Interactive verification of the error card, the footer counter, and the expandable detail table belongs to the CDP pass.
