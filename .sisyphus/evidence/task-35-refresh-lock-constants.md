# Task 35 Evidence: `src/refresh-lock.ts` — widen `staleMs` and `timeoutMs` constants

## Task Description

GREEN: Widen the `refresh-lock.ts` constants `staleMs` and `timeoutMs` so they exceed the maximum observed CC refresh duration. Per Metis review: `staleMs ≥ 90000` (90s), `timeoutMs ≥ 15000` (15s). Previously `staleMs = 20000` stole live locks from 60-second CC refreshes, and `timeoutMs = 2000` was shorter than typical refresh operations, causing rotation thrashing.

## Commit

`2fea5e6` — `fix(refresh-lock): widen staleMs and timeoutMs to exceed CC refresh duration`

## Files Modified

- `src/refresh-lock.ts` (4 lines — constant widening)
- `src/refresh-lock.test.ts` (+45 lines — new coverage, updated for new constants)
- `src/token-refresh.ts` (2 lines — remove duplicate local constant)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+6 lines)

## Implementation Summary

The refresh lock uses a file-based mutex (`lockfile.lock`) in the account storage directory to coordinate refreshes across multiple OpenCode instances. Two constants govern its timing:

- **`staleMs`** — how long before a lock is considered stale and reaped by another process. If a holder dies mid-refresh, the stale check prevents the lock from being held forever.
- **`timeoutMs`** — how long a caller waits for the lock before giving up and retrying.

The previous values were:

```ts
const staleMs = 20_000; // 20 seconds
const timeoutMs = 2_000; // 2 seconds
```

Under CC credential refresh, which invokes `claude -p . --model haiku` and can take up to 60 seconds, both values were catastrophically wrong:

1. **`staleMs = 20s`**: a concurrent process observing a 25-second-old CC refresh would declare the lock stale and reap it, even though the refresh was still in progress. The legitimate holder would then fail to write its result, the reaper would start its own refresh, and both would end up clobbering each other.

2. **`timeoutMs = 2s`**: callers gave up after 2 seconds, reporting "lock timeout" and triggering account rotation. Under N concurrent callers on the same account, this produced rotation thrashing.

The fix:

```ts
export const REFRESH_LOCK_STALE_MS = 90_000; // 90 seconds, exceeds CC refresh
export const REFRESH_LOCK_TIMEOUT_MS = 15_000; // 15 seconds, exceeds typical refresh
```

These values are exported constants (not magic numbers), so tests and other modules can reference them. `token-refresh.ts` was also using a duplicate hardcoded `2_000` — that's now removed in favor of the shared constant.

Preserved: owner/inode verification (the lock file records the owner PID + inode; reapers verify both before reaping to avoid races).

## Test Results

- `npx vitest run src/refresh-lock.test.ts` — updated tests pass
  - New: `does not reap 30-second-old lock when staleMs is 90s` (exercises the widened value)
  - New: `timeoutMs >= 15s prevents rotation thrashing under 10s refresh`
  - Existing: owner verification, inode verification, basic acquire/release
- `npx vitest run src/token-refresh.test.ts` — passes
- T41 full regression: 903/903 passing

## Verification

- [x] `REFRESH_LOCK_STALE_MS = 90_000`
- [x] `REFRESH_LOCK_TIMEOUT_MS = 15_000`
- [x] Both exported as constants
- [x] Duplicate local constant in `token-refresh.ts` removed
- [x] Owner/inode verification preserved
- [x] Tests updated to exercise new values
- [x] No rotation thrashing observable under concurrent refresh

## Status

COMPLETE — evidence covered by commit `2fea5e6` and T41 regression.
