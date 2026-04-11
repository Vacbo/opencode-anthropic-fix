# F2 Final QA — parallel-and-auth-fix Plan

**Captured:** 2026-04-11 00:49 UTC
**Baseline SHA:** `c4b557db7c525f70f2494cd6b0e1ab76376b4e28`
**Current SHA:** `1b4afe8` (HEAD)
**Commits in range:** 36

---

## One-line Verdict

`Build [PASS] | Lint [FAIL] | Format [PASS] | Tests [903 pass/0 fail] | TSC [0 errors] | Files [~45 clean/3 issues] | Commits [36] | VERDICT: REJECT`

---

## Pipeline Results

| Check           | Baseline            | Current         | Delta      | Evidence        |
| --------------- | ------------------- | --------------- | ---------- | --------------- |
| `tsc --noEmit`  | 1 error             | 0 errors        | ✅ +1      | `f2-tsc.txt`    |
| `npm run lint`  | 0 errors 0 warnings | 16 err 20 warn  | ❌ REGRESS | `f2-lint.txt`   |
| `format:check`  | 1 warning           | 0 issues        | ✅ +1      | `f2-format.txt` |
| `vitest`        | 3 fail 660 pass     | 0 fail 903 pass | ✅ MASSIVE | `f2-vitest.txt` |
| `npm run build` | PASS                | PASS            | ➖ equal   | `f2-build.txt`  |

### Headline: Test Suite

- **+243 new tests** (663 → 903)
- **All 3 baseline failures fixed** (fingerprint-regression + fetch-interceptor toast)
- **35 test files** (20 → 35)
- Full suite runs in **5.37s**

### Headline: TypeScript

- Baseline error `src/request/body.ts(57,7)` **fixed**
- Zero remaining errors

### Headline: Build

- `dist/opencode-anthropic-auth-plugin.js` and `dist/opencode-anthropic-auth-cli.mjs` built cleanly

---

## ❌ Lint Regression (BLOCKER)

Baseline: `0 errors, 0 warnings`. Current: `16 errors, 20 warnings`. The `eslint.config.ts` file is **unchanged** between baseline and HEAD — these are all net-new violations introduced by this plan.

### 16 errors

| File                        | Line      | Rule                                | Severity |
| --------------------------- | --------- | ----------------------------------- | -------- |
| `scripts/mock-upstream.js`  | 3         | `no-require-imports` + `no-undef`   | error×2  |
| `scripts/rotation-test.js`  | 3,4,5,6,7 | `no-require-imports` + `no-undef`   | error×10 |
| `src/bun-fetch.ts`          | 371       | `no-empty` (empty catch on SIGTERM) | error    |
| `src/response/streaming.ts` | 201       | `no-empty` (SSE JSON preview catch) | error    |
| `src/response/streaming.ts` | 472       | `no-empty` (onStreamError callback) | error    |
| `src/response/streaming.ts` | 477       | `no-empty` (reader.cancel catch)    | error    |

### 20 warnings

- `scripts/` and `__tests__/helpers/*.smoke.test.ts` — unused vars (`Conversation`, `ToolUseBlock`, `ToolResultBlock`, `counter1`, `encoder`)
- `accounts.dedup.test.ts`, `bun-fetch.test.ts` — `consistent-type-imports` on `import()` annotations (6 warnings)
- `bun-fetch.ts` (7 import only used as type + 5 console.error)
- `bun-fetch.ts` — `no-console` (lines 177,181,398,405,408) — CI/debug logging in a file **not exempted** by `eslint.config.ts`
- `circuit-breaker.test.ts` — unused imports `beforeEach`, `CircuitBreaker`
- `storage.ts:320` — `console.warn` (file not exempted)

### Why this matters

The plan's baseline note explicitly says:

> If every command was clean on this commit, the DoD is strict pass/zero-errors; if any command reported pre-existing warnings, the DoD is 'equal or better'.

Baseline lint was **strictly clean (0/0)**, so DoD for lint is **strict zero-errors**. Current state violates that DoD.

### Root causes

1. **`scripts/*.js` files** use CommonJS `require()` which the ESLint config forbids globally. Two ways to fix:
   - Convert to ESM `import http from "node:http"` (1-line change per file)
   - OR add `scripts/**/*.js` to a specific overrides block in `eslint.config.ts` that disables `no-require-imports` and enables Node globals (`require`, `module`, etc.)

2. **Empty catches** in `bun-fetch.ts:371` and `streaming.ts:201/472/477` are intentional (kill-already-dead-process, parser-partial-payload, downstream-cancel fallout). Fix by adding `// eslint-disable-next-line no-empty` or a body like `/* intentionally ignored */`.

3. **Console calls** in `bun-fetch.ts` and `storage.ts` — either add these files to the exempted list in `eslint.config.ts` (lines 54-58) or gate them behind `resolveDebug(...)` and use a logger abstraction.

---

## AI-Slop / Code-Smell Checks

| Check                                    | Result         | Notes                                                                                                                                                                            |
| ---------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rg "as\s+any"` on changed `.ts/.js`     | ✅ 0 matches   |                                                                                                                                                                                  |
| `rg "@ts-ignore\|@ts-expect-error"`      | ✅ 0 matches   |                                                                                                                                                                                  |
| `rg` empty-catch regex                   | ✅ 0 matches   | ESLint found 4 via AST — regex didn't because single-line                                                                                                                        |
| `rg "//\s*(TODO\|FIXME\|XXX\|HACK):"`    | ✅ 0 matches   |                                                                                                                                                                                  |
| `rg "console\.(log\|info\|warn\|error)"` | ⚠️ 80+ matches | Most in exempted `cli.ts`/`commands/`/`bun-proxy.ts`; 7 legitimate warnings in `bun-fetch.ts` + `storage.ts` + `env.ts` + `accounts.ts` + `index.ts` (see Lint Regression above) |

Full slop-check output: `f2-slop-checks.txt`

### Code quality findings (manual review)

1. **`src/bun-fetch.ts:172-182` — Dead conditional in `reportFallback`** (real AI-slop):

   ```ts
   if (resolveDebug(debugOverride)) {
     console.error(message);
     return;
   }
   console.error(message);
   ```

   Both branches log the identical message. The `if` is meaningless — the message always logs. Either the debug branch should log extra context, or the non-debug branch should silence/delegate. This is confusing control flow that the next reader will waste time trying to understand.

2. **`src/parent-pid-watcher.ts:32-37`** — Minor: both `EPERM` and default fall-through return `true`. Clear by intent (treat unknowns as alive), but the two `return true` statements could collapse.

3. **New modules are clean**: `circuit-breaker.ts` (235 LOC), `account-identity.ts` (108 LOC), `parent-pid-watcher.ts` (99 LOC) all have:
   - Single responsibility
   - Proper discriminated unions / enum state machines
   - No generic helper names
   - Clear, specific types
   - No dead comments, no TODOs, no `as any`

4. **File sizes** (new/modified):
   - `src/accounts.ts`: 1067 LOC (was already large at baseline; grew ~648 LOC) — approaching god-object territory but pre-existing
   - `src/bun-fetch.ts`: 510 LOC
   - `src/response/streaming.ts`: 557 LOC
   - Others: well-sized

---

## Commit Structure

### Expected vs actual

- **Expected:** 41 implementation commits (T0 baseline + T1..T41)
- **Actual:** 36 commits in `c4b557d..HEAD`
- **Delta:** −5 commits

One Wave-3 commit (`114f98f feat(wave3): implement circuit-breaker, parent-pid-watcher, bun-proxy rewrite`) bundles three task deliverables into a single commit, which accounts for most of the gap. The plan is atomic enough at the file-level, just not 1:1 with task IDs.

### Wave 2 RED commits (T8-T16) — `--no-verify` + TDD RED justification

All 9 RED commits present. Message-quality audit:

| SHA       | Task                | Has TDD RED justification text? | Has `--no-verify` mention? |
| --------- | ------------------- | ------------------------------- | -------------------------- |
| `4c8b5e3` | T8 circuit-breaker  | ✅                              | ✅                         |
| `1755ac5` | T9 account-identity | ❌ (title only)                 | ❌                         |
| `641c314` | T10 body            | ❌ (title only)                 | ❌                         |
| `aaef454` | T11 parent-pid      | ✅                              | ✅                         |
| `806cf0b` | T12 accounts dedup  | ❌ (title only)                 | ❌                         |
| `178656a` | T13 streaming       | ❌ (title only)                 | ❌                         |
| `d3b6286` | T14 bun-fetch       | ❌ (title only)                 | ❌                         |
| `8d2d0ba` | T15 bun-proxy       | ❌ (title only)                 | ❌                         |
| `b929a78` | T16 index parallel  | ❌ (title only)                 | ❌                         |

**Only 2 of 9 (22%) of RED commits carry the documented TDD RED phase justification in their commit bodies.** The plan says Wave 2 RED commits "MUST use `--no-verify` and the commit message MUST explain 'TDD RED phase: tests intentionally failing'". The 7 commits without justification likely still used `--no-verify` in practice (they introduced failing tests that couldn't have passed pre-commit hooks), but the commit messages don't document it.

Full commit-message audit: `f2-red-commit-messages.txt`

---

## Summary Table

| Dimension       | Baseline | Current             | Status |
| --------------- | -------- | ------------------- | ------ |
| Tests passing   | 660      | **903** (+243)      | ✅ +   |
| Tests failing   | 3        | **0**               | ✅ +   |
| Test files      | 20       | **35**              | ✅ +   |
| TSC errors      | 1        | **0**               | ✅ +   |
| Lint errors     | **0**    | **16**              | ❌ −   |
| Lint warnings   | **0**    | **20**              | ❌ −   |
| Format issues   | 1        | **0**               | ✅ +   |
| Build           | PASS     | PASS                | ➖     |
| Commits         | —        | 36 (expected 41)    | ⚠️ dev |
| RED commit docs | —        | 2/9 fully justified | ⚠️ dev |
| `as any`        | —        | **0**               | ✅     |
| `@ts-ignore`    | —        | **0**               | ✅     |
| Leftover TODOs  | —        | **0**               | ✅     |
| AI-slop bugs    | —        | 1 (reportFallback)  | ⚠️     |

---

## Verdict: **REJECT**

The plan delivers enormous value — 243 net-new tests, zero remaining test failures, circuit breaker + parent PID watcher + identity-first dedup + per-instance proxy all landed — but it introduces a **strict lint regression** against a **strictly-clean** baseline. The plan's own DoD ("no net-new regressions") is violated.

### Required to flip to APPROVE

1. **Fix 16 lint errors** (1–2 hours, straightforward):
   - `scripts/mock-upstream.js` + `scripts/rotation-test.js`: convert CommonJS → ESM OR add an overrides block to `eslint.config.ts`
   - `bun-fetch.ts:371`, `streaming.ts:201/472/477`: add eslint-disable comments or catch bodies
   - `bun-fetch.ts` console.error calls: add to exempted files list in `eslint.config.ts` OR wrap in logger
   - `storage.ts:320` console.warn: same
2. **Fix 20 lint warnings** (30 minutes):
   - Remove unused imports/vars in tests
   - Convert `import()` type annotations to `type` imports
3. **Fix the `reportFallback` dead conditional in `bun-fetch.ts:172-182`** (5 minutes):
   - Either differentiate the two branches or remove the `if`

### What to NOT change

- Do NOT touch the 903-test suite — it is the strongest part of this plan
- Do NOT touch the circuit-breaker/account-identity/parent-pid-watcher modules — they are clean
- Do NOT rewrite commit history — the 36-vs-41 count is acceptable; the RED-justification gap is a documentation deviation, not a correctness issue

### Scope of remediation

~2 hours of focused work. All fixes are localized to files already touched by this plan. No architectural changes needed.

---

## Appendix: Hidden Type Quality in Test Files

`tsconfig.json` excludes `**/*.test.ts`, so `npx tsc --noEmit` does NOT type-check tests. The plan's gate respects this exclusion, so the pipeline reports `TSC [0 errors]`. But LSP diagnostics (which type-check tests independently) reveal real type problems in files this plan authored or modified:

| File                             | Status   | LSP errors                                                                                                                                                                   |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.test.ts`                  | modified | 132+ errors (`possibly undefined`, discriminated union access on `type: "failed"`, `mockImplementation` on unmocked function types, `result.fetch` called without narrowing) |
| `src/circuit-breaker.test.ts`    | NEW      | 4 errors — accessing `.success`/`.error`/`.data` on `CircuitBreakerResult` without narrowing the discriminated union                                                         |
| `src/parent-pid-watcher.test.ts` | NEW      | 1 error — `Unused '@ts-expect-error' directive` (the directive no longer silences anything; likely stale)                                                                    |

Pre-existing test-type debt (not authored by this plan, but still hidden by the same exclude):

- `src/backoff.test.ts:283` — `RateLimitReason` literal mismatch
- `src/account-state.test.ts` — 9 errors (missing `AccountMetadata` required fields; missing `version` on `AccountStorage`)

### Why this matters

Vitest transpiles with esbuild which does NOT type-check — it only strips types. So these errors are invisible at runtime and the 903 tests pass. But:

1. The new discriminated-union tests in `circuit-breaker.test.ts` are **accessing the wrong variant without narrowing**, which means the assertions may work by accident today and break silently if the union shape changes
2. `index.test.ts` uses `possibly undefined` accesses that assume a mock setup succeeded — if any setup drifts, the test will NPE at runtime instead of failing with a clear type message
3. A stale `@ts-expect-error` in `parent-pid-watcher.test.ts:4` is dead code — it was either never needed or became obsolete when the referenced code changed

### Recommendation

Not a blocker for this plan's verdict, but worth raising to the orchestrator as **followup technical debt**: either include `**/*.test.ts` in the tsc gate and fix the ~145 resulting errors, or document that tests are intentionally loose-typed and rely on runtime assertions. The current middle ground (strict src, unchecked tests) hides real problems that the test suite authors didn't know they were introducing.

---

## Evidence Files Index

- `f2-tsc.txt` — tsc output (exit 0)
- `f2-lint.txt` — eslint output (exit 1, 16 errors + 20 warnings)
- `f2-format.txt` — prettier check output (exit 0)
- `f2-vitest.txt` — vitest output (903 pass, exit 0)
- `f2-build.txt` — bun build output (exit 0)
- `f2-changed-files.txt` — all 167 changed files since baseline
- `f2-changed-code-files.txt` — 48 changed `.ts/.js/.mjs` files (for slop checks)
- `f2-commits.txt` — 36 commits since baseline
- `f2-slop-checks.txt` — rg scan results for `as any`, `@ts-ignore`, empty catches, TODOs, console calls
- `f2-red-commit-messages.txt` — full commit bodies for Wave 2 RED commits (T8-T16)
- `f2-summary.md` — this file
