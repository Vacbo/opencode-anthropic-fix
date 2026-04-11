# F2 Final QA (Re-run) — parallel-and-auth-fix Plan

**Captured:** 2026-04-11 (re-review)
**Previous verdict:** REJECT (16 lint errors + dead conditional in `bun-fetch.ts:172-182`)
**Previous session:** `ses_28557deffffezRoNITFjiN2TPl`
**Current HEAD:** `5423630` (with uncommitted lint fixes)

---

## One-line Verdict

`Build [PASS] | Lint [0 errors / 20 warnings] | Dead conditional [NOT FIXED] | VERDICT: REJECT`

---

## What was fixed

### ✅ Lint errors: 16 → 0

Verified via `bun run lint` (exit 0). Full output: `.sisyphus/evidence/final-qa/f2-lint-rerun.txt`.

| File                            | Fix                                                                                                | Confirmed |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | --------- |
| `scripts/mock-upstream.js:3`    | `require("node:http")` → `import http from "node:http"`                                            | ✅        |
| `scripts/rotation-test.js:3-7`  | 5× `require(...)` → `import ... from ...`                                                          | ✅        |
| `src/bun-fetch.ts:370`          | Empty catch now has comment `// Process may have already exited; ignore kill failures`             | ✅        |
| `src/response/streaming.ts:201` | Empty catch now has comment `// JSON parse failed; context will be returned without inFlightEvent` | ✅        |
| `src/response/streaming.ts:473` | Empty catch now has comment `// Error handler failed; continue with cleanup`                       | ✅        |
| `src/response/streaming.ts:479` | Empty catch now has comment `// Reader cancel failed; stream may already be closed`                | ✅        |

The comments satisfy the `no-empty` rule — a comment body disables the empty-block detection without suppressing the underlying intent.

### ✅ Build: PASS

`bun run build` exits 0. `dist/opencode-anthropic-auth-plugin.js` and `dist/opencode-anthropic-auth-cli.mjs` produced cleanly. Output: `.sisyphus/evidence/final-qa/f2-build-rerun.txt`.

### Lint warnings: 20 (unchanged)

Warnings were NOT in scope for this re-review per the task description (lint errors were the blocker). The 20 warnings are the same ones from the previous F2 report (unused imports in tests, `import()` type annotations, 5× `no-console` in `bun-fetch.ts`, 1× in `storage.ts`). These remain as acceptable technical debt and do not block the re-review verdict on the lint-regression axis.

---

## ❌ BLOCKER: Dead conditional in `bun-fetch.ts:172-182` was NOT fixed

### Current state (as of this re-review)

```ts
172:   const reportFallback = (reason: string, debugOverride?: boolean): void => {
173:     onProxyStatus?.(getStatus(reason, "fallback"));
174:
175:     const message = `[opencode-anthropic-auth] Native fetch fallback engaged (${reason}); Bun proxy fingerprint mimicry disabled for this request`;
176:     if (resolveDebug(debugOverride)) {
177:       console.error(message);
178:       return;
179:     }
180:
181:     console.error(message);
182:   };
```

### Why this is still a bug

Both branches execute `console.error(message)` with the **identical** `message` string. The only syntactic difference is the `return;` on line 178 — but line 181 is the final statement of the arrow function, so the implicit return at the closing brace produces **100% identical observable behavior**.

The `if (resolveDebug(...))` guard is dead code. Formally:

- `resolveDebug(...) === true` → logs `message`, returns.
- `resolveDebug(...) === false` → logs `message`, implicitly returns.

There is no observable side effect, no conditional logging, no debug-only branch, and no distinct control flow between the two arms. A junior reader will (correctly) assume the conditional gates something. It does not.

### Claimed fix vs. actual state

The task description stated:

> Dead conditional in bun-fetch.ts was modified (both branches still log but one returns early)

**This is factually incorrect.** Verification via `git log -p --all -- src/bun-fetch.ts`: the `reportFallback` function was introduced at commit `4a3fb48 fix(bun-fetch): harden native fetch fallback for graceful degradation` with exactly the current buggy shape. No subsequent commit has touched lines 172-182. The claimed "modification" did not occur.

The fixer may have misread the reviewer's feedback. The previous F2 report explicitly said:

> Both branches log the identical message. The `if` is meaningless — the message always logs. Either the debug branch should log extra context, or the non-debug branch should silence/delegate. This is confusing control flow that the next reader will waste time trying to understand.

Adding a `return` statement does not address any of those concerns — it was already there at introduction.

### Required to flip to APPROVE

Apply one of the following (5-minute fix):

**Option A — remove the dead conditional entirely** (recommended, matches current always-log intent):

```ts
const reportFallback = (reason: string, debugOverride?: boolean): void => {
  onProxyStatus?.(getStatus(reason, "fallback"));
  void debugOverride; // retained for API symmetry with reportStatus
  const message = `[opencode-anthropic-auth] Native fetch fallback engaged (${reason}); Bun proxy fingerprint mimicry disabled for this request`;
  // eslint-disable-next-line no-console -- user-facing fallback notice; no logger abstraction available
  console.error(message);
};
```

**Option B — differentiate debug branch with extra context** (preserves the intent implied by the parameter):

```ts
const reportFallback = (reason: string, debugOverride?: boolean): void => {
  onProxyStatus?.(getStatus(reason, "fallback"));
  const baseMessage = `[opencode-anthropic-auth] Native fetch fallback engaged (${reason}); Bun proxy fingerprint mimicry disabled for this request`;
  if (resolveDebug(debugOverride)) {
    // eslint-disable-next-line no-console -- debug-gated fallback notice
    console.error(
      `${baseMessage} (port=${state.activePort}, circuit=${breaker.getState()}, failures=${breaker.getFailureCount()})`,
    );
    return;
  }
  // eslint-disable-next-line no-console -- user-facing fallback notice
  console.error(baseMessage);
};
```

**Option C — gate logging entirely on debug** (quietest option):

```ts
const reportFallback = (reason: string, debugOverride?: boolean): void => {
  onProxyStatus?.(getStatus(reason, "fallback"));
  if (!resolveDebug(debugOverride)) {
    return;
  }
  // eslint-disable-next-line no-console -- debug-gated fallback notice
  console.error(
    `[opencode-anthropic-auth] Native fetch fallback engaged (${reason}); Bun proxy fingerprint mimicry disabled for this request`,
  );
};
```

Either option takes <5 minutes and keeps the function contract identical.

---

## Secondary AI-slop checks (informational)

| Check                                           | Result                                        | Notes                                                                                     |
| ----------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `as any` in `src/**/*.ts` (non-test)            | 1 match at `src/index.ts:191`                 | **Pre-existing** — present in baseline `c4b557d` at the equivalent location. Not net-new. |
| `as any` in smoke tests                         | 8 matches                                     | In `decomposition-smoke.test.ts` (pre-existing test stubs). Not net-new.                  |
| `@ts-expect-error`                              | 1 match at `src/parent-pid-watcher.test.ts:4` | Previously flagged as stale; still stale. Same deferred debt, not net-new.                |
| `@ts-ignore`                                    | 0                                             | ✅                                                                                        |
| Empty catches via regex `} catch {}` in `src/`  | 0                                             | ✅ (comment bodies now break the regex, matching lint result)                             |
| `TODO:` / `FIXME:` / `XXX:` / `HACK:` in `src/` | 0                                             | ✅                                                                                        |
| LSP diagnostics on `src/bun-fetch.ts`           | 0                                             | ✅                                                                                        |

Nothing in this table flips the verdict. The only new issue relative to previous-F2 is… zero new issues on the slop axis. The lint fixes are clean.

---

## Minor issues (not blocking, informational)

### `reportFallback` references `resolveDebug` before its declaration

- `reportFallback` is declared at line 172; `resolveDebug` is declared at line 184.
- Because both are `const` arrow functions and `reportFallback` only calls `resolveDebug` at call time (not at declaration time), this works at runtime — `resolveDebug` is initialized before any proxy startup calls `reportFallback`.
- However, it's ordering confusion that a reviewer or static analyzer could flag. If the dead conditional is fixed via Option A (removal), this concern also disappears. If fixed via Option B/C, consider reordering `resolveDebug` above `reportFallback`.

Severity: `FYI` (not blocking).

---

## Summary Table

| Dimension                                  | Previous F2 | Re-run            | Delta      |
| ------------------------------------------ | ----------- | ----------------- | ---------- |
| Lint errors                                | 16          | **0**             | ✅ −16     |
| Lint warnings                              | 20          | **20**            | ➖ equal   |
| Build                                      | PASS        | PASS              | ➖ equal   |
| Empty catches in `src/`                    | 4 (ESLint)  | **0**             | ✅ −4      |
| Scripts CJS `require()`                    | 12          | **0**             | ✅ −12     |
| Dead conditional in `bun-fetch.ts:172-182` | Present     | **Still present** | ❌ unfixed |
| New `as any` / `@ts-ignore`                | 0           | **0**             | ➖ equal   |
| New `TODO/FIXME`                           | 0           | **0**             | ➖ equal   |

---

## Verdict: **REJECT**

The lint regression is fully fixed. The dead conditional in `bun-fetch.ts:172-182` — which was the second of the two explicit blockers from the previous F2 review — was **NOT** actually modified. The task description's claim that "both branches still log but one returns early" describes the pre-fix state, not a fix. The `return;` on line 178 does not change observable behavior because line 181 is the function's final statement.

### What to do

1. **Apply one of Options A/B/C above** to `src/bun-fetch.ts:172-182`. Five-minute change.
2. Re-run `bun run lint` and `bun run build` to confirm they stay clean.
3. Re-request F2 review.

### What to NOT change

- Do NOT touch the lint fixes — they are correct.
- Do NOT touch the 903-test suite.
- Do NOT address the 20 lint warnings in this re-review loop — they're out of scope and untouched since previous F2.

### Scope of remediation

~5 minutes. Single-file, localized change to `src/bun-fetch.ts:172-182`.

---

## Evidence Files

- `f2-lint-rerun.txt` — `bun run lint` output (0 errors, 20 warnings, exit 0)
- `f2-build-rerun.txt` — `bun run build` output (exit 0)
- `f2-summary-rerun.md` — this file
- `f2-summary.md` — previous F2 review (for comparison)
