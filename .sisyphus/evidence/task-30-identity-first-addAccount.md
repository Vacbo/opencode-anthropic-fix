# Task 30 Evidence: Identity-first `addAccount` + preserve `source` in sync

## Task Description

GREEN: Refactor `src/accounts.ts:addAccount` to use identity-first matching via `resolveIdentity` + `findByIdentity` (from T29) instead of `refreshToken` matching. Also fix `syncActiveIndexFromDisk` to preserve the `source` field (DEDUP-SYNC-SOURCE) AND preserve in-flight object references (REFRESH-STALE-REFS), so an auth-only disk refresh does not rebuild `HealthScoreTracker` / `TokenBucketTracker` state or orphan pending refreshes.

## Commit

`4c95b04` — `refactor(accounts): identity-first addAccount and preserve source in syncActiveIndexFromDisk`

## Files Modified

- `src/accounts.ts` (+656 / -198 lines — major refactor)
- `src/__tests__/helpers/in-memory-storage.ts` (6 lines — helper alignment)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+7 lines)

## Implementation Summary

1. **`addAccount` now resolves identity first**:
   - Computes `AccountIdentity` for the incoming account
   - Calls `findByIdentity` against the current `#accounts` array
   - If a match is found: updates tokens + timestamps in place, preserves the existing `id`, health tracker, and token bucket — no new record
   - If no match: appends (still respects `MAX_ACCOUNTS`)
   - Explicit `verifyIdentity` step — even when `refreshToken` matches, if identities do NOT match (e.g., refresh token was accidentally reused across different accounts), a new record is created and logged. This guards against silent identity swaps.

2. **`syncActiveIndexFromDisk` preserves source and refs**:
   - Loads the disk snapshot
   - For each disk entry, resolves its identity and looks it up in the current `#accounts` array via `findByIdentity` (NOT by array index)
   - If found: updates the in-place account's `refreshToken`, `access`, `expires`, `email`, and **critically, preserves `source`** so CC accounts stay CC-typed
   - If not found: creates a new `ManagedAccount` wrapper around the disk entry
   - Never replaces the `#accounts` array reference; always mutates in place so in-flight refresh callers holding refs see the updated state instead of operating on an orphaned object
   - Does NOT rebuild `HealthScoreTracker` / `TokenBucketTracker` on auth-only refreshes; only rebuilds when the account is genuinely new

3. **`MAX_ACCOUNTS` enforced** — the identity-first path explicitly checks the cap before appending. Previously, the CC auto-detect path could bypass it.

## Test Results

- `npx vitest run src/accounts.dedup.test.ts` — identity-first dedup tests go GREEN (partial — T31 and T33 finish the rest of the RED suite)
- `npx vitest run src/accounts.test.ts` — existing coverage preserved, no regression
- Specific scenarios passing:
  - `CC rotation cycle does not create duplicate accounts` (10 cycles)
  - `addAccount with rotated refreshToken but same email updates in place`
  - `syncActiveIndexFromDisk preserves source field`
  - `syncActiveIndexFromDisk preserves in-flight account references`
  - `CC and OAuth accounts with same email are kept SEPARATE`
- T41 full regression: 903/903 passing

## Verification

- [x] `addAccount` uses `findByIdentity` not `findByRefreshToken`
- [x] In-place update preserves `id`, health, token bucket
- [x] `syncActiveIndexFromDisk` preserves `source` field
- [x] `syncActiveIndexFromDisk` preserves object identity (no array replacement)
- [x] `MAX_ACCOUNTS` enforced in all paths
- [x] T14 dedup tests partially GREEN (T31/T32/T33 complete the suite)

## Status

COMPLETE — evidence covered by commit `4c95b04`. Depends on T29 (identity abstraction). T41 regression confirms stability.
