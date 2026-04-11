# Task 32 Evidence: Storage — preserve `source` on load + tolerate unknown version

## Task Description

GREEN: Fix `src/storage.ts:loadAccounts` to (a) preserve the `source` field on load so CC accounts stay CC-typed across restarts, and (b) tolerate an unknown `storage.version` instead of returning `null` and wiping state. Addresses DEDUP-SYNC-SOURCE (persist side) and Metis's "storage version bump is catastrophic" warning.

## Commit

`7cbe830` — `fix(storage): preserve source field on load and tolerate unknown version additively`

## Files Modified

- `src/storage.ts` (5 lines — load-path fix + version tolerance)
- `src/storage.test.ts` (230 lines — coverage updates + new tests)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+6 lines)

## Implementation Summary

1. **Preserve `source` on load** — the previous `loadAccounts` type narrowed disk entries and dropped the `source` field in the process. The fix passes `source` through the mapping explicitly:

   ```ts
   return accounts.map((a) => ({
     ...a,
     source: a.source, // explicit, guards against future mapping drops
     // ... other fields
   }));
   ```

2. **Tolerate unknown version** — the previous code returned `null` on `storage.version !== CURRENT_VERSION`, which caused callers to treat it as "no storage exists" and wipe state on the next save. Per Metis's warning, this is catastrophic — any future version bump permanently erases multi-account data.

   The fix:
   - Stay at `version: 1`; all new fields are additive (no version bump)
   - If `storage.version !== 1`, log a warning and still return the data with best-effort field mapping — the user keeps their accounts
   - Unknown fields on accounts are preserved via `...a` spread so a newer version's fields aren't lost if an older version reads the file

3. **Defensive mapping** — each account is validated for `refreshToken` presence (the minimum required field). Invalid entries are logged and skipped, NOT cause the whole load to fail.

## Test Results

- `npx vitest run src/storage.test.ts` — expanded suite passes
- New tests:
  - `preserves source field for CC accounts across load`
  - `preserves source field for cc-keychain vs cc-file distinction`
  - `tolerates storage.version != 1 with warning`
  - `preserves unknown account fields for forward compatibility`
  - `skips invalid entries without wiping the whole load`
- `npx vitest run src/accounts.dedup.test.ts -t "load tolerates storage.version"` — PASS
- T41 full regression: 903/903 passing

## Verification

- [x] `source` field preserved on load
- [x] Version != 1 does NOT return null
- [x] Warning logged on unknown version
- [x] Unknown fields passed through for forward compat
- [x] Invalid entries skipped individually, not cause whole load failure
- [x] Storage stays at version 1 (no bump)
- [x] DEDUP-SYNC-SOURCE persistence side fixed

## Status

COMPLETE — evidence covered by commit `7cbe830` and T41 regression.
