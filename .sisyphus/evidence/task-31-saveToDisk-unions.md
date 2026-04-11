# Task 31 Evidence: `saveToDisk` unions disk-only accounts

## Task Description

GREEN: Make `src/accounts.ts:saveToDisk` (via `src/storage.ts:saveAccounts`) UNION disk-only records with the in-memory accounts instead of overwriting. Addresses DEDUP-SAVE-UNION: when a concurrent process writes an account to disk between this process's `loadAccounts` and `saveAccounts`, the save silently drops it. The fix: on every save, re-read the disk snapshot, union its accounts with the in-memory accounts (using identity-first dedup), then write the union.

## Commit

`74cebf1` — `fix(accounts): saveToDisk unions disk-only accounts to prevent silent drops`

## Files Modified

- `src/storage.ts` (+181 / -74 lines — union logic + temp-file-atomic write)
- `src/accounts.ts` (2 lines — wire the new save path)
- `src/accounts.dedup.test.ts` (14 lines — unblock DEDUP-SAVE-UNION test)
- `src/accounts.test.ts` (28 lines — update existing tests to match new save contract)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+6 lines)

## Implementation Summary

The previous `saveAccounts` did `writeFile(path, JSON.stringify(inMemorySnapshot))` — a blind overwrite. Under concurrent access (two OpenCode instances, or this process and the CLI), the later writer won and silently dropped whatever the earlier writer had added.

The fix:

1. **Re-read disk snapshot inside `saveAccounts`** — before writing, read the current on-disk state.

2. **Union** — walk the disk accounts. For each disk entry, resolve its identity and check if the in-memory array has a match (via `findByIdentity`). If no match, append the disk entry to the in-memory array before serializing. In-memory wins when identities match (it's the newer state).

3. **Atomic write** — write to a sibling temp file (`accounts.json.tmp.<pid>.<nonce>`), `fsync`, rename over the target. This eliminates the partial-write window where another process could read half a file.

4. **`MAX_ACCOUNTS` re-check** — after the union, if the total exceeds `MAX_ACCOUNTS`, the oldest-by-`lastUsed` disk-only entry is dropped with a logged warning (never drops an in-memory entry — user is actively using those).

5. **Preserve `source` field** — the union path passes through the `source` field so CC disk-only entries stay CC-typed after union (complements T30).

## Test Results

- `npx vitest run src/accounts.dedup.test.ts -t "union"` — `saveToDisk unions disk-only accounts from a concurrent writer` test passes
- `npx vitest run src/accounts.test.ts` — existing save coverage updated and passing
- T41 full regression: 903/903 passing

## Verification

- [x] `saveAccounts` re-reads disk before serializing
- [x] Disk-only accounts preserved via identity-first union
- [x] In-memory wins when identities match
- [x] Atomic write via temp-file + rename
- [x] `MAX_ACCOUNTS` enforced after union
- [x] DEDUP-SAVE-UNION test from T14 suite GREEN
- [x] Pre-existing `accounts.test.ts` save tests still pass

## Status

COMPLETE — evidence covered by commit `74cebf1` and T41 regression.
