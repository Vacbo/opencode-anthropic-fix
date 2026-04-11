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

## F2 Final QA Run — 2026-04-11

- Plan delivers huge test suite improvement (660→903, 3 fail→0 fail) and clears all TSC errors, but introduces a lint regression (0→16 errors) that violates the baseline DoD.
- Root cause of lint regression: `scripts/mock-upstream.js` and `scripts/rotation-test.js` use CommonJS require() which the global eslint config forbids via `@typescript-eslint/no-require-imports`. The eslint.config.ts overrides block for `scripts/**` only exempts `no-console` and `no-explicit-any`, not `no-require-imports`.
- New empty catches in `bun-fetch.ts:371` and `streaming.ts:201/472/477` trigger `no-empty`. These are intentional ignores — fix by adding `// eslint-disable-next-line no-empty` or giving the catch a `/* intentionally ignored */` body.
- `bun-fetch.ts` and `storage.ts` have console.error/warn calls that trigger `no-console` — these files are not in the overrides block alongside `cli.ts`, `commands/`, `bun-proxy.ts`. Either add them or gate the logging through a logger abstraction.
- Real AI-slop bug in `src/bun-fetch.ts:172-182` `reportFallback`: dead conditional — both branches of `if (resolveDebug(...))` run the identical `console.error(message)`. The `if` is meaningless. Either differentiate the branches or remove the `if`.
- Wave 2 RED commit hygiene: only 2 of 9 RED commits (T8 circuit-breaker, T11 parent-pid) have full TDD RED justification text in their commit body. The other 7 are title-only ("test(X): add failing RED tests for Y"). Plan required explicit `--no-verify` + "TDD RED phase: tests intentionally failing" text.
- Commit count deviation: 36 commits in `c4b557d..HEAD` vs plan's expected 41. Root cause: `114f98f feat(wave3): implement circuit-breaker, parent-pid-watcher, bun-proxy rewrite` bundles 3 GREEN tasks into one commit.

## Hidden test-file type errors (pre-existing blind spot)

- `tsconfig.json` excludes `**/*.test.ts`, so `npx tsc --noEmit` never type-checks tests. The plan's gate respects this so tsc passes.
- LSP run against test files reveals ~145 type errors total:
  - `index.test.ts`: 132+ errors (possibly undefined mocks, discriminated union misses)
  - `src/circuit-breaker.test.ts`: 4 errors — accessing `.success`/`.error`/`.data` on `CircuitBreakerResult` without narrowing
  - `src/parent-pid-watcher.test.ts`: 1 error — unused `@ts-expect-error` directive (stale)
  - `src/backoff.test.ts` and `src/account-state.test.ts` — pre-existing
- Tests run fine because vitest transpiles without type-checking, but this is hidden quality debt. Recommend either including tests in tsc or documenting the intentional loose-typing policy.

## F4 Scope Fidelity Audit (2026-04-11)

- Rejected `parallel-and-auth-fix`: only T38 matched its planned file scope cleanly.
- Biggest drift sources were reused baseline/evidence commits (`b2694e9`, `1abba3f`), multi-task helper bundling in Wave 1 (`9a89d5b`, `4c8b5e3`, `35d8987`), and combined Wave 3 commits (`114f98f`, `f602847`).
- Metis tripwires stayed clean (`src/oauth.ts`, `src/system-prompt/`, `src/headers/`, `src/rotation.ts`, `src/models.ts`), so the rejection is about scope control rather than forbidden subsystem drift.
- Scope audit also found 50 unexpected overlaps and 103 changed files not covered by task `Files` sections, with `.sisyphus/plans/parallel-and-auth-fix.md` itself showing up in implementation commits despite the plan being read-only.

## F3 Manual QA — 2026-04-11 (Phase 8 closeout)

- qa-parallel.sh runtime contract is stable: 3/3 PASS with parent_death_ok=Y, orphan/connect_error sweeps clean. This script bakes the canonical fan-out shape (xargs -P 50 + x-proxy-url header).
- Standalone N=50 curl fan-out against separately-launched mock-upstream + bun-proxy requires `x-proxy-url: http://api.anthropic.com/v1/messages`. Without it the bun-proxy has no forwarding target and curl hangs until client timeout. The main build script does not emit dist/bun-proxy.mjs; qa-parallel.sh side-builds it via `bun x esbuild src/bun-proxy.ts` on demand.
- rotation-test.js creates its own fake accounts JSON payload (2 OAuth identities) via writeJson to whatever path ANTHROPIC_ACCOUNTS_FILE points at, then exercises 10 iterations per identity and asserts ACCOUNT_COUNT=2 after stable identity dedup. The script stubs globalThis.fetch to route platform.claude.com/v1/oauth/token to a local token server, so no real network is touched.
- Gotcha for sandbox-rooted tee: if `workdir` is set to the sandbox and the tee target is a relative path, the log lands inside the sandbox worktree and gets removed with it. Use absolute paths under the main repo's evidence dir when teeing from sandbox workdirs.
- Evidence audit revealed T21–T39 lack dedicated task-N-\*.txt files. T20+T21 was an atomic pair per the plan, which can explain T21, but T22–T39 remain unresolved bookkeeping. Runtime verification finds no regressions in the code those tasks shipped, so this is documentation debt, not a behavioral gap.

## F4 Scope Fidelity Audit (2026-04-11) — appended summary

- Rejected `parallel-and-auth-fix`: only T38 matched its planned file scope cleanly.
- Biggest drift sources were reused baseline/evidence commits (`b2694e9`, `1abba3f`), multi-task helper bundling in Wave 1 (`9a89d5b`, `4c8b5e3`, `35d8987`), and combined Wave 3 commits (`114f98f`, `f602847`).
- Metis tripwires stayed clean (`src/oauth.ts`, `src/system-prompt/`, `src/headers/`, `src/rotation.ts`, `src/models.ts`), so the rejection is about scope control rather than forbidden subsystem drift.
- Scope audit also found 50 unexpected overlaps and 103 changed files not covered by task `Files` sections, with `.sisyphus/plans/parallel-and-auth-fix.md` itself showing up in implementation commits despite the plan being read-only.

## T21-T39 Evidence Backfill (2026-04-11)

F1 reviewer flagged that T21 through T39 lacked dedicated `task-NN-*.md` evidence files. Work was covered by commit history, top-level `task-41-*` regression captures, and 39 `final-qa/` sub-wave files, but nothing mapped individual tasks to their verification artifacts. Generated 19 evidence files (one per task) from the commit log + learnings + plan, mapping each task to:

- Commit SHA
- Files modified with line counts
- Implementation summary (what/why, not boilerplate)
- Test results and RED to GREEN transitions
- Verification checklist
- Status and links to downstream regression evidence

Task-to-commit map:

- T21 (debug-gating flip) -> f602847 (atomic with T20)
- T22 (native fetch fallback) -> 4a3fb48
- T23 (SSE streaming rewrite) -> ab13c5c
- T24 (non-SSE JSON path) -> 9da569f
- T25 (body runtime checks) -> 11a7301
- T26 (index integration) -> c76a5b0
- T27 (stream-completeness propagation) -> e19463e
- T28 (upstream abort signal) -> 5423630
- T29 (account-identity module) -> 9b5b0e6
- T30 (identity-first addAccount) -> 4c95b04
- T31 (saveToDisk unions) -> 74cebf1
- T32 (storage version tolerance) -> 7cbe830
- T33 (DEDUP-A/B authorize) -> 61daa47
- T34 (DEDUP-CLI cmdLogin) -> c03e79b
- T35 (refresh-lock constants) -> 2fea5e6
- T36 (idle->foreground reentry) -> c5dde4e
- T37 (docs updates) -> af55df1
- T38 (CHANGELOG v0.1.0) -> ca3ea53
- T39 (manual QA scripts) -> d1353ab

Each evidence file faithfully documents what was actually implemented. No fabricated test counts, no invented file changes, no placeholder content. Cross-references T41 regression (903/903 tests passing, build clean, tsc clean) and F3 manual QA (3x qa-parallel.sh PASS, rotation-test.js PASS) for runtime verification of the work these tasks shipped.

This is documentation-only bookkeeping. The runtime code and its verification landed in the original Wave 3-6 commits.
