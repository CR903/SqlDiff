# Component Guidelines

## Current Component Pattern

Components are local function components in `src-renderer/App.tsx`; there is no `React.FC`, component class, or imported component library. `monaco-editor` is installed but intentionally not imported: the current SQL view is a highlighted `<pre>`. `App` is the composition root. Most child components are presentation components that receive values and callbacks through props. `NodeModal` and `DBeaverExportModal` are workflow-owning exceptions: the former selects `saveNode` and `testDraft` for its form workflow, while the latter selects `exportDbeaver` for its selection/export workflow.

The three primary regions are stable product concepts:

- `NodeLibrary` / `NodeCard` / `HistoryRow` own the left node/history browser;
- `CompareSlots`, `DataSection`, and `DiffTable` own comparison controls and results in the center;
- `SqlPreview` owns selected/current-tab SQL presentation, copy, export, risk, and rollback text.

## Props and Data Flow

- Type component props inline next to the component, as in `NodeLibrary`, `DiffTable`, and `SqlPreview`. Use explicit callback prop names (`onPick`, `onRun`, `onToggleObj`) and domain types from `src-core/types.ts`.
- Pass already-filtered rows into presentational components. `App` computes `tabItems` and gives that exact array to both `DiffTable.rows` and `SqlPreview.tabItems`; do not repeat the filter chain inside either component.
- Keep selection keyed by `DiffItem.id`. The diff/object/aspect/verb filter setters and a completed compare clear `selectedId`; the current `setTableFilter` and `toggleScope` actions do not, so `SqlPreview` falls back to the current tab when a selected id is no longer visible.
- `NodeCard` demonstrates nested-action handling: star/test/edit/delete buttons call `stopPropagation()` so the card's own pick handler does not also fire. Preserve that separation when adding card actions.
- For drag/drop, `Slot` calls `preventDefault()` on dragover and carries the node id as `text/plain`, matching `NodeCard.onDragStart`.

## State and Derived Rendering

- Keep transient input state local: `NodeModal` owns its form strings and test/save flags; `DBeaverExportModal` owns selected ids plus exporting/error state; `DataSection` owns the add-row A/B draft selects while existing pair selections remain in the store; `DataOptionsInputs` owns string drafts and syncs normalized numeric values from props.
- Use `useMemo` for expensive or identity-sensitive derivations. `App` builds the keyword/object/aspect/verb chain in separate memo stages so counts have a clear base. `SqlPreview` memoizes export text and highlighted HTML.
- Do not store `tabItems`, SQL preview HTML, or filter counts back into Zustand. They are derived from `items` and filter state in `App`.

## Rendering and Styling

- Production styles live in `src-renderer/styles.css`; JSX uses semantic classes and follows the dark three-pane layout. Preserve the fixed desktop proportions unless a task explicitly redesigns the app.
- The SQL view is currently a highlighted `<pre>`, not Monaco. `highlightSql` escapes `&`, `<`, and `>`, then reserves comments, quoted strings, and backtick identifiers before keyword/number highlighting; this prevents nested or false keyword spans. `SqlPreview` is the only production `dangerouslySetInnerHTML` use. Never inject raw database text or error text as HTML.
- `formatSqlSafe` falls back to the original text when formatting fails. Preserve non-blocking formatting and highlighting behavior.
- Empty/loading/error states are explicit in the relevant component. Examples are `NodeLibrary`'s empty list, `DiffTable`'s empty rows, `DataSection`'s mapping state, and `SqlPreview`'s no-SQL state.

## Accessibility Baseline

The current code uses native `<button>`, `<input>`, `<select>`, `<textarea>`, and `<label>` elements, disables actions while busy, and gives the progress bar and modal basic ARIA metadata (`CompareSlots`, `NodeModal`, and `DBeaverExportModal`). Preserve these semantics and visible labels when changing markup.

Accessibility is not fully solved: clickable `NodeCard`/`Slot` containers and diff table rows are not keyboard-operable, tabs/chips do not expose pressed state, and `NodeModal` is not focus-trapped. There is no accessibility lint or automated a11y suite. Treat these as known gaps rather than claiming WCAG conformance; changes that touch an interactive element should not make keyboard or label behavior worse and should include a manual/CDP check.

## Avoid

- adding a second filtering or counting path in a child component;
- using `el.click()`-style synthetic behavior as proof that download/clipboard/confirm flows work;
- storing modal field state globally;
- introducing a new editor/component dependency, a CSS framework, or a component directory without a product requirement (the existing Monaco dependency is intentionally unused);
- copying structure from `apps/desktop-mock/index.html` into production while ignoring current business rules.
