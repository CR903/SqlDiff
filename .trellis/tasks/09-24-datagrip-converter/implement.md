# Implementation Plan — DataGrip Export

Order the checklist so each item is independently reviewable. Run the full gate after each stage boundary, not after every file.

## Stage 0 — Baseline sanity (0 commits)

- [ ] `cd apps/desktop && npm run typecheck && npm run lint && npm test && npm run build` passes on the current branch with zero changes. Record the git SHA this plan starts from.
- [ ] Confirm `saveTextFiles` exists in `src-renderer/sql.ts` (or that `saveTextFile` is the only variant). If `saveTextFiles` doesn't yet exist, promote `saveTextFile` to `saveTextFiles(files, title)` before Stage 2; keep the single-file API as a thin wrapper for existing DBeaver callers.
- [ ] Confirm `src-core/types.ts` does not need new domain types for this task — `NodeMeta`, `SshConfig` are already sufficient. Do not add new shared types if the export result can be local to `converters/`.

## Stage 1 — Pure builder (main process, no IPC)

- [ ] Create `apps/desktop/src-main/converters/datagrip.ts` with:
  - Module-private constants: `DATAGRIP_DRIVER_REF = 'mysql.8'`, `DATAGRIP_JDBC_DRIVER = 'com.mysql.cj.jdbc.Driver'`, `DATAGRIP_WORKING_DIR = '$ProjectFileDir$'`, `DATAGRIP_SECRET_STORAGE = 'master_key'`, component names, and the `authType` mapping.
  - Typed interfaces `DatagripSshAuthType`, `DatagripExportResult`, `DatagripFile { fileName, content }`.
  - Pure helpers: `assertExportNode(value, index)` mirroring `dbeaver.ts` shape validation; `resolveDatagripNodes(nodes, ids)` mirroring the DBeaver id-resolution with `datagrip:` / `nodes:` prefix wording; `buildDatagripDocuments(nodes)` producing `{dataSourcesXml, dataSourcesLocalXml, sshConfigsXml?, warnings}`; `createDatagripExportResult(nodes)` assembling the final `files[]`.
  - A local v5-UUID helper keyed on a namespace string and the input node id. Verify it produces the same UUID for the same input across runs (deterministic).
  - XML escaping helper for attribute and text content.
- [ ] Do not touch `src-core/types.ts`, `src-main/main.ts`, `src-main/preload.ts`, or renderer files yet. This stage is pure and unit-testable in isolation.
- [ ] Create `apps/desktop/src-main/converters/datagrip.test.ts` covering every case listed in `design.md §Tests`. Include an "escaped attribute" case with `alias = 'prod & staging'` and a "collapsed SSH" case where two nodes share a jump host.
- [ ] Run `npx vitest run src-main/converters/datagrip.test.ts` and confirm all cases green before proceeding.

## Stage 2 — IPC plumbing

- [ ] Add `nodes.exportDatagrip(ids: string[]): Promise<DatagripExportResult>` to `SqlDiffApi` in `src-main/preload.ts`. Export the `DatagripExportResult` type from `src-main/converters/datagrip.ts` and re-export from `preload.ts` beside the DBeaver equivalent.
- [ ] Register a `nodes.export-datagrip` handler in `src-main/main.ts` alongside the existing `nodes.export-dbeaver`. Keep the handler thin: `resolveDatagripNodes(loadNodes(userDataDir), ids)` then `createDatagripExportResult(selected)`. No Vault access.
- [ ] Add a store action in `src-renderer/store.ts` mirroring `exportDbeaver`. Same error sanitization.
- [ ] Extend `src-renderer/sql.ts` with `saveTextFiles(files, title)` if not already present. Delegate to `SqlDiffApi.file.save({ kind: 'bundle', files })`. Update the DBeaver call site to route through it (backward-compatible — behavior stays one-file-per-call).
- [ ] Do not add renderer logic yet — this stage is IPC only.

## Stage 3 — UI

- [ ] Extend `DBeaverExportModal` to accept `target: 'dbeaver' | 'datagrip'` (Option A in `design.md`). If the modal grows past a comfortable size, split the shell into a shared `ExportModal` with a per-target child; but avoid a full refactor if not needed.
- [ ] Wire a "DataGrip" entry in the NodeLibrary export menu next to the existing "DBeaver" entry.
- [ ] The modal body:
  - Checkbox list of currently-loaded nodes; per-node checkbox; select-all / select-none; selected count.
  - Warning banner (before export click): "导出不会迁移密码、私钥或 passphrase；导入后需在 DataGrip 中重新输入。"
  - Per-node row warning for SSH private-key nodes: "SSH 私钥需在 DataGrip 中重新选择。"
  - Cancel + Export buttons.
- [ ] On export click: call `store.exportDatagrip(ids)` → on success call `saveTextFiles(result.files, '导出 DataGrip')` → success toast reports directory and count; warnings displayed as `已导出 3 个 XML 到 <dir>；2 个 SSH 私钥需重新选择` (or per-node, whichever fits).
- [ ] Error path uses `sanitizeIpcError`; do not change the DBeaver error behavior.

## Stage 4 — CDP / regression

- [ ] Extend the DBeaver CDP harness to include a DataGrip pass: open NodeLibrary → click DataGrip export → toggle all/none → trusted `Input.dispatchMouseEvent` on Export → accept native save dialog → verify the returned directory contains `dataSources.xml`, `dataSources.local.xml`, and `sshConfigs.xml` (last one only if any selected node had SSH enabled) → parse each with a small XML parser or regex check → assert UUIDs match across files and no forbidden key names appear in the content.
- [ ] Persist only the report and non-sensitive evidence; scrub any alias/host values that leaked into screenshots.
- [ ] Full gate from `apps/desktop`: `npm run typecheck && npm run lint && npm test && npm run build`.

## Stage 5 — Spec, docs, close-out

- [ ] Create `.trellis/spec/backend/datagrip-export.md` mirroring the shape of `.trellis/spec/backend/dbeaver-export.md`: scope/trigger, signatures, contracts, validation matrix, good/base/bad cases, tests required, wrong vs correct. Do not restate `design.md`; this is the durable contract.
- [ ] Add `Datagrip Export Contract` row to `.trellis/spec/backend/index.md` guidelines table.
- [ ] Add a "For DataGrip export" bullet to `.trellis/spec/frontend/index.md` Pre-Development Checklist pointing at the new contract.
- [ ] Update `task.json` via `task.py archive` after Stage 4 gate is green and Stage 5 specs are committed. Do not commit until after `task.py start` has been approved by the main agent.
- [ ] Record a short "why not real IDE smoke test" note in the task journal — mirrors `09-22-converters` AC6 rationale — and links the deferred IDE smoke test as a follow-up item.

## Review gates

- **Gate A (after Stage 1)**: pure builder + tests only. Review the XML shape against research Addendum 2026-10-03; the constant set must match.
- **Gate B (after Stage 2)**: IPC only. Verify no `Vault` / `SecretBundle` reference appears anywhere in the new path.
- **Gate C (after Stage 3)**: full UI path, no CDP yet. Manually click through a local dev build if time permits; otherwise defer to Stage 4 CDP.
- **Gate D (after Stage 4)**: full gate green, CDP pass green. Proceed to Stage 5 or roll back from here.

## Rollback points

- If any single file is wrong: `git checkout -- <path>`.
- If Stage 3 UI direction is wrong (Option A feels cramped): revert the modal change and re-cut with Option B. Keep the IPC contract stable across attempts.
- If Stage 4 reveals a real-world IDE shape mismatch (e.g. target DataGrip version rejects an attribute): do **not** edit the emitted XML inline. Update constants and rerun the gate; if the fix requires a new required field, escalate back to Stage 0 to update the research file.

## Acceptance mapping

- AC1 (well-formed XML + UUID consistency) — Stage 1 tests + Stage 4 CDP.
- AC2 (3 nodes × 3 shapes + field mapping) — Stage 1 tests.
- AC3 (SSH mapping, no `keyPath`) — Stage 1 tests + Stage 3 modal warning.
- AC4 (no secrets anywhere) — Stage 1 sentinel-pollution test + Stage 4 content assertion.
- AC5 (modal UX, multi-file save) — Stage 3 + Stage 4 CDP.
- AC6 (gates green, CDP green, deferred IDE smoke test) — Stage 4 + Stage 5 journal note.

## Notes for implementers

- Follow the `dbeaver.ts` code shape; do not introduce a second XML-serialization style in this task.
- The v5 UUID helper must be deterministic. Test it twice against the same input.
- The XML serializer must produce **byte-stable** output for identical input — no random indentation or attribute reorder. Pin attribute order in tests by string comparison.
- Do not add new runtime dependencies. If a v5 implementation pulls in a package, replace with a 20-line local helper.
- Warnings and error messages are user-facing Chinese; keep them consistent with the existing `dbeaver:` / `nodes:` wording.
- When emitting the collapsed `<sshConfig>` count warning, use the same "re-select key" wording so users don't have to re-read two different messages.
