# Learnings — Quality Refactor

## Conventions

- debugLog pattern: `function debugLog(...args: unknown[]) { if (!config.debug) return; console.error("[opencode-anthropic-auth]", ...args); }` (index.ts:134-137)
- bun-proxy.ts runs as SEPARATE Bun subprocess — no access to plugin config, uses env var OPENCODE_ANTHROPIC_DEBUG
- Factory pattern for decomposition: closure capture, NOT PluginContext class
- cache_control stripping in normalize.ts is INTENTIONAL — do NOT fix
- refresh-lock.ts error handling is CORRECT — do NOT modify

## Key Patterns

- vitest for tests, ~15 test files
- eslint flat config (eslint.config.ts)
- esbuild for bundling (scripts/build.ts)
- Produces 3 dist artifacts: bun-proxy.mjs, CLI, plugin

## Task 1: Baseline Capture (2026-04-09)

### Summary

- Tests: 620 pass / 0 fail / 620 total
- Type errors (tsc): 0
- Build: PASS
- Dist artifacts: 3 present (bun-proxy.mjs, opencode-anthropic-auth-cli.mjs, opencode-anthropic-auth-plugin.js)
- index.ts lines: 890
- ESLint: 1 error, 1 warning

### LSP-Detected Type Errors (not caught by tsc --noEmit)

- index.test.ts: ~150 pre-existing type errors (expected per inherited wisdom)
- backoff.test.ts: 1 pre-existing type error (expected)
- scripts/build.ts: 3 pre-existing type errors (expected)

These are in test files and build scripts that may be excluded from the main tsconfig.

### Pre-existing Issues to Address

1. ESLint error in src/bun-fetch.ts:211 - `require()` style import forbidden
2. ESLint warning in src/storage.test.ts:1 - Unused eslint-disable directive

### Notes

- All 620 tests pass, indicating the codebase is functionally sound
- Build produces all 3 expected artifacts
- Main src/index.ts is 890 lines (within expected range)

## Task 6: Refresh Helper Extraction (2026-04-10)

### Summary

- Extracted `parseRefreshFailure`, `refreshAccountTokenSingleFlight`, `refreshIdleAccount`, and `maybeRefreshIdleAccounts` into `src/refresh-helpers.ts`
- Moved refresh closure state with them: `refreshInFlight`, `idleRefreshLastAttempt`, `idleRefreshInFlight`, and `IDLE_REFRESH_*` constants
- Preserved index.ts call-site names by destructuring the factory return inside `AnthropicAuthPlugin`
- Verification: `npx vitest run` = 620 pass / 0 fail, `npx tsc --noEmit` = 0 output, `lsp_diagnostics` clean on changed files
- LOC after move: `src/index.ts` = 766, `src/refresh-helpers.ts` = 162

### Notes

- `accountManager` cannot be passed by value into the helper factory because `reloadAccountManagerFromDisk()` and auth loader both rebind it later; use `getAccountManager()` closure access instead
- `toast` is not a real dependency of the moved refresh helpers and was left out of the factory interface to avoid dead wiring

## Task 12: Proxy Lifecycle Hardening Audit (2026-04-10)

### Summary

- `registerExitHandler()` already covers `exit`, `SIGINT`, `SIGTERM`, `SIGHUP`, and `beforeExit`, but it does not clean up the proxy on `uncaughtException` or `unhandledRejection`
- `killStaleProxy()` currently trusts the PID file blindly: no PID file age check and no `kill(pid, 0)` liveness probe before SIGTERM
- `stopBunProxy()` currently calls `proxyProcess.kill()` without explicit SIGTERM/SIGKILL escalation timing

### Notes

- Task scope is intentionally limited to `src/bun-fetch.ts`; proxy IPC, fixed port, and Bun child script stay unchanged

## Task 9: Cap Unbounded Maps/Sets (2026-04-10)

### Summary

- Commit: 7317ee8 "fix: cap unbounded state growth in maps and sets"
- Files: src/accounts.ts, src/commands/router.ts, src/plugin-helpers.ts
- Tests: 620/620 pass
- LSP: no new errors on changed files

### Caps Added

- FILE_ACCOUNT_MAP_MAX_SIZE = 1000 (router.ts) — new helper capFileAccountMap with FIFO eviction; 4 set sites switched over
- #MAX_STATS_DELTAS = 100 (accounts.ts) — forced saveToDisk flush when hit; only new entries trigger check
- DEBOUNCE_TOAST_MAP_MAX_SIZE = 50 (plugin-helpers.ts) — FIFO eviction only when inserting new key; timestamp updates to existing keys do not evict

### Notes

- pendingSlashOAuth already had TTL cleanup via pruneExpiredPendingOAuth in oauth-flow.ts — no change needed
- fileAccountMap sets live in router.ts, not index.ts (per Task 5 refactor); task spec said index.ts but reality dictated router.ts
- JSDoc required by task spec ("Each cap documented with a comment explaining the bound"); kept despite comment-detector hook
- Pre-existing LSP errors on stripAnsi regex + parseCommandArgs match loop unrelated to this task

## Task 15: ESLint Tightening (2026-04-10)

### Summary

- Added rules: `no-console=warn`, `@typescript-eslint/no-explicit-any=warn`, `@typescript-eslint/consistent-type-imports=warn`, `@typescript-eslint/no-unused-vars=error` (was warn)
- File overrides:
  - `src/cli.ts`, `src/commands/**`, `src/bun-proxy.ts` → `no-console` off (legitimate user/IPC output)
  - `**/*.test.ts`, `src/__tests__/**`, `script/**`, `scripts/**` → `no-console`, `no-explicit-any` off; `no-unused-vars` relaxed
- Baseline: 1 stale warning (unused directive in storage.test.ts)
- After tightening: 47 warnings surfaced
- After fixes: 0 problems

### Fix distribution

- Type imports: 2 files (accounts.ts → use AccountStats from storage.js; accounts.test.ts → import type ManagedAccount)
- Stale directive removal: 1 file (storage.test.ts)
- `any` at plugin API boundaries: per-line disable with reason (index.ts, cli.ts, plugin-helpers.ts, refresh-helpers.ts, bun-proxy.ts)
- `any` → `unknown`: cli.ts IoStore type (io.log/io.error handlers)
- `any` → named type: cli.ts VALID_STRATEGIES cast (`normalized as (typeof VALID_STRATEGIES)[number]`)
- `console` in src/: per-line disable with reason (bun-fetch.ts subprocess manager has no plugin logger; accounts.ts debug-gated error logs; env.ts debug system prompt logger; index.ts debugLog itself)

### Gotchas

- bun-fetch.ts runs in parent Node process and has 8 console.error calls — all debug-gated or last-resort error handlers. No access to plugin debugLog without circular import.
- bun-proxy.ts: only `no-console` disabled (runs in Bun subprocess); `no-explicit-any` still active, needs per-line disable for `any` in JSON.parse map callback.
- Removing the file-level `/* eslint-disable @typescript-eslint/no-explicit-any */` from storage.test.ts does NOT introduce TypeScript errors — those pre-existing TS errors are unrelated (vitest transpiles without strict type check).
- DO NOT parallel-fire mcp_batch + standalone mcp_edit calls on the same patterns — causes duplicate application when the batch and standalone race against the same oldString.

### Verification

- `npx eslint .` — exit 0, zero problems
- `npx vitest run` — 620/620 pass
- `npm run build` — 3 artifacts produced
- `lsp_diagnostics` clean on all modified files

## Task 16: Test Coverage for Refactored Modules (2026-04-10)

### Summary

- 5 new test files created in src/**tests**/
- 43 new tests added (663 total, up from 620 baseline)
- All existing tests still pass
- ESLint clean
- Commit: fd27f43

### Files

- src/**tests**/sanitization-regex.test.ts — `\b` word-boundary regression for `OpenCode`/`opencode`/`Sisyphus`/`morph_edit`
- src/**tests**/billing-edge-cases.test.ts — `cc_entrypoint` nullish coalescing (`??` not `||`) and short-message guards
- src/**tests**/state-bounds.test.ts — `capFileAccountMap` FIFO eviction at 1000 + `pruneExpiredPendingOAuth` TTL cleanup at 10 min
- src/**tests**/decomposition-smoke.test.ts — `createRefreshHelpers`/`createPluginHelpers` factory smoke tests using `DEFAULT_CONFIG`
- src/**tests**/debug-gating.test.ts — source-code grep tests for bun-fetch/bun-proxy debug gating, error handlers, AbortSignal.timeout, and silent-catch removal

### Notes

- The template's sanitization test wrongly assumed lowercase `opencode` → `Claude Code`. The actual regex maps lowercase `opencode` → `Claude` (only PascalCase `OpenCode` → `Claude Code`). Tests adjusted to match real behavior.
- Source-code grep approach for bun-fetch/bun-proxy avoids brittle subprocess mocking — verifies plumbing structure (env var threading, handler registration, conditional gating) without spawning child processes.
- decomposition-smoke uses `DEFAULT_CONFIG` from `src/config.ts` because `createRefreshHelpers` reads `config.idle_refresh.{enabled,window_minutes,min_interval_minutes}` at construction; partial stubs would crash before returning.
- Pre-existing uncommitted work (index.test.ts, package.json, etc.) left untouched per task constraints.
