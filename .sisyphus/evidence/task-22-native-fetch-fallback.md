# Task 22 Evidence: Graceful native fetch fallback hardening

## Task Description

GREEN: Harden the graceful native fetch fallback in `src/bun-fetch.ts` so the plugin degrades cleanly when Bun is unavailable (Windows, missing `bun` binary, `spawn` failure, circuit breaker open). The fallback must never throw, never call `process.exit`, and always return a usable `Response` from `globalThis.fetch`.

## Commit

`4a3fb48` — `fix(bun-fetch): harden native fetch fallback for graceful degradation`

## Files Modified

- `src/bun-fetch.ts` (+61 / -21 lines per `git show --stat`)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+6 lines)

## Implementation Summary

The T20 rewrite already introduced per-instance state. T22 hardens the fallback paths:

1. **Bun absence detection** — `_hasBun` cache is consulted once per factory; if `which bun` fails, `createBunFetch()` returns an instance whose `fetch` is a pass-through to `globalThis.fetch` with a one-shot warning log. No spawn is ever attempted.

2. **Spawn error path** — if `spawn(bun, [...])` throws synchronously or emits `error` before the banner, the startup promise rejects with a categorized error. The next `fetch` call falls back to native fetch for that request and records a failure on the circuit breaker.

3. **Circuit breaker open** — when the breaker trips after N consecutive failures, subsequent requests go through native fetch for THIS request only. The breaker schedules its own probe via cooldown → HALF_OPEN. No request ever hangs waiting for a dead proxy.

4. **Hardening details**:
   - `reportFallback` logs via `console.error` (gated by the `debug` flag) and avoids dead conditional branches.
   - Native fetch is called with the original `input`/`init` unchanged — no body cloning, no URL rewriting.
   - `shutdown()` is safe to call even if the proxy never started (idempotent).
   - `getStatus()` returns `fallback` when the breaker is open or Bun is unavailable, distinct from `starting` / `ready` / `stopped`.

## Test Results

- `npx vitest run src/bun-fetch.test.ts` — PASS after T20+T22 (T11 RED tests go GREEN)
- T41 full regression: 903/903 passing (see `.sisyphus/evidence/task-41-vitest.txt`)
- Manual QA: `scripts/qa-parallel.sh` passes with 50/50 requests when Bun is present (see `.sisyphus/evidence/task-41-qa-parallel.txt`)
- Manual QA: setting `PATH=''` in a test shell forces fallback — plugin keeps working, all requests routed to native fetch (covered by T11 RED tests)

## Verification

- [x] No `process.exit` anywhere in `src/bun-fetch.ts`
- [x] Fallback returns a real `Response` object from `globalThis.fetch`
- [x] Circuit breaker state consulted per-request, not globally
- [x] T11 `bun-fetch.test.ts` "returns native fetch fallback when Bun unavailable" test passes
- [x] T11 `bun-fetch.test.ts` "per-request circuit breaker opens after N consecutive failures" test passes
- [x] Full suite clean at T41 gate

## Status

COMPLETE — evidence covered by commit `4a3fb48` and T41 regression. Note: T41 F2 review flagged pre-existing lint warnings for empty catch blocks in `bun-fetch.ts:371` (deferred to Final Verification Wave fix-up, not a T22 regression).
