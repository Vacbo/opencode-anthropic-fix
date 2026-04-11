# Decisions — Quality Refactor

## Architecture

- index.ts decomposition: extract to refresh-helpers.ts and plugin-helpers.ts
- Use factory functions with closure capture (same pattern as today)
- LOC targets are guidelines, not gates — quality over arbitrary line counts

## Strategy

- Phase A (behavior fixes) before Phase B (quality refactor)
- Tests-after strategy (not TDD) — fix code first
- ESLint: no-explicit-any as warn, no-console as warn, consistent-type-imports as warn, unused-vars as error

## Task 6 Decisions (2026-04-10)

- Use `createRefreshHelpers()` as a closure factory, not a class or shared module state
- Pass `getAccountManager()` into the factory instead of the manager instance so helper logic always sees the latest reloaded manager
- Keep `parseRefreshFailure` in the factory return even though it is only consumed by index.ts today; this preserves the extracted helper surface cleanly

## 2026-04-10 12:18:42

- F1 rerun approved: previous /tmp-gating rejection was incorrect; current must-have checks pass and follow-up commit 82eaf0f resolves the disputed catch findings.
