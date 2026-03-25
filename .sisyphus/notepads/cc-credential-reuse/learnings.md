# CC Credential Reuse - Learnings

## Task 1: Add source field to ManagedAccount

### Summary

Added `source?: "cc-keychain" | "cc-file" | "oauth"` field to both `ManagedAccount` interface (src/accounts.ts) and `AccountMetadata` interface (src/storage.ts).

### Changes Made

1. **src/accounts.ts** - Added `source` field to `ManagedAccount` interface (line 24)
2. **src/storage.ts** - Added `source` field to `AccountMetadata` interface (line 30)
3. **src/accounts.ts** - Updated `AccountManager.load()` to set default `source: "oauth"` on loaded accounts (line 90)
4. **src/accounts.ts** - Updated `saveToDisk()` to persist `source` field (line 508)

### Test Results

- All 557 tests pass
- TypeScript compilation passes with no errors

### Key Decisions

- Default to `"oauth"` for backward compatibility with existing accounts
- Made field optional to handle legacy data that may not have the field

### Notes

- The test failures seen when running `bun test` directly are pre-existing environment issues (vi.setSystemTime not available in this vitest setup), not related to these changes
- The npm test script runs all 557 tests and they all pass

---

## Task 3: Config Section Implementation

### Summary

Added `cc_credential_reuse` configuration section to the plugin config schema.

### Files Modified

- `src/config.ts` - Added interface, defaults, and validation
- `src/config.test.ts` - Added 4 new tests

### Implementation Details

1. **Interface Addition** (src/config.ts:69-74):
   - Added `cc_credential_reuse` section to `AnthropicAuthConfig` interface
   - Three boolean fields: `enabled`, `auto_detect`, `prefer_over_oauth`
   - All default to `true`

2. **DEFAULT_CONFIG** (src/config.ts:113-118):
   - Added defaults matching interface

3. **createDefaultConfig()** (src/config.ts:140):
   - Added spread of `cc_credential_reuse` from DEFAULT_CONFIG

4. **validateConfig()** (src/config.ts:297-308):
   - Added validation block for cc_credential_reuse
   - Pattern follows existing sub-configs (signature_emulation, health_score, etc.)
   - Uses type checks and defaults fallback

### Tests Added

- `has cc_credential_reuse defaults` - Verifies default values
- `merges cc_credential_reuse sub-config` - Tests full override
- `merges partial cc_credential_reuse sub-config` - Tests partial override preserves defaults
- `respects explicit true values in cc_credential_reuse` - Tests explicit true values

### Test Results

- Config tests: 39 pass, 0 fail
- Full test suite: Pre-existing failures unrelated to changes

### Key Pattern

When adding new sub-config sections:

1. Add to interface
2. Add to DEFAULT_CONFIG
3. Add to createDefaultConfig()
4. Add validation in validateConfig()
5. Add tests following existing patterns

---

## Task 2: Claude Code Credential Reader

### Summary

Added `src/cc-credentials.ts` with read-only Claude Code credential discovery from macOS Keychain and `~/.claude/.credentials.json`, plus focused tests in `src/__tests__/cc-credentials.test.ts`.

### Key Patterns

- Use `security dump-keychain` first, then extract `"svce"<blob>="Claude Code-credentials..."` entries before calling `security find-generic-password -s <service> -w` per service.
- Treat Keychain exit codes `44`, `36`, and `128` as soft failures and return `null` rather than surfacing errors.
- Handle timeout failures from `execSync` as another soft failure path for Keychain reads.
- Parse both wrapped (`claudeAiOauth`) and flat credential JSON shapes, while rejecting MCP-only payloads that lack top-level Claude access tokens.
- Keep file reads unconditional in the top-level aggregator so Linux can still reuse `~/.claude/.credentials.json` even though Keychain is macOS-only.

### Verification

- `bun test src/__tests__/cc-credentials.test.ts` -> 16 passed, 0 failed
- `npm run build` -> passed

---

## Task 4: Token Refresh Source Gating

### Summary

Added CC-aware refresh gating in `src/token-refresh.ts` so `refreshAccountToken()` never sends CC-issued refresh tokens through the plugin's OAuth HTTP refresh path.

### Key Patterns

- Use `account.source` as the hard gate: only `"oauth" | undefined` accounts call `oauth.refreshToken()`.
- Re-read CC credentials from their original source before doing anything else: `readCCCredentials()` for keychain-backed accounts, `readCCCredentialsFromFile()` for file-backed accounts.
- Treat a CC credential as usable only when `expiresAt > Date.now() + FOREGROUND_EXPIRY_BUFFER_MS`, matching the existing foreground refresh buffer.
- When a CC credential is still stale, trigger Claude Code's own refresh flow with `claude -p . --model haiku` after resolving the binary via `which claude`, both guarded by `execSync` timeouts.
- Preserve the existing cross-process refresh lock and persist refreshed CC tokens through `onTokensUpdated()` plus OpenCode `auth.json` best-effort sync.

### Tests Added

- `src/token-refresh.test.ts` covers:
  - CC keychain re-read without HTTP refresh
  - CC file refresh via CLI-triggered re-read
  - OAuth accounts keeping the existing HTTP refresh path
  - Missing `claude` binary failing cleanly

### Verification

- `bun test src/token-refresh.test.ts` -> 4 passed, 0 failed
- `npm test` -> 581 passed, 0 failed
- `npm run build` -> passed

### Notes

- `bun test` (the Bun native runner) still hits pre-existing repo-wide incompatibilities with Vitest-specific APIs like `vi.setSystemTime`; the supported full-suite command here remains `npm test`.

---

## Task 5: AccountManager CC Credential Integration

### Summary

Integrated Claude Code credential auto-detection into `AccountManager.load()` so CC credentials join the in-memory account pool alongside OAuth accounts.

### Key Patterns

- Run CC auto-detection after disk/fallback account hydration so existing OAuth loading stays unchanged and CC accounts remain additive.
- Deduplicate CC imports by `refreshToken`, but keep likely email collisions side-by-side and emit a notice when the CC label references an existing OAuth email.
- Use `prefer_over_oauth` by reordering the in-memory pool with `getCCAccounts()` and `getOAuthAccounts()`, then reindexing accounts and resetting `currentIndex` to the first CC account.
- Default `readCCCredentials()` to an empty list in tests because `vi.resetAllMocks()` clears the mocked implementation between suites.

### Verification

- `npm test -- src/accounts.test.ts` -> 54 passed, 0 failed
- `npm test` -> 585 passed, 0 failed
- `npm run build` -> passed
- `bun test src/accounts.test.ts` and `bun test` still hit pre-existing Bun/Vitest incompatibilities plus unrelated Bun-only suite failures; the repo's supported verification remains `npm test`
