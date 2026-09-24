# Diagnostics and Logging Guidelines

## Current State

The product has no application logging framework, log file, severity configuration, or structured logger. Do not describe `console.*`, thrown IPC errors, or UI toasts as an established logging system.

Current diagnostic channels are:

- typed connection results and per-table statuses (`ConnTestResult`, `DataTableStatus`);
- rejected IPC promises with domain-prefixed messages, cleaned by `sanitizeIpcError`;
- the renderer's toast, form error, status bar, and SQL risk/rollback text;
- test output and task evidence such as `.trellis/tasks/archive/2026-09/09-24-e2e-icon-release/e2e-report.md`;
- command output from the icon generator, which uses `[generate-icon]` on stdout/stderr and exits non-zero on failure in `scripts/generate-icon.mjs`.

There are no debug/info/warn/error application levels to follow. Adding persistent runtime logging is an architecture change that requires an explicit decision, a redaction policy, and a later spec update.

## Rules for Diagnostics

- Keep messages actionable and domain-prefixed. Existing examples include `vault:`, `compare:`, and `data-compare:`; see `src-main/vault.ts`, `src-main/compare-run.ts`, and `src-main/data-run.ts`.
- Prefer a typed result/status when the UI is expected to continue. Use `ConnTestResult` for connection tests and `DataTableStatus` for per-table progress/failure instead of logging and returning an indistinguishable empty result.
- Treat generated SQL, row values, connection metadata, and DDL as potentially sensitive. The current code does not write them to a runtime log; keep that property.
- Put test findings and CDP evidence in the active task directory, not in product source or an ad hoc log file. The archived E2E report records assertions, environment limits, and evidence paths.

## Never Log or Persist

- database or SSH passwords, private keys, passphrases, `SecretBundle` objects, safeStorage ciphertext, master-key bytes, or decrypted export content;
- raw legacy connection strings, which contain passwords;
- full row data or generated DML by default;
- encryption buffers or complete exported documents.

`nodes.json` and `history.json` contain metadata only. Secret files and encrypted export fields are governed by `Vault`; application diagnostics must not bypass that boundary.

If a future change needs a logger, first define retention, file location, severity mapping, redaction, and how renderer-safe messages differ from internal diagnostics. Until then, do not add scattered `console.log` calls as a substitute.
