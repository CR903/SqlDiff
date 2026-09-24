# Implement — DBeaver Export

## Checklist

### A. Pure exporter
- [x] A1 Add typed DBeaver document/result types and `buildDBeaverDocument` under `src-main/converters/`.
- [x] A2 Map MySQL MANUAL connection fields, stable connection ids, username, and documented SSH handler; keep secrets and key paths out.
- [x] A3 Add focused builder tests for direct, password SSH, private-key SSH, multiple nodes, empty/invalid input, deterministic output, and no-secret assertions.

### B. IPC and store
- [x] B1 Add `nodes.exportDbeaver(ids)` to the preload contract and implement the main handler with node lookup/validation.
- [x] B2 Add the Zustand action and sanitized error handling without changing existing custom JSON export/import.
- [x] B3 Add a JSON Blob download helper while preserving the existing trusted download path.

### C. Renderer UX
- [x] C1 Add a left-library DBeaver export entry and local selection modal.
- [x] C2 Add per-node selection, all/none, selected count, cancel, and explicit no-secret warning.
- [x] C3 Wire export success to the returned filename/content and surface warnings without writing secrets.

### D. Verification
- [x] D1 Run typecheck, lint, test, and build.
- [x] D2 Run trusted CDP regression for selection, download, JSON structure, and no-secret output.
- [x] D3 Verify `mysqldiff/` has no task-authored changes and record the accepted DBeaver environment limitation in `dbeaver-report.md`.

## Validation

From `apps/desktop`:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Focused converter test:

```bash
npm test -- src-main/converters/dbeaver.test.ts
```

CDP must use `Input.dispatchMouseEvent` and `will-download` evidence; `el.click()` alone is not proof of a saved file.

## Rollback Points

- A: pure module and tests; no existing path changes.
- B: additive preload/main/store contracts; remove together if the IPC shape changes.
- C: additive modal/button; existing export button remains the rollback path.
- D: evidence and report only; do not keep downloaded connection files in the repository.
