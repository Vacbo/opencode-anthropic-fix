## Task 38: Changelog and Version Bump (2026-04-10)

### Completed

Created CHANGELOG.md with v0.1.0 entry documenting all fixes and changes from Waves 1-5:

**CHANGELOG.md created with keep-a-changelog format:**

- **Fixed section**: 4 user-facing bug fixes
  - Parallel subagent failures (tool_use orphan errors)
  - SSE streaming fragility (Unable to connect errors)
  - Duplicate account creation on token rotation
  - 55+ inventoried bugs related to race conditions

- **Changed section**: 4 architectural improvements
  - Per-instance proxy lifecycle (was global)
  - Widened refresh lock constants (15s timeout, 90s stale)
  - SSE event-framing rewrite
  - Identity-based account dedup strategy

- **Added section**: 4 new modules
  - Account identity abstraction
  - Circuit breaker for per-request isolation
  - Parent PID watcher for cross-platform death detection
  - 10 new test files for parallel and dedup scenarios

- **Removed section**: 4 obsolete mechanisms
  - Global health check failure counter
  - Fixed port 48372 (now ephemeral)
  - Global PID file (now per-instance)
  - Global process event handlers

**package.json updated:**

- Version bumped from 0.0.37 to 0.1.0
- Signals completion of parallel-request and account-deduplication fixes

### Verification

- `npm run format:check` passes for new files
- Pre-existing format issue in `.sisyphus/notepads/quality-refactor/decisions.md` is unrelated
- CHANGELOG.md follows keep-a-changelog format with proper sections
- All entries are user-facing (no internal bug IDs)

### Files Modified

- CHANGELOG.md (new file with v0.1.0 entry)
- package.json (version bump 0.0.37 → 0.1.0)

### Commit

`docs(changelog): v0.1.0 entry for parallel-request and account-dedup fix`

## Task 39: Manual QA Scripts (2026-04-11)

- `scripts/mock-upstream.js` uses a kernel-assigned port, emits complete SSE event blocks, and assigns monotonic `toolu_` IDs per request.
- `scripts/qa-parallel.sh` validates 50 concurrent proxy requests by routing Bun fetch traffic through the local mock upstream via `HTTP_PROXY`, which avoids touching real Anthropic endpoints while keeping the proxy hostname allowlist intact.
- `scripts/rotation-test.js` drives repeated OAuth token rotations through the built plugin against a local token server and confirms the persisted account count stays at 2.

## Task 40: Full Suite Gate Test Sweep (2026-04-11)

- `index.test.ts` now uses mutable mocked account storage in the cross-request failover cases because `syncActiveIndexFromDisk()` rehydrates state on each fetch and will wipe in-memory rate-limit/auth mutations unless `saveAccounts` feeds subsequent `loadAccounts` calls.
- Mid-stream failover assertions also need the debounced `requestSaveToDisk()` timer flushed before the next request; advancing timers by a little over 1 second makes the persisted failover state observable.
- Refresh mocks must be real `Response` objects now that the plugin inspects response headers/body helpers during token refresh and final response shaping.
- `plugin-fetch-harness` smoke tests are safer when mocked transport responses are real `Response` instances with JSON content-types instead of partial response-shaped objects.
- Billing-header fingerprint expectations must include the current version-suffix algorithm: missing characters are padded with `"0"` and the Claude CLI version participates in the hash input.

## Task 41: Final Regression Checkpoint (2026-04-11)

### Completed

Ran full regression suite and captured evidence for Wave 6 final checkpoint before Final Verification Wave (F1–F4):

- **Vitest**: 903/903 tests passing (35 files) — baseline had 3 failed / 660 passed
- **TypeScript** (`tsc --noEmit`): 0 errors — baseline had 1 error in `src/request/body.ts:57`
- **Prettier** (`format:check`): clean — baseline had 1 stray `.md` warning
- **Build**: PASS with 3 artifacts (plugin 321 KB, cli 125 KB, bun-proxy 9 KB)
- **QA parallel** (`scripts/qa-parallel.sh`): PASS (50/50 requests, 0 orphans, 0 connect errors, parent-death watcher OK)
- **Guardrails** (scoped to runtime plugin code): ALL clean (0 matches)

### Regression Finding: ESLint

`npm run lint` FAILS with **16 errors + 20 warnings**. Baseline had 0 errors.

- **12 errors in `scripts/mock-upstream.js` and `scripts/rotation-test.js`** — CommonJS `require()` style forbidden by eslint config. These JS files were added in T39 (commit `d1353ab`) without an eslint override.
- **4 errors in `src/bun-fetch.ts:371` and `src/response/streaming.ts:{201,472,477}`** — empty `catch` blocks. Violates `AGENTS.md` "Never swallow errors" rule. Likely introduced during Wave 3 bun-fetch rewrite and Wave 4 streaming hardening.

**Recommendation for Final Verification Wave:** F2 (quality/lint) agent should fix the four empty catches (add comment or debug-level log) and migrate the two QA JS scripts to ESM or add a targeted eslint override for `scripts/*.js`.

### Task Evidence Coverage Gap

T21–T39 have no dedicated `task-NN-*.txt` evidence files. Only T0–T20, T40, and T41 do. Their work is covered by:

1. `.sisyphus/evidence/final-qa/` (39 files from wave-level verifications — `f1-*`, `f2-*`, `f3-*`, `f4-*`, `check1-*`, `check2-*`, and CLI verification outputs).
2. Git commits between Wave 3 and Wave 5 (identity-first, circuit breaker, parent-pid watcher, streaming hardening, refresh lock widening).

**Total evidence files: 99** (59 at top level + 39 in `final-qa/` + 1 markdown summary) — comfortably above the ≥ 70 threshold.

### Guardrail Verification Technique

When running `rg` guardrail greps, scope them to runtime plugin code by excluding:

- `src/**/*.test.ts` (negative assertions legitimately match the forbidden pattern)
- `src/__tests__/**` (test fixtures and smoke helpers)
- `src/bun-proxy.ts` (standalone child proxy process — needs its own SIGINT/exit)
- `src/parent-pid-watcher.ts` (explicit watcher that must exit when parent dies)
- `src/cli.ts` (standalone CLI entry point — needs `process.exit`)
- `scripts/**` (analysis/install/mock utility scripts)

Raw global greps for forbidden patterns show matches, but **all matches sit in intentional locations**. The scoped greps return 0 matches for all 8 guardrails.

### Tsc vs LSP discrepancy

`tsc --noEmit` exits clean because `tsconfig.json` has `exclude: ["**/*.test.ts"]` and `include: ["src/**/*.ts"]`. The LSP is broader and reports type errors in test files (`index.test.ts`, `src/backoff.test.ts`, `src/account-state.test.ts`, `src/circuit-breaker.test.ts`, `src/parent-pid-watcher.test.ts`). These don't block the build or the test run because vitest uses its own TS transpilation. Worth noting for a future cleanup pass, but out of T41's scope.

### Files created by T41

- `.sisyphus/evidence/task-41-vitest.txt`
- `.sisyphus/evidence/task-41-tsc.txt`
- `.sisyphus/evidence/task-41-lint.txt`
- `.sisyphus/evidence/task-41-format.txt`
- `.sisyphus/evidence/task-41-build.txt`
- `.sisyphus/evidence/task-41-guardrails.txt`
- `.sisyphus/evidence/task-41-qa-parallel.txt`
- `.sisyphus/evidence/wave-6-final-regression.md`

### Commit

`chore: final regression verification pass`
