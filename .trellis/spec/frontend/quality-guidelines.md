# Renderer Quality Guidelines

## Quality Gate and Test Layers

Run from `apps/desktop`:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

The project has Vitest but no React Testing Library, jsdom suite, snapshot framework, or accessibility automation. Renderer tests therefore focus on deterministic pure helpers:

- `src-renderer/node-filter.test.ts` covers left-tab and keyword behavior;
- `src-renderer/sql.test.ts` covers highlighter span behavior and export ordering (the current suite has no raw HTML-metacharacter case);
- `src-renderer/demo-source.test.ts` and `store-source-split.test.ts` cover the source marker, the "silent when nothing was skipped/limited" conditions, and the `visibility` state transitions;
- shared filter behavior is covered in `src-core/verb-search.test.ts` and `src-core/ddl-dml-index.test.ts`;
- grant-shape parsing is covered in `src-core/visibility.test.ts` and the narrowing plus the false-`DROP` regression in `src-main/compare-run-visibility.test.ts`. Keep the "before narrowing" control case: it is what proves the regression test can still fail.

Add a focused renderer test for filter, formatting, storage parsing, or state-independent helper changes. Do not add a shallow snapshot that merely repeats JSX structure.

## UI Correctness

- Keep the final `tabItems` array as the source for `DiffTable`, `visibleCount`, and unselected bulk copy/export. If a row is selected, `SqlPreview` intentionally narrows the current preview, copy, export, risk, and rollback to that item. Change-tab and chip counts intentionally use the upstream `byAspect` stage so filters remain reversible. `App` and `SqlPreview` are the reference implementations.
- Preserve the shared filter semantics in `src-core/compare-filter.ts`: OR within a multi-select group, AND across groups, empty/full selections treated as ALL, and table/data keyword filtering without excluding views or routines.
- Keep real and demo results distinguishable: `runCompare` only falls back to demo results in the `no-ipc` development state, and marks them `source: 'demo'` so the status bar carries a permanent `本地示例 ·` prefix. A real comparison failure clears `items` and renders the sanitized reason in an explicit error card instead of an example diff. Structural coverage gaps are permanent footer text too: a `N 个对象未检查` counter plus an expandable object/type/reason table, both absent when nothing was skipped.
- Keep the comparison scope equally explicit. Grant blindness produces a `visibility` report, and the footer must show either `N 个对象因授权未参与比较` (with an expandable object/type/side table) or, when `reliable === false`, the stronger 「授权范围无法确认，已按最保守范围比较」. Both are permanent footer text, both reuse the coverage card's `coverage-card` / `st-skipped` row styles rather than a new panel, and both are fully absent when `excluded` is empty and the assessment is reliable. A silently narrowed comparison is a defect: users must never be unable to tell that an object was excluded from the diff.
- Verify the interactive parts of that surface with CDP rather than snapshots: a real-failure error card, the coverage counter appearing only when `skipped` is non-empty, the scope notice appearing only when `excluded` is non-empty or the assessment is unreliable, the `reliable === false` wording override, and expanding and collapsing both detail tables. As of 2026-09-30 the error card, both counters, and both expandable detail tables are covered by the headless CDP run recorded in `09-29-grant-blindness-false-drop/cdp-report.md` (real connection failure, coverage of `permission-denied` views, and a `grant-invisible` excluded object all verified through real UI interaction). The `reliable === false` wording override remains unverified because it requires forcing `SHOW GRANTS` to fail; exercise it before changing that path.
- Keep real secrets transient. `NodeModal` may hold form values while editing and send them to `conn.test` / node save, but they must not enter Zustand persistence, localStorage, logs, or task artifacts.
- `highlightSql` must continue to escape text before adding markup. When changing it, test `<`, SQL keywords inside quotes, and comments; the current `sql.test.ts` covers the quote/comment cases and still needs a raw `<` regression if that boundary changes.

## Styling and Desktop Constraints

- Production classes belong in `src-renderer/styles.css`; follow the existing dark palette and semantic class names. Avoid introducing a second styling system.
- The app targets a desktop window with a minimum size in `createWindow`; the three-column grid is intentional. Mobile responsiveness is not a current release criterion.
- Preserve busy/disabled states for compare, node testing, saving, and table-list loading. Progress must remain visible during comparison.

## Accessibility Reality

Native controls, wrapping labels, disabled buttons, `role="progressbar"`, and the modal's `role="dialog"` are the current baseline. There is no automated a11y gate. Known gaps include clickable cards/slots/table rows without keyboard handlers, no `aria-pressed` state on tabs/chips, and no modal focus trap. Do not claim accessibility coverage that the code does not provide; when changing these areas, include keyboard/focus checks in the manual or CDP pass.

## CDP End-to-End Checks

Use CDP for behavior that jsdom or `el.click()` cannot validate:

1. Run `npm run build`, then start Electron with `npm start -- --remote-debugging-port=<port>`.
2. Connect to the renderer target over the DevTools WebSocket. Use `Runtime.evaluate` to inspect state and locate elements.
3. Use `Input.dispatchMouseEvent` / keyboard input for trusted gestures. Blob downloads, clipboard writes, and `window.confirm` do not provide reliable evidence when driven only by `el.click()`.
4. Use `Page.handleJavaScriptDialog` for confirmation, and verify clipboard text or the saved file outside the DOM.
5. Use `Page.captureScreenshot` for evidence and keep the harness in a temporary directory.

This is the proven method recorded in `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/design.md` and `e2e-report.md`. Keep the CDP harness in a temporary directory; persist only the report and intended evidence artifacts in the task directory.

Minimum scenarios for affected flows:

- node CRUD, validation, and secret cleanup;
- filters where the unselected bulk path uses the current visible count/list, while a selected row intentionally narrows copy/export to one item; tab/chip counts keep their upstream bases;
- DROP confirmation, clipboard, and zero-item behavior;
- Blob export and `will-download` file existence/content;
- real read-only compare with a Docker MySQL fixture when the target database is unavailable; keep credentials out of task files and pass `--default-character-set=utf8mb4` when seeding Chinese data through the MySQL CLI;
- Cmd/Ctrl+Enter, swap/clear, and search smoke checks;
- DBeaver export: node selection, all/none, warning visibility, JSON download, and no-secret inspection per the [DBeaver Export Contract](../backend/dbeaver-export.md).
- Review-manifest export: after a real comparison, the `导出审查报告` button downloads both JSON and Markdown via trusted clicks; inspect the saved files for valid JSON, parseable schema version, redacted DML values, and absence of secret field names, per the [Review Manifest Export Contract](../backend/manifest-export.md). The demo path must not expose the button.

Record executed assertions, screenshots, environment limits, and any waived checks in the active task report. Do not turn a Docker fixture result into a claim about an unavailable private database, and do not claim Windows native validation from a macOS cross-build.

## Review Checklist

- The diff stays inside `src-renderer`, shared `src-core`, or the required bridge; it introduces no Node import in the browser bundle.
- Components use typed props and existing CSS classes; no business behavior was copied from the mock.
- Shared state, local state, and derived state remain in their established locations.
- Pure logic has a Vitest regression; interactive behavior has trusted CDP evidence when applicable.
- The visible item set is the source for unselected bulk copy/export, selected-row copy/export is intentionally narrowed, errors are sanitized, and secrets remain out of persistent state.
- Full typecheck, lint, test, and build pass.
