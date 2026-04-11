# Task 34 Evidence: DEDUP-CLI fix in `src/cli.ts:cmdLogin`

## Task Description

GREEN: Fix `src/cli.ts:cmdLogin` to deduplicate by stable identity, reusing the `cmdReauth` stable-slot pattern. Addresses DEDUP-CLI: running `opencode-anthropic-auth login` on an already-authorized account created a duplicate record because the CLI had its own add-path that didn't call `AccountManager.addAccount`.

## Commit

`c03e79b` — `fix(cli): deduplicate cmdLogin by stable identity, reuse cmdReauth pattern`

## Files Modified

- `src/cli.ts` (+27 / -5 lines — cmdLogin refactor to reuse cmdReauth pattern)
- `src/cli.test.ts` (1 line — test alignment)
- `cli.test.ts` (57 lines — new CLI dedup coverage)
- `src/accounts.test.ts` (28 lines — updated assertions for new shared path)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+5 lines)
- `.sisyphus/plans/parallel-and-auth-fix.md` (10 lines — file was accidentally touched by commit; noted in F4 scope audit as non-semantic)

## Implementation Summary

`cmdReauth` already used a stable-slot pattern: find the account by index, run the OAuth flow, `manager.addAccount(newRecord)` which handles the identity-first dedup. This preserves the slot (`id`, position in array, trackers) and just rotates credentials.

`cmdLogin` did NOT use this pattern. Instead, it:

1. Ran the OAuth flow
2. Called a CLI-local helper that wrote directly to the storage file via `saveAccounts(loadAccounts().concat(newRecord))`
3. Bypassed `AccountManager.addAccount` entirely, which meant:
   - No identity-first dedup
   - No `MAX_ACCOUNTS` enforcement at the CLI boundary
   - No `HealthScoreTracker` / `TokenBucketTracker` preservation

The fix: `cmdLogin` now:

1. Constructs an `AccountManager` via the shared factory
2. Calls `manager.addAccount(newRecord)` which routes through T30's identity-first logic
3. Saves via `manager.saveToDisk()` which routes through T31's union logic
4. Reports success with the final account index (which is either the existing slot OR the newly appended one)

This also indirectly fixes DEDUP-ID-CHURN: since the same `ManagedAccount` wrapper is reused on identity match, the account UUID (stored in `id`) remains stable across CLI login cycles.

## Test Results

- `npx vitest run src/cli.test.ts` — CLI dedup tests pass
- `npx vitest run cli.test.ts` — new top-level CLI test file passes
- `npx vitest run src/accounts.test.ts` — updated coverage passes
- `npx vitest run src/accounts.dedup.test.ts -t "cmdLogin"` — `cmdLogin CLI path does not create duplicates on repeated login` PASS
- `npx vitest run src/accounts.dedup.test.ts -t "account_uuid remains stable"` — DEDUP-ID-CHURN PASS
- T41 full regression: 903/903 passing

## Verification

- [x] `cmdLogin` reuses `cmdReauth` stable-slot pattern
- [x] Routes through `AccountManager.addAccount` (not direct `saveAccounts`)
- [x] Identity-first dedup enforced
- [x] `MAX_ACCOUNTS` enforced at CLI boundary
- [x] Account UUID stable across login cycles
- [x] DEDUP-CLI and DEDUP-ID-CHURN tests GREEN

## Status

COMPLETE — evidence covered by commit `c03e79b` and T41 regression. F4 flagged minor scope drift (plan file touched) but this is documentation, not runtime code.
