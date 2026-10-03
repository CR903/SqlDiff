# SqlDiff Renderer Guidelines

This directory covers the React renderer in `apps/desktop/src-renderer`. The UI is a desktop-only, three-pane Electron application; there is no router, page directory, or server-state library. No component library is currently imported: `monaco-editor` is present in the package but the renderer intentionally uses a highlighted `<pre>` instead.

## Guidelines

| Guide | Use it for | Status |
|---|---|---|
| [Directory Structure](./directory-structure.md) | Renderer entry point, component/helper placement, runtime imports | Current |
| [Component Guidelines](./component-guidelines.md) | Local components, props, rendering, styles, accessibility baseline | Current |
| [Hook Guidelines](./hook-guidelines.md) | Current hook usage, effects, memoization, and the absence of custom hooks | Current |
| [State Management](./state-management.md) | Zustand state, local state, derived data, IPC refreshes | Current |
| [Type Safety](./type-safety.md) | Strict TypeScript, shared contracts, result source and coverage contract, runtime guards and assertions | Current |
| [Quality Guidelines](./quality-guidelines.md) | Tests, UI invariants, trusted-input CDP E2E, review checks | Current |

## Pre-Development Checklist

- Keep renderer code browser-safe. It may use the typed `window.sqldiff` bridge, but must not import `node:*`, `electron`, `mysql2`, or `ssh2`; compare `src-renderer/sql.ts` with the Node-only modules in `src-main`.
- Decide whether a value is cross-component domain state, component-local UI state, or derived data. Follow the split in `src-renderer/store.ts` and `App.tsx` rather than putting everything in Zustand.
- Use one final filtered item list for the diff table, visible count, and unselected bulk copy/export. `App` passes the same `tabItems` to `DiffTable` and `SqlPreview`; selecting a row intentionally narrows `SqlPreview` to that item. Tab/chip counts intentionally use their documented upstream filter stages so toggles remain reversible.
- Aspect filtering is scoped to the change tab (`DROP`/`CHANGE` sub-tabs). Keep the counting base, tab-switch pruning, and selected-but-disabled rules in [State Management](./state-management.md#aspect-sub-tabs-are-scoped-to-the-change-tab).
- For an IPC change, update `src-main/preload.ts`, `src-core/types.ts` when the domain contract changes, the main handler, and renderer callers together.
- For `CompareResult` producers and consumers, follow the [Result Source and Coverage Contract](./type-safety.md#result-source-and-coverage-contract): every producer sets `source`, and both coverage gaps and a silently narrowed comparison scope must stay visible instead of being read as "no difference" or "fully checked".
- For DBeaver export, follow [DBeaver Export Contract](../backend/dbeaver-export.md): the selection modal owns local selection, the store owns IPC, and the download must stay topology-only.
- For DataGrip export, follow [DataGrip Export Contract](../backend/datagrip-export.md): the `ExportModal` is shared across both targets via the `target` prop, multi-file exports go through `saveTextFiles` (`kind: 'bundle'`), and the three XML files must stay deterministic and secret-free.
- For export E2E, follow [E2E Harness](../backend/e2e-harness.md): the harness launches a real Electron instance with pre-populated `nodes.json`, uses `SQLDIFF_E2E_SAVE_DIR` env injection for save-dialog bypass, and requires both API-depth and UI-click tests.
- Add a pure Vitest regression for filters/SQL helpers. For clicks, dialogs, clipboard, downloads, or real data flow, plan the CDP procedure in [Quality Guidelines](./quality-guidelines.md#cdp-end-to-end-checks).

## Quality Check

Run from `apps/desktop`:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Then review that:

- visible rows and the current visible count come from the final `tabItems`; unselected bulk copy/export and risk text use that list, while a selected row intentionally narrows `SqlPreview` copy/export/risk to one item; tab/chip counts keep their explicit upstream bases;
- effects remove listeners, timers, and progress subscriptions;
- real secrets are transient form state only and never enter local storage or exported plaintext;
- grant text never reaches the renderer: only object names and `full`/`partial` verdicts cross `SHOW GRANTS FOR CURRENT_USER()`;
- SQL rendered with `dangerouslySetInnerHTML` comes only from `highlightSql`, which escapes text first;
- native controls, labels, disabled states, and existing ARIA roles were not regressed;
- exercise interactive behavior that unit tests cannot cover with trusted CDP input.
