# Task 29 Evidence: `src/account-identity.ts` — AccountIdentity abstraction

## Task Description

GREEN: Create `src/account-identity.ts` with the `AccountIdentity` type plus `resolveIdentity`, `findByIdentity`, and `identitiesMatch` helpers. This is the foundation for identity-first account deduplication — replaces refresh-token-only matching which breaks whenever Anthropic rotates the refresh token. OAuth accounts are keyed by `email`, CC accounts by `source + label`, legacy accounts fall back to `refreshToken`.

## Commit

`9b5b0e6` — `feat(account-identity): AccountIdentity abstraction with email/label/legacy resolution`

## Files Modified

- `src/account-identity.ts` (+108 lines — new module)
- `src/account-identity.test.ts` (176 lines — unblocks T10 RED tests)
- `src/accounts.ts` (+14 lines — expose helpers to the rest of the plugin)
- `src/storage.ts` (+24 lines — helper for CC source type-narrowing)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+7 lines)

## Implementation Summary

Previously, every dedup call site matched accounts by `refreshToken`. Since Anthropic rotates refresh tokens on every use, the "same" account looked different on every refresh, causing the plugin to create a new account record on each rotation. The storage file would fill up with dead duplicates until it hit `MAX_ACCOUNTS`.

The new module introduces a discriminated union `AccountIdentity`:

```ts
type AccountIdentity =
  | { kind: "oauth"; email: string }
  | { kind: "cc"; source: "cc-keychain" | "cc-file"; label: string }
  | { kind: "legacy"; refreshToken: string };
```

And three pure functions:

1. **`resolveIdentity(account: ManagedAccount): AccountIdentity`** — pure function mapping an account to its stable identity.
   - OAuth account with `email` → `{kind: "oauth", email}`
   - CC account with `source` and `label` → `{kind: "cc", source, label}`
   - Anything else → `{kind: "legacy", refreshToken}` (fallback for pre-migration records; covers DEDUP-SYNC-SOURCE sibling bug where `source` is dropped)

2. **`identitiesMatch(a, b): boolean`** — equality predicate with correct discriminated-union handling. Explicitly returns `false` for `oauth` vs `cc` with the same email (intentional separation: these are different credentials, even if the human is the same).

3. **`findByIdentity(accounts: ManagedAccount[], id: AccountIdentity): ManagedAccount | null`** — linear search.

All three functions are pure, side-effect-free, and testable without any mocks.

## Test Results

- `npx vitest run src/account-identity.test.ts` — all 12 T10 RED tests GREEN:
  - OAuth resolution with email: PASS
  - CC resolution with source+label: PASS
  - Legacy fallback for OAuth without email: PASS
  - Legacy fallback for CC without label: PASS
  - `identitiesMatch` for same oauth email: PASS
  - `identitiesMatch` false for oauth vs cc same email: PASS
  - `identitiesMatch` for same cc source+label: PASS
  - `identitiesMatch` false for cc keychain vs cc file: PASS
  - `identitiesMatch` for same legacy refreshToken: PASS
  - `findByIdentity` correct account: PASS
  - `findByIdentity` null when no match: PASS
  - `resolveIdentity` handles missing source (DEDUP-SYNC-SOURCE): PASS
- T41 full regression: 903/903 passing

## Verification

- [x] `src/account-identity.ts` created
- [x] `AccountIdentity` discriminated union exported
- [x] `resolveIdentity`, `findByIdentity`, `identitiesMatch` exported
- [x] All 12 T10 tests GREEN
- [x] OAuth vs CC with same email are kept separate
- [x] Legacy fallback for missing fields
- [x] Pure functions — no side effects

## Status

COMPLETE — evidence covered by commit `9b5b0e6` and T41 regression.
