# SqlDiff Renderer Guidelines

This directory covers the React renderer in `apps/desktop/src-renderer`. The UI is a desktop-only, three-pane Electron application; there is no router, page directory, or server-state library. No component library is currently imported: `monaco-editor` is present in the package but the renderer intentionally uses a highlighted `<pre>` instead.

## Guidelines

| Guide | Use it for | Status |
|---|---|---|
| [Directory Structure](./directory-structure.md) | Renderer entry point, component/helper placement, runtime imports | Current |
| [Component Guidelines](./component-guidelines.md) | Local components, props, rendering, styles, accessibility baseline | Current |
| [Hook Guidelines](./hook-guidelines.md) | Current hook usage, effects, memoization, and the absence of custom hooks | Current |
| [State Management](./state-management.md) | Zustand state, local state, derived data, IPC refreshes | Current |
| [Type Safety](./type-safety.md) | Strict TypeScript, shared contracts, runtime guards and assertions | Current |
| [Quality Guidelines](./quality-guidelines.md) | Tests, UI invariants, trusted-input CDP E2E, review checks | Current |

## Pre-Development Checklist

- Keep renderer code browser-safe. It may use the typed `window.sqldiff` bridge, but must not import `node:*`, `electron`, `mysql2`, or `ssh2`; compare `src-renderer/sql.ts` with the Node-only modules in `src-main`.
- Decide whether a value is cross-component domain state, component-local UI state, or derived data. Follow the split in `src-renderer/store.ts` and `App.tsx` rather than putting everything in Zustand.
- Use one final filtered item list for the diff table, visible count, and unselected bulk copy/export. `App` passes the same `tabItems` to `DiffTable` and `SqlPreview`; selecting a row intentionally narrows `SqlPreview` to that item. Tab/chip counts intentionally use their documented upstream filter stages so toggles remain reversible.
- For an IPC change, update `src-main/preload.ts`, `src-core/types.ts` when the domain contract changes, the main handler, and renderer callers together.
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
- SQL rendered with `dangerouslySetInnerHTML` comes only from `highlightSql`, which escapes text first;
- native controls, labels, disabled states, and existing ARIA roles were not regressed;
- exercise interactive behavior that unit tests cannot cover with trusted CDP input.
