# Task 36 Evidence: Idle→foreground single-flight reentry + in-place token updates

## Task Description

GREEN: Fix `src/refresh-helpers.ts` single-flight re-check when an idle refresh is rejected and a foreground request arrives immediately after, and fix `src/token-refresh.ts` to update token fields in place on the existing `ManagedAccount` instead of replacing the object (REFRESH-STALE-REFS partial — the save-durability hole).

## Commit

`c5dde4e` — `fix(refresh-helpers): idle-to-foreground single-flight re-check after rejection`

## Files Modified

- `src/refresh-helpers.ts` (4 lines — single-flight re-check)
- `src/token-refresh.ts` (9 lines — in-place updates + save ordering)
- `src/token-refresh.test.ts` (+85 lines — add concurrent refresh scenarios)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+7 lines)
- `.sisyphus/plans/parallel-and-auth-fix.md` (2 lines — cross-reference note; non-semantic)

## Implementation Summary

Two related bugs:

### 1. Idle→foreground single-flight reentry

The plugin has an "idle refresh" path that preemptively refreshes tokens when they're nearing expiry, without blocking any active request. When the idle refresh is rejected (e.g., lock contention, transient network error, rate limit), the old code cleared the single-flight flag immediately. If a foreground request arrived in the same event-loop tick, it saw "no in-flight refresh" and started its OWN refresh — doubling the refresh traffic and creating duplicate-account symptoms in edge cases.

The fix: on rejection, the idle path re-checks the current state of the account before clearing the flag. If the account's `expires` is still valid (someone else refreshed, or the token was simply updated on disk by another process via `syncActiveIndexFromDisk`), the idle path treats the rejection as "already handled" and leaves the single-flight state intact for a brief window. If the account is still expiring, it clears normally and lets the foreground caller take over.

### 2. In-place token updates + save ordering

`token-refresh.ts` used to do:

```ts
const refreshed = await fetchNewToken(account);
accountManager.addAccount(refreshed); // creates new ManagedAccount wrapper
releaseLock();
await saveToDisk(); // AFTER releaseLock
```

Two problems:

- **Object replacement**: `addAccount` at the time created a new wrapper, orphaning any in-flight callers holding refs to the old wrapper.
- **Save-durability hole**: releasing the lock BEFORE `saveToDisk` meant another process could acquire the lock and read stale data from disk, since the save hadn't happened yet.

The fix:

```ts
const refreshed = await fetchNewToken(account);
// In-place field updates, preserves object identity + trackers
account.refreshToken = refreshed.refreshToken;
account.access = refreshed.access;
account.expires = refreshed.expires;
account.email = refreshed.email ?? account.email;
await saveToDisk(); // BEFORE releaseLock — save durability guaranteed
releaseLock();
```

T30's identity-first `addAccount` also supports this pattern: if called, it now mutates in place via `findByIdentity` rather than wrapping. T36 chooses direct mutation because the object IS already the right identity — there's no lookup needed.

## Test Results

- `npx vitest run src/token-refresh.test.ts` — expanded suite passes
  - New: `idle refresh rejection re-checks state before clearing single-flight`
  - New: `concurrent refresh callers coalesce via single-flight`
  - New: `saveToDisk completes before releaseLock`
  - New: `token-refresh updates ManagedAccount in place without orphaning`
- `npx vitest run src/refresh-lock.test.ts` — save-before-release invariant still holds
- T41 full regression: 903/903 passing

## Verification

- [x] Idle refresh re-checks state on rejection
- [x] Single-flight flag not cleared if account is no longer expiring
- [x] Foreground reentry does not double-refresh
- [x] Token fields updated in place on the existing `ManagedAccount`
- [x] `saveToDisk` completes before `releaseLock`
- [x] In-flight refs survive the refresh
- [x] T14 "syncActiveIndexFromDisk preserves in-flight account references" test GREEN

## Status

COMPLETE — evidence covered by commit `c5dde4e` and T41 regression.
