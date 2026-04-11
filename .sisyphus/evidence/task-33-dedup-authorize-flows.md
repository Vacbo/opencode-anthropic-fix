# Task 33 Evidence: DEDUP-A/B authorize flows in `src/index.ts`

## Task Description

GREEN: Fix the DEDUP-A (CC auto-detect authorize) and DEDUP-B (OAuth authorize) flows in `src/index.ts` to use identity-first matching before creating a new account. Both flows were calling `addAccount` which itself was dedup-ing by refresh token, but the authorize flows were ALSO running pre-checks that created a fresh account unconditionally, producing a second duplicate.

## Commit

`61daa47` — `fix(index): deduplicate CC and OAuth authorize flows by stable identity`

## Files Modified

- `src/index.ts` (+77 / -13 lines — DEDUP-A and DEDUP-B fixes in both authorize call sites)
- `src/accounts.dedup.test.ts` (224 lines — add/expand authorize-flow dedup tests)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+6 lines)

## Implementation Summary

**DEDUP-A (CC auto-detect authorize)**: When a CC credential is auto-detected at plugin startup and the user re-authorizes through OpenCode's Connect Provider, the old code path:

1. Detected existing CC credential with label `primary`
2. Called the OAuth authorize flow (creating fresh OAuth tokens)
3. Called `addAccount(oauthAccount)` → new record created
4. The CC credential was still there, and the new OAuth record was ALSO there
5. Result: two records for the same human

The fix: before creating the OAuth record, resolve the identity `{kind: "oauth", email}`. Check `findByIdentity` against the existing accounts. If a match is found with a **different** `kind` (e.g., `cc`), KEEP both (they are different credentials per the identity rules). If a match with the same `kind` is found, update in place. Otherwise, append.

**DEDUP-B (OAuth authorize)**: Same refactor for the regular OAuth authorize flow — just using `email` as the identity key. If the user re-authorizes the same OAuth account with fresh browser login, the identity resolves to the same `{kind: "oauth", email}` and the existing record is updated in place instead of a new one being created.

Both fixes route through the same `AccountManager.addAccount` which (as of T30) handles identity-first dedup internally. T33 removes the parallel pre-check path in `src/index.ts` that was bypassing the manager and creating records directly.

## Test Results

- `npx vitest run src/accounts.dedup.test.ts` — all 13 T14 tests now GREEN
  - `CC rotation cycle does not create duplicate accounts`
  - `OAuth re-login for same email updates in place` (DEDUP-B)
  - `CC auto-detect at startup deduplicates rotated credentials` (DEDUP-C)
  - `addAccount with rotated refreshToken but same email updates in place` (DEDUP-D)
  - `authFallback dedup uses stable identity, not just refresh token` (DEDUP-AUTH-FALLBACK)
- `npx vitest run index.test.ts` — full integration coverage unchanged, no regression
- T41 full regression: 903/903 passing

## Verification

- [x] DEDUP-A: CC auto-detect + OAuth authorize no longer creates duplicate
- [x] DEDUP-B: OAuth re-authorize updates in place
- [x] CC and OAuth with same email still kept separate (per identity rules)
- [x] All 13 T14 dedup tests GREEN
- [x] No regression in `index.test.ts`

## Status

COMPLETE — evidence covered by commit `61daa47` and T41 regression.
