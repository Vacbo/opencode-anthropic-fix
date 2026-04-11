# Wave 6: Final Regression Checkpoint (Task 41)

**Plan:** parallel-and-auth-fix
**Captured:** 2026-04-11 03:41 UTC
**Git SHA:** 4c9b578053db57e783c13501d05d1705af6672f5 (`test: update existing tests for identity-first APIs and new lock constants`)
**Purpose:** Final regression checkpoint before the Final Verification Wave (F1–F4). Captures current state and compares against the Task 0 baseline.

## Executive Summary

| Check                | Baseline (T0)     | Current (T41)             | Status           |
| -------------------- | ----------------- | ------------------------- | ---------------- |
| Tests (Vitest)       | 3 failed / 660 ok | **903 passed / 35 files** | ✅ **FIXED**     |
| TypeScript (`tsc`)   | 1 error           | **0 errors**              | ✅ **FIXED**     |
| Build                | PASS (2 outputs)  | **PASS (3 outputs)**      | ✅ MAINTAINED    |
| Format (Prettier)    | 1 stray warning   | **Clean**                 | ✅ MAINTAINED    |
| Lint (ESLint)        | 0 errors          | **16 errors, 20 warn**    | ❌ **REGRESSED** |
| Guardrails (runtime) | n/a               | **0 matches (scoped)**    | ✅ CLEAN         |
| Manual QA (parallel) | n/a               | **PASS (50/50)**          | ✅ PASS          |
| Evidence files       | 7                 | **99 (recursive)**        | ✅ ≥ 70          |

**Net result:** Core functional regressions (tests + tsc) are fully resolved. Build, format, QA, and runtime guardrails are clean. **One new regression introduced:** ESLint reports 16 errors (12 `require()` in QA scripts, 4 empty `catch` blocks in runtime code). See [Lint Regression](#lint-regression-detail) below — these need to be addressed before shipping or during the Final Verification Wave.

---

## Check 1 — Vitest (tests)

**Evidence:** `task-41-vitest.txt`

```
 Test Files  35 passed (35)
      Tests  903 passed (903)
   Duration  5.35s
EXIT=0
```

**Baseline:** 3 failed / 660 passed / 20 files.
**Current:** 0 failed / 903 passed / 35 files.
**Delta:** +243 tests, +15 test files, 0 failures.
**Status:** ✅ **Baseline regression resolved. All 903 tests passing.**

The 3 original failures (index.test.ts fetch interceptor toast cases, fingerprint-regression billing header) are all fixed.

---

## Check 2 — TypeScript (`tsc --noEmit`)

**Evidence:** `task-41-tsc.txt`

```
EXIT=0
```

**Baseline:** `src/request/body.ts(57,7): error TS2554: Expected 3 arguments, but got 4.`
**Current:** 0 errors.
**Status:** ✅ **Baseline regression resolved.**

---

## Check 3 — Prettier (`format:check`)

**Evidence:** `task-41-format.txt`

```
Checking formatting...
All matched files use Prettier code style!
EXIT=0
```

**Baseline:** 1 stray warning in `.sisyphus/notepads/quality-refactor/decisions.md`.
**Current:** Clean.
**Status:** ✅ **Clean.**

---

## Check 4 — Build (`npm run build`)

**Evidence:** `task-41-build.txt`

```
> @vacbo/opencode-anthropic-fix@0.1.0 build
> bun scripts/build.ts

Built dist/opencode-anthropic-auth-plugin.js and dist/opencode-anthropic-auth-cli.mjs
EXIT=0
```

**Artifacts in `dist/`:**

| File                                | Size    | Purpose                |
| ----------------------------------- | ------- | ---------------------- |
| `opencode-anthropic-auth-plugin.js` | 321,204 | Main plugin bundle     |
| `opencode-anthropic-auth-cli.mjs`   | 125,153 | Standalone CLI bundle  |
| `bun-proxy.mjs`                     | 9,240   | Dedicated proxy script |

**Baseline dist size:** plugin 286,885 / cli 120,769 / bun-proxy 2,644.
**Delta:** plugin +34 KB, cli +4 KB, bun-proxy +6.6 KB — consistent with added circuit breaker, parent-pid watcher, account identity, streaming hardening, and refresh lock widening.
**Status:** ✅ **Build produces all expected artifacts.**

---

## Check 5 — ESLint (`npm run lint`) — ❌ REGRESSION

**Evidence:** `task-41-lint.txt`

```
✖ 36 problems (16 errors, 20 warnings)
EXIT=1
```

**Baseline:** 0 errors (clean).
**Current:** 16 errors, 20 warnings.

### Lint Regression Detail

**Errors (16):**

1. **`scripts/mock-upstream.js` (2 errors)** — CommonJS `require()` calls. File added in commit `d1353ab test(qa): scripts/qa-parallel.sh + rotation-test.js + mock-upstream.js` (Task 39).
2. **`scripts/rotation-test.js` (10 errors)** — CommonJS `require()` calls. Same commit as above.
3. **`src/bun-fetch.ts:371` (1 error)** — Empty block statement in a catch clause.
4. **`src/response/streaming.ts:201, 472, 477` (3 errors)** — Empty block statements in catch clauses.

**Warnings (20):** Type-only import annotations, unused vars in test files, 7 `console.*` statements in `bun-fetch.ts` + 1 in `storage.ts` — consistent with controlled debug logging behind env gating; not new.

### Why this was missed

- Tasks T21–T39 did not produce dedicated `task-NN-*.txt` evidence files (see [Task Evidence Coverage](#task-evidence-coverage)).
- The empty catch blocks likely slipped in during streaming hardening (Wave 4) and bun-fetch rewrite (Wave 3) because no per-task lint gate was captured.
- The `require()` errors in the new QA JS scripts were introduced by Task 39 (`d1353ab`), which did not capture a lint evidence file.

### Recommendation for Final Verification Wave

- **Non-blocking for functional behavior** — all 903 tests pass, build succeeds, types are clean, QA parallel passes.
- **Blocking for release hygiene** — the 4 empty `catch` blocks violate the project's `Never swallow errors` rule in `AGENTS.md`. The `require()` errors can be fixed by migrating the two JS scripts to ESM or adding a targeted eslint override for `scripts/*.js`.
- **Recommended fix location:** F2 (quality/lint) review agent in the Final Verification Wave.

---

## Check 6 — Guardrails

**Evidence:** `task-41-guardrails.txt`

### Raw global greps

Raw greps show matches, but **all matches are in intentional locations**:

| Pattern                              | Matches in                                                             | Reason                                                          |
| ------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `healthCheckFails\|MAX_HEALTH_FAILS` | `src/bun-fetch.test.ts` only                                           | Negative assertions verifying removal                           |
| `48372\|FIXED_PORT`                  | `bun-fetch.test.ts`, `mock-bun-proxy.smoke.test.ts`                    | Negative assertions + mock-fixture port                         |
| `opencode-bun-proxy.pid\|PID_FILE`   | `bun-fetch.test.ts` only                                               | Negative assertion                                              |
| `process.on uncaughtException`       | (no matches)                                                           | ✅                                                              |
| `process.on unhandledRejection`      | (no matches)                                                           | ✅                                                              |
| `process.on SIGINT`                  | `src/bun-proxy.ts`, `scripts/mock-upstream.js`                         | Standalone child process + mock server                          |
| `process.exit`                       | `cli.ts`, `bun-proxy.ts`, `parent-pid-watcher.ts`, `scripts/**`, tests | CLI entry point, child proxy, explicit watcher, utility scripts |
| `CURRENT_VERSION = 1`                | `src/storage.ts:48` (exactly 1 match)                                  | ✅                                                              |

### Scoped greps (runtime plugin code only, excluding tests + cli + bun-proxy + parent-pid-watcher + scripts)

```
### Scoped grep: SIGINT in runtime plugin code (expect 0)
(no matches)

### Scoped grep: process.exit in runtime plugin code (expect 0)
(no matches)

### Scoped grep: healthCheckFails|MAX_HEALTH_FAILS in runtime plugin code (expect 0)
(no matches)

### Scoped grep: FIXED_PORT|48372 in src/bun-fetch.ts (expect 0)
(no matches)

### Scoped grep: opencode-bun-proxy.pid|PID_FILE in src/bun-fetch.ts (expect 0)
(no matches)
```

**Status:** ✅ **All guardrails pass when scoped to runtime plugin code.** Matches in `bun-proxy.ts` (standalone child process), `cli.ts` (CLI entry point), and `parent-pid-watcher.ts` (explicit watcher) are expected and correct: these files are not loaded into the OpenCode host process.

---

## Check 7 — Manual QA Parallel (`scripts/qa-parallel.sh`)

**Evidence:** `task-41-qa-parallel.txt`

```
PASS | requests=50 | orphans=0 | connect_errors=0 | parent_death_ok=Y
EXIT=0
```

**Status:** ✅ **50 concurrent requests served successfully, zero orphaned `tool_use` IDs, zero connect errors, parent-death watcher confirmed functional.** This directly validates the parallel-subagent bug class that motivated this plan.

---

## Check 8 — Evidence file inventory

**Current counts:**

- Top-level files in `.sisyphus/evidence/`: 59
- Files in `.sisyphus/evidence/final-qa/`: 39
- **Total (recursive): 99 files**

**Task-evidence threshold:** ≥ 70. **Actual: 99.** ✅ **PASS.**

### Task evidence coverage

Task prefixes with at least one `task-NN-*.txt` file: **0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 40, 41** (23 task prefixes).

**Gap:** Tasks 21–39 have no dedicated `task-NN-*.txt` evidence files. Their work is covered by:

1. **Wave-level summaries** in `.sisyphus/evidence/final-qa/` (files `f1-*`, `f2-*`, `f3-*`, `f4-*`, `check1-*`, `check2-*`, and `01-*`–`25-*` CLI verification outputs).
2. **Git commits** between Wave 3 and Wave 5 (`4c9b578`, `d1353ab`, `c5dde4e`, `2fea5e6`, `c03e79b`, `61daa47`, `7cbe830`, `74cebf1`, `4c95b04`, `9b5b0e6`, `5423630`, `e19463e`, `c76a5b0`) which carry the implementation work for T21–T39.

**The ≥ 70 total-file threshold is met**, but individual per-task evidence for T21–T39 was not captured. This is reported honestly so the Final Verification Wave (F1–F4) can verify those tasks directly from git history and wave-level outputs if needed.

---

## Baseline vs Current Comparison

| Dimension       | Baseline (T0)          | Current (T41)          | Delta          |
| --------------- | ---------------------- | ---------------------- | -------------- |
| Git SHA         | `c4b557db`             | `4c9b5780`             | 70+ commits    |
| Test files      | 20                     | 35                     | +15 files      |
| Tests passing   | 660                    | 903                    | +243 tests     |
| Tests failing   | 3                      | 0                      | **-3** ✅      |
| TS errors       | 1                      | 0                      | **-1** ✅      |
| Lint errors     | 0                      | 16                     | **+16** ❌     |
| Lint warnings   | 0                      | 20                     | +20            |
| Format issues   | 1 (stray md)           | 0                      | **-1** ✅      |
| Build artifacts | 2 files (416 KB total) | 3 files (455 KB total) | +bun-proxy.mjs |
| Evidence files  | 7                      | 99                     | +92            |

---

## Guardrail Summary (plan-level)

From `AGENTS.md`:

- ✅ Single proxy handles N concurrent requests (verified by `qa-parallel.sh` — 50/50 pass).
- ✅ Circuit breaker is per-request not global (verified by `bun-fetch.test.ts` tests).
- ✅ No restart-kill behavior (verified — no global exit handlers in runtime plugin code).
- ✅ Stable identity dedup (verified by `accounts.dedup.test.ts` + `index.ts` identity-first login).
- ✅ OAuth beta `oauth-2025-04-20` included for OAuth requests (verified by existing fingerprint tests).

---

## Decision for Final Verification Wave

**Proceed to F1–F4 with the following caveat:**

- **F2 (quality / lint) must address 16 ESLint errors:**
  - 12 `require()` errors in `scripts/mock-upstream.js` and `scripts/rotation-test.js` — fix by migrating to ESM `import` or adding an eslint override for `scripts/*.js`.
  - 4 empty `catch` blocks in `src/bun-fetch.ts:371` and `src/response/streaming.ts:201,472,477` — add an explicit comment explaining why the error is ignored, or log at debug level. Empty catches violate `AGENTS.md`'s "Never swallow errors" rule.

All other checks are clean or passing. Core functional regressions from the baseline are resolved. The parallel-subagent bug class, duplicate-account creation on rotation, and SSE stream-completeness issues are all validated by passing tests and the manual QA script.

---

## Evidence files produced by Task 41

- `.sisyphus/evidence/task-41-vitest.txt` — full test suite output (903 passing)
- `.sisyphus/evidence/task-41-tsc.txt` — TypeScript check (0 errors)
- `.sisyphus/evidence/task-41-lint.txt` — ESLint output (16 errors, 20 warnings — regression logged)
- `.sisyphus/evidence/task-41-format.txt` — Prettier check (clean)
- `.sisyphus/evidence/task-41-build.txt` — Build output (3 artifacts)
- `.sisyphus/evidence/task-41-guardrails.txt` — Raw + scoped guardrail greps
- `.sisyphus/evidence/task-41-qa-parallel.txt` — Manual parallel QA (50/50 pass)
- `.sisyphus/evidence/wave-6-final-regression.md` — this summary
