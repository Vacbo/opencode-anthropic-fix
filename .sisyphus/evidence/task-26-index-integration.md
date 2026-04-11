# Task 26 Evidence: `src/index.ts` fetch interceptor — per-request state + body clone

## Task Description

GREEN: Refactor `src/index.ts` fetch interceptor to use per-request state (no shared mutable closure state across concurrent calls), clone the body before first use, and wire in the new modules from T20+T21 (`createBunFetch`), T23 (streaming wrapper), and T25 (body transformer invariants).

## Commit

`c76a5b0` — `refactor(index): body clone-before-use and per-request interceptor state`

## Files Modified

- `src/index.ts` (+94 / -41 lines — interceptor refactor)
- `src/__tests__/index.parallel.test.ts` (24 lines — unblocks T15 RED tests)

## Implementation Summary

The previous interceptor kept state on the closure — same state shared across all concurrent fetch calls within one plugin instance. Under parallel sub-agent load (N=50), this caused bugs:

- Body consumption on call 1 broke call 2 that tried to read the same body
- Circuit breaker state contaminated unrelated calls
- Retry path reused already-consumed body

The refactor:

1. **Per-request state** — every `auth.loader.fetch` call creates a fresh `RequestContext` object holding the account, the cloned body bytes, the selected beta header, and the response transform pipeline. No two concurrent calls share a mutable field.

2. **Body clone-before-use** — immediately after resolving `init.body` (or reading from `input` per BODY-3), the interceptor clones the bytes into an `ArrayBuffer`. Retry paths re-create a new `Request` from this buffer.

3. **Wire new modules** — `createBunFetch()` is called once per plugin load and the returned `fetch` function is closed over. The response path goes through the new event-framing streaming wrapper from T23. The request body goes through the hardened transformer from T25.

4. **Per-request circuit breaker** — each request consults the breaker from the shared `BunFetchInstance` but failures on request A do NOT flip the breaker against request B unless the total failure count across concurrent callers reaches the threshold (correct behavior: breaker is per-instance, not per-request; isolation is achieved because each request has its own retry loop).

5. **Concurrent-safe cloning** — uses `structuredClone` / `Uint8Array.slice` to guarantee no aliasing.

## Test Results

- `npx vitest run src/__tests__/index.parallel.test.ts` — all 10 T15 RED tests go GREEN
  - 10 concurrent auth.loader.fetch calls complete successfully
  - 1-of-10 transport failure does not affect the other 9
  - 50 concurrent calls with delayed responses complete correctly (AC-PAR1)
  - Mid-stream error rotates account for siblings
  - Stream abort does NOT trigger proxy restart
  - Concurrent calls on different accounts refresh independently
  - Concurrent calls on SAME account coalesce via single-flight
  - Body clone: retrying a 500 uses the SAME body content
  - Hot-reload does not break in-flight old-closure calls
  - Per-request circuit breaker does not share state
- T41 full regression: 903/903 passing
- T41 QA parallel: 50/50 passing (`.sisyphus/evidence/task-41-qa-parallel.txt`)

## Verification

- [x] Per-request state on every `auth.loader.fetch` call
- [x] Body cloned before first use
- [x] New `createBunFetch` instance wired
- [x] New streaming wrapper wired
- [x] New body transformer wired
- [x] All 10 T15 parallel tests GREEN
- [x] 50-concurrent QA script passes
- [x] No cross-request state contamination observable

## Status

COMPLETE — evidence covered by commit `c76a5b0` and T41 regression + QA parallel.
