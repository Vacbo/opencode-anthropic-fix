# CC Credential Reuse — Dual Auth Pipeline

> **STATUS: ✅ COMPLETE** — Published as `@vacbo/opencode-anthropic-fix@0.0.30`
>
> **Completed**: 2026-03-25 | **Commits**: 10 | **Tests**: 592 passing

## TL;DR

> **Quick Summary**: Add Claude Code credential reuse as the preferred auth pipeline. When CC is installed and authenticated on the same machine, read its OAuth tokens directly from macOS Keychain or `~/.claude/.credentials.json` — same token, zero detection surface. Fall back to existing own-OAuth flow when CC is not available.
>
> **Deliverables**:
>
> - New `src/cc-credentials.ts` module for reading CC credentials from Keychain/file
> - Extended `ManagedAccount` with `source` discriminant field
> - Gated token refresh — CC accounts re-read from source, never HTTP refresh
> - New "Claude Code Credentials" auth method in Connect Provider dialog
> - Auto-detection of CC credentials in `auth.loader`
> - Config section `cc_credential_reuse` with enable/auto-detect flags
> - Full test coverage with mocked Keychain and file operations
>
> **Estimated Effort**: Medium (7 tasks, ~2-3 hours execution)
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: Task 1 → Task 4 → Task 5 → Task 6

---

## Context

### Original Request

User observed that having two separate OAuth tokens linked to the same Anthropic account (one from CC, one from this plugin) is a detection vector. If CC is already installed and authenticated, reusing its credentials means Anthropic sees exactly one client — Claude Code — with no second login event, no duplicate token, no correlation.

### Interview Summary

**Key Discussions**:

- Compared 6 projects in the ecosystem (CLIProxyAPIPlus, griffinmartin, ex-machina, unixfox, etc.)
- griffinmartin/opencode-claude-auth (452 stars, 13K/wk npm) already implements Keychain credential reading — studied their approach in detail
- User confirmed two pipelines: (1) CC credential reuse (preferred), (2) existing OAuth (fallback)
- User explicitly preferred credential reuse for stealth: "you would not have two tokens linked to your account"

**Research Findings**:

- CC stores credentials in macOS Keychain service `"Claude Code-credentials"` and `~/.claude/.credentials.json`
- CC credential format: `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, subscriptionType } }`
- Same file/Keychain can contain `mcpOAuth` entries that must be filtered
- Token refresh for CC credentials: re-read from source or invoke `claude -p . --model haiku`
- The plugin's current `refreshAccountToken()` uses a `client_id` — CC tokens were issued to CC's `client_id` so HTTP refresh would fail or corrupt CC's state

### Metis Review

**Identified Gaps** (addressed):

- **CRITICAL**: CC accounts must NEVER enter HTTP token refresh path — wrong `client_id` would corrupt CC's credentials. Resolved: gate refresh on `source` discriminant
- **Token ownership conflict**: Plugin must never write back to CC's Keychain/file. Resolved: read-only access, invoke `claude` CLI for refresh
- **MCP OAuth trap**: CC credential files contain MCP server OAuth entries. Resolved: filter entries with `mcpOAuth` but no `accessToken`
- **Keychain ACL prompts**: First `security` read may trigger macOS Allow/Deny dialog. Resolved: document, handle exit code 128 gracefully
- **Platform scope**: Deferred Linux `secret-tool` and Windows Credential Manager to future iteration

---

## Work Objectives

### Core Objective

Enable the plugin to reuse Claude Code's existing OAuth credentials when CC is installed and authenticated on the same machine, creating a dual-pipeline auth system where CC credential reuse is preferred and own-OAuth is the fallback.

### Concrete Deliverables

- `src/cc-credentials.ts` — CC credential reader module (Keychain + file)
- `src/__tests__/cc-credentials.test.ts` — Comprehensive tests
- Extended `ManagedAccount` interface with `source` field
- Modified `token-refresh.ts` — gated refresh by source
- Modified `accounts.ts` — CC credential loading in `AccountManager.load()`
- Modified `index.ts` — new auth method + auto-detection in loader
- Modified `config.ts` — new `cc_credential_reuse` config section

### Definition of Done

- [x] `bun test` — all 557+ existing tests pass unchanged
- [x] CC credential reading works from both Keychain and file
- [x] CC accounts never trigger HTTP token refresh
- [x] Expired CC tokens trigger `claude` CLI invocation for refresh
- [x] Existing OAuth flow works identically when CC is not installed
- [x] New auth method appears in Connect Provider dialog

### Must Have

- Read CC credentials from macOS Keychain (`security find-generic-password`)
- Read CC credentials from `~/.claude/.credentials.json` (Linux primary, macOS fallback)
- Filter MCP-only OAuth entries
- Gate token refresh by credential source
- Auto-detect CC credentials on plugin load
- Config flag to disable CC credential reuse
- Full test coverage with mocked external calls

### Must NOT Have (Guardrails)

- ❌ Writing to CC's Keychain entries or `~/.claude/.credentials.json`
- ❌ Calling `oauth.refreshToken()` with CC-sourced refresh tokens
- ❌ Windows Credential Manager support
- ❌ CLI commands for managing CC credential accounts
- ❌ Auto-migration from own-OAuth to CC credentials
- ❌ Windows Credential Manager integration
- ❌ Support for `CLAUDE_CONFIG_DIR` custom profiles (only default)
- ❌ Credential caching with TTL (read fresh each time for v1)
- ❌ Blocking plugin startup if CC credentials are unavailable

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES (vitest, 557 tests passing)
- **Automated tests**: TDD — tests written before implementation
- **Framework**: vitest

### QA Policy

Every task includes agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Module tests**: Use Bash (`bun test src/__tests__/cc-credentials.test.ts`)
- **Integration tests**: Use Bash (`bun test`)
- **Build verification**: Use Bash (`npm run build`)

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation, all independent):
├── Task 1: ManagedAccount source field + types [quick]
├── Task 2: CC credential reader module + tests [deep]
├── Task 3: Config schema for cc_credential_reuse [quick]

Wave 2 (After Wave 1 — core integration):
├── Task 4: Gate token refresh by source (depends: 1) [deep]
├── Task 5: AccountManager CC credential loading (depends: 1, 2, 3) [deep]

Wave 3 (After Wave 2 — wiring + docs):
├── Task 6: Auth method + loader auto-detection (depends: 5) [unspecified-high]
├── Task 7: Documentation update (depends: 6) [writing]

Wave FINAL (After ALL tasks — 4 parallel reviews):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high)
├── F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay
```

### Dependency Matrix

| Task | Depends On | Blocks | Wave |
| ---- | ---------- | ------ | ---- |
| 1    | —          | 4, 5   | 1    |
| 2    | —          | 5      | 1    |
| 3    | —          | 5      | 1    |
| 4    | 1          | 6      | 2    |
| 5    | 1, 2, 3    | 6      | 2    |
| 6    | 4, 5       | 7      | 3    |
| 7    | 6          | —      | 3    |

### Agent Dispatch Summary

- **Wave 1**: 3 tasks — T1 → `quick`, T2 → `deep`, T3 → `quick`
- **Wave 2**: 2 tasks — T4 → `deep`, T5 → `deep`
- **Wave 3**: 2 tasks — T6 → `unspecified-high`, T7 → `writing`
- **FINAL**: 4 tasks — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Add credential source field to ManagedAccount

  **What to do**:
  - Add `source: "cc-keychain" | "cc-file" | "oauth"` field to `ManagedAccount` interface in `src/accounts.ts`
  - Default value: `"oauth"` — all existing accounts get this automatically
  - Add the field to the `StoredAccount` interface in `src/storage.ts` for persistence
  - Update `AccountManager.load()` to set `source: "oauth"` on all existing accounts
  - Update `saveToDisk()` to persist the `source` field
  - Ensure all existing tests pass with the new default field

  **Must NOT do**:
  - Change any existing account behavior
  - Modify any other account fields
  - Add CC-specific logic yet — this is just the type foundation

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small type addition with default value, minimal code changes
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Tasks 4, 5
  - **Blocked By**: None

  **References**:
  - `src/accounts.ts:8-24` — `ManagedAccount` interface definition, add `source` field here
  - `src/storage.ts:20-40` — `StoredAccount` interface, needs matching field for persistence
  - `src/accounts.ts:60-140` — `AccountManager.load()`, set default `source: "oauth"` on loaded accounts
  - `src/accounts.ts:403-521` — `saveToDisk()`, persist the `source` field

  **Acceptance Criteria**:
  - [ ] `ManagedAccount` has `source: "cc-keychain" | "cc-file" | "oauth"` field
  - [ ] `StoredAccount` has matching `source` field
  - [ ] All existing accounts default to `source: "oauth"`
  - [ ] `bun test` → all 557+ existing tests pass unchanged

  **QA Scenarios**:

  ```
  Scenario: Existing accounts get default source
    Tool: Bash (bun test)
    Preconditions: No code changes except adding source field with default
    Steps:
      1. Run `bun test src/accounts.test.ts`
      2. Run `bun test src/storage.test.ts`
      3. Run `bun test` (full suite)
    Expected Result: All tests pass. Zero failures.
    Evidence: .sisyphus/evidence/task-1-existing-tests-pass.txt

  Scenario: Source field persists through save/load cycle
    Tool: Bash (bun test)
    Preconditions: Add test that creates account with source "cc-keychain", saves, reloads
    Steps:
      1. Create ManagedAccount with source: "cc-keychain"
      2. Save via saveToDisk()
      3. Reload via loadAccounts()
      4. Assert source field is preserved
    Expected Result: source === "cc-keychain" after round-trip
    Evidence: .sisyphus/evidence/task-1-source-persistence.txt
  ```

  **Commit**: YES
  - Message: `feat(types): add credential source to ManagedAccount`
  - Files: `src/accounts.ts`, `src/storage.ts`
  - Pre-commit: `bun test`

- [x] 2. Create CC credential reader module with tests

  **What to do**:
  - Create `src/cc-credentials.ts` with functions:
    - `readCCCredentialsFromKeychain(): CCCredential[] | null` — runs `security dump-keychain` to list services, then `security find-generic-password -s <service> -w` for each
    - `readCCCredentialsFromFile(): CCCredential | null` — reads `~/.claude/.credentials.json`
    - `readCCCredentials(): CCCredential[]` — tries Keychain first (macOS only), then file, returns all found
    - `parseCCCredentialData(raw: string): CCCredential | null` — parses JSON, handles both `{ claudeAiOauth: {...} }` wrapper and flat format, filters MCP-only entries
  - Create `src/__tests__/cc-credentials.test.ts` with comprehensive tests
  - Platform detection: `process.platform === "darwin"` for Keychain, file always tried
  - Handle `security` exit codes: 0=success, 44=not found, 36=locked, 128=denied
  - Set `{ timeout: 5000, encoding: "utf-8" }` on all `execSync` calls
  - Export `CCCredential` type: `{ accessToken: string, refreshToken: string, expiresAt: number, subscriptionType?: string, source: "cc-keychain" | "cc-file", label: string }`

  **Must NOT do**:
  - Write to Keychain or credentials file
  - Import or depend on AccountManager or any existing auth modules
  - Add Linux `secret-tool` reading — Linux uses file path only
  - Cache credentials — read fresh each call

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: New module with external process interaction, multiple error paths, comprehensive testing needed
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 5
  - **Blocked By**: None

  **References**:
  - griffinmartin `src/keychain.ts` (studied in session) — `readKeychainService()`, `listClaudeKeychainServices()`, `readCredentialsFile()`, `parseCredentials()` patterns. These are the reference implementations; study for patterns but don't copy verbatim
  - `src/storage.ts:163-204` — existing file reading with graceful error handling pattern in our codebase
  - `src/oauth.ts:220-252` — shows our HTTP token exchange pattern (NOT for CC accounts, but for code style reference)

  **Acceptance Criteria**:
  - [ ] `src/cc-credentials.ts` exists with all 4 functions
  - [ ] `src/__tests__/cc-credentials.test.ts` exists
  - [ ] `bun test src/__tests__/cc-credentials.test.ts` → all tests pass
  - [ ] Tests cover: successful Keychain read, Keychain not found (exit 44), Keychain locked (exit 36), Keychain denied (exit 128), Keychain timeout, file read success, file not found, malformed JSON, MCP-only entry filtering, flat format parsing, claudeAiOauth wrapper parsing, multiple Keychain services
  - [ ] `npm run build` succeeds

  **QA Scenarios**:

  ```
  Scenario: Parse valid CC credentials from claudeAiOauth wrapper
    Tool: Bash (bun test)
    Steps:
      1. Mock readFileSync to return `{"claudeAiOauth":{"accessToken":"sk-ant-test","refreshToken":"rt-test","expiresAt":9999999999999,"subscriptionType":"max"}}`
      2. Call readCCCredentialsFromFile()
      3. Assert result has accessToken "sk-ant-test", source "cc-file"
    Expected Result: Parsed credential with all fields populated
    Evidence: .sisyphus/evidence/task-2-parse-wrapper.txt

  Scenario: Filter MCP-only entries
    Tool: Bash (bun test)
    Steps:
      1. Mock data with `{"mcpOAuth":{"server1":{"accessToken":"mcp-tok"}}}`  (no top-level accessToken)
      2. Call parseCCCredentialData()
      3. Assert returns null
    Expected Result: null (MCP-only entries are filtered out)
    Evidence: .sisyphus/evidence/task-2-filter-mcp.txt

  Scenario: Handle Keychain exit code 44 (not found)
    Tool: Bash (bun test)
    Steps:
      1. Mock execSync to throw with status: 44
      2. Call readCCCredentialsFromKeychain()
      3. Assert returns null (not error)
    Expected Result: null returned, no exception thrown
    Evidence: .sisyphus/evidence/task-2-keychain-not-found.txt

  Scenario: Linux skips Keychain, reads file
    Tool: Bash (bun test)
    Steps:
      1. Mock process.platform = "linux"
      2. Mock valid credentials file
      3. Call readCCCredentials()
      4. Assert Keychain was NOT attempted, file was read, result has source "cc-file"
    Expected Result: One credential with source "cc-file"
    Evidence: .sisyphus/evidence/task-2-linux-file-only.txt
  ```

  **Commit**: YES
  - Message: `feat(cc-credentials): add CC credential reader module`
  - Files: `src/cc-credentials.ts`, `src/__tests__/cc-credentials.test.ts`
  - Pre-commit: `bun test`

- [x] 3. Add cc_credential_reuse config section

  **What to do**:
  - Add `cc_credential_reuse` section to config schema in `src/config.ts`:
    ```typescript
    cc_credential_reuse?: {
      enabled?: boolean;      // default: true
      auto_detect?: boolean;  // default: true — auto-load CC creds in loader
      prefer_over_oauth?: boolean; // default: true — CC creds used first when available
    }
    ```
  - Add default values in config loading
  - Add validation (all fields optional with sensible defaults)
  - Add tests in `src/config.test.ts`

  **Must NOT do**:
  - Add any CC credential reading logic — config only
  - Change existing config fields
  - Add config fields beyond the three above

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small config schema addition with defaults and validation
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Task 5
  - **Blocked By**: None

  **References**:
  - `src/config.ts:1-50` — existing `AnthropicAuthConfig` interface, add new section here
  - `src/config.ts:80-120` — `loadConfig()` function, add defaults for new section
  - `src/config.test.ts` — existing config tests, follow same patterns

  **Acceptance Criteria**:
  - [ ] `AnthropicAuthConfig` has `cc_credential_reuse` section
  - [ ] Defaults: `{ enabled: true, auto_detect: true, prefer_over_oauth: true }`
  - [ ] Config loads without errors when section is missing (defaults apply)
  - [ ] Config loads with explicit values when section is present
  - [ ] `bun test src/config.test.ts` → all tests pass

  **QA Scenarios**:

  ```
  Scenario: Config loads with defaults when section missing
    Tool: Bash (bun test)
    Steps:
      1. Load config from file without cc_credential_reuse section
      2. Assert config.cc_credential_reuse.enabled === true
      3. Assert config.cc_credential_reuse.auto_detect === true
    Expected Result: All defaults applied
    Evidence: .sisyphus/evidence/task-3-config-defaults.txt

  Scenario: Config respects explicit false values
    Tool: Bash (bun test)
    Steps:
      1. Load config with `{"cc_credential_reuse":{"enabled":false}}`
      2. Assert config.cc_credential_reuse.enabled === false
    Expected Result: Explicit values override defaults
    Evidence: .sisyphus/evidence/task-3-config-explicit.txt
  ```

  **Commit**: YES
  - Message: `feat(config): add cc_credential_reuse config section`
  - Files: `src/config.ts`, `src/config.test.ts`
  - Pre-commit: `bun test`

- [x] 4. Gate token refresh by credential source

  **What to do**:
  - Modify `refreshAccountToken()` in `src/token-refresh.ts` to check `account.source`
  - If `source === "cc-keychain" || source === "cc-file"`: DO NOT call `oauth.refreshToken()`. Instead:
    1. Re-read credentials from the original source (call `readCCCredentials()` from `src/cc-credentials.ts`)
    2. If re-read returns fresh token (not expired), update account in-memory and return
    3. If re-read returns expired token, try invoking `claude -p . --model haiku` via `execSync({ timeout: 60000 })` to trigger CC's own refresh
    4. Re-read again after CLI invocation
    5. If still expired or CLI fails, return failure (account rotation will pick next account)
  - If `source === "oauth"`: existing behavior unchanged — call `oauth.refreshToken()`
  - Add helper `refreshCCAccount(account)` that encapsulates the re-read + CLI logic
  - Add a `claudeBinaryPath()` helper that checks `which claude` to find the binary

  **Must NOT do**:
  - Call `oauth.refreshToken()` for CC-sourced accounts (CRITICAL — wrong client_id would corrupt tokens)
  - Write to CC's Keychain or credentials file
  - Change the refresh behavior for `source === "oauth"` accounts
  - Make the `claude` CLI invocation blocking for more than 60s

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Critical safety logic — the single most important change. Wrong implementation corrupts CC's credentials.
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 5 if careful, but recommended sequential)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 6
  - **Blocked By**: Task 1

  **References**:
  - `src/token-refresh.ts:102-189` — existing `refreshAccountToken()` function, add source check at top
  - `src/cc-credentials.ts` (from Task 2) — `readCCCredentials()` function to re-read from source
  - `src/oauth.ts:220-252` — existing `oauth.refreshToken()` that CC accounts must NOT call
  - `src/refresh-lock.ts:35-83` — cross-process lock, still needed for CC refresh (prevents concurrent `claude` CLI invocations)
  - griffinmartin `src/credentials.ts:refreshViaCli()` — reference for `claude -p . --model haiku` invocation pattern

  **Acceptance Criteria**:
  - [ ] CC-sourced accounts never call `oauth.refreshToken()`
  - [ ] CC-sourced accounts re-read from their original source on refresh
  - [ ] If re-read returns expired token, `claude` CLI is invoked with 60s timeout
  - [ ] If `claude` binary not found, refresh returns failure gracefully
  - [ ] OAuth-sourced accounts behave exactly as before
  - [ ] `bun test` → all tests pass

  **QA Scenarios**:

  ```
  Scenario: CC account refresh re-reads from source (happy path)
    Tool: Bash (bun test)
    Steps:
      1. Create account with source: "cc-file", expired token
      2. Mock readCCCredentials() to return fresh token
      3. Call refreshAccountToken(account)
      4. Assert oauth.refreshToken() was NOT called
      5. Assert account.access updated to fresh token
    Expected Result: Token updated from file re-read, no HTTP refresh
    Evidence: .sisyphus/evidence/task-4-cc-reread.txt

  Scenario: CC account invokes claude CLI when re-read still expired
    Tool: Bash (bun test)
    Steps:
      1. Create account with source: "cc-file", expired token
      2. Mock readCCCredentials() to return expired on first call, fresh on second
      3. Mock execSync for `claude -p . --model haiku` (succeeds)
      4. Call refreshAccountToken(account)
      5. Assert execSync was called with claude command
      6. Assert readCCCredentials() called twice
    Expected Result: CLI invoked, second read returns fresh token
    Evidence: .sisyphus/evidence/task-4-cc-cli-refresh.txt

  Scenario: OAuth account uses existing HTTP refresh (unchanged)
    Tool: Bash (bun test)
    Steps:
      1. Create account with source: "oauth", expired token
      2. Call refreshAccountToken(account)
      3. Assert oauth.refreshToken() WAS called
      4. Assert readCCCredentials() was NOT called
    Expected Result: Existing behavior preserved for OAuth accounts
    Evidence: .sisyphus/evidence/task-4-oauth-unchanged.txt

  Scenario: claude binary not found — graceful failure
    Tool: Bash (bun test)
    Steps:
      1. Create CC account with expired token
      2. Mock readCCCredentials() returns expired
      3. Mock execSync to throw (command not found)
      4. Call refreshAccountToken(account)
      5. Assert returns null/failure, no crash
    Expected Result: null returned, no unhandled exception
    Evidence: .sisyphus/evidence/task-4-no-claude-binary.txt
  ```

  **Commit**: YES
  - Message: `feat(token-refresh): gate refresh by credential source`
  - Files: `src/token-refresh.ts`, tests
  - Pre-commit: `bun test`

- [x] 5. Integrate CC credentials into AccountManager.load

  **What to do**:
  - Modify `AccountManager.load()` in `src/accounts.ts` to:
    1. Check `config.cc_credential_reuse.enabled` and `config.cc_credential_reuse.auto_detect`
    2. If enabled + auto_detect: call `readCCCredentials()` from `src/cc-credentials.ts`
    3. For each CC credential found, create a `ManagedAccount` with appropriate `source`
    4. If `config.cc_credential_reuse.prefer_over_oauth`: insert CC accounts at the beginning of the array (they get selected first by all strategies)
    5. If not prefer: append after OAuth accounts
  - Handle deduplication: if a CC credential has the same email as an existing OAuth account, keep both but log a notice
  - Modify `getCurrentAccount()` to understand that CC accounts exist alongside OAuth accounts
  - Add `getCCAccounts()` and `getOAuthAccounts()` helper methods for clarity

  **Must NOT do**:
  - Change how OAuth accounts are loaded — additive only
  - Remove or replace existing OAuth accounts with CC accounts
  - Block startup if CC credentials are unavailable
  - Change account rotation strategy logic

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Integration point touching core AccountManager, needs careful merge logic
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential with Task 4)
  - **Blocks**: Task 6
  - **Blocked By**: Tasks 1, 2, 3

  **References**:
  - `src/accounts.ts:60-140` — `AccountManager.load()`, inject CC credential loading here
  - `src/accounts.ts:207-244` — `getCurrentAccount()`, CC accounts participate in selection
  - `src/cc-credentials.ts` (from Task 2) — `readCCCredentials()` to get CC credentials
  - `src/config.ts` (from Task 3) — `config.cc_credential_reuse` settings
  - `src/accounts.ts:292-332` — `addAccount()`, reference for how accounts are created

  **Acceptance Criteria**:
  - [ ] CC credentials loaded in `AccountManager.load()` when config enabled
  - [ ] CC accounts appear in account pool with correct `source`
  - [ ] CC accounts preferred when `prefer_over_oauth: true`
  - [ ] OAuth accounts unaffected when CC credentials not available
  - [ ] No startup failure when CC not installed
  - [ ] `bun test` → all tests pass

  **QA Scenarios**:

  ```
  Scenario: CC credentials auto-loaded on startup (macOS)
    Tool: Bash (bun test)
    Steps:
      1. Mock readCCCredentials() to return one CC credential
      2. Config: cc_credential_reuse.enabled=true, auto_detect=true
      3. Call AccountManager.load()
      4. Assert account pool contains CC account with source "cc-keychain" or "cc-file"
    Expected Result: CC account in pool, ready for selection
    Evidence: .sisyphus/evidence/task-5-cc-loaded.txt

  Scenario: CC accounts preferred over OAuth
    Tool: Bash (bun test)
    Steps:
      1. Mock both CC credential and existing OAuth account
      2. Config: prefer_over_oauth=true
      3. Call getCurrentAccount()
      4. Assert selected account has source "cc-file" or "cc-keychain"
    Expected Result: CC account selected first
    Evidence: .sisyphus/evidence/task-5-cc-preferred.txt

  Scenario: Graceful when CC not installed
    Tool: Bash (bun test)
    Steps:
      1. Mock readCCCredentials() to return empty array
      2. Existing OAuth accounts present
      3. Call AccountManager.load()
      4. Assert only OAuth accounts in pool, no errors
    Expected Result: OAuth-only pool, no errors
    Evidence: .sisyphus/evidence/task-5-no-cc.txt

  Scenario: CC disabled via config
    Tool: Bash (bun test)
    Steps:
      1. Config: cc_credential_reuse.enabled=false
      2. Call AccountManager.load()
      3. Assert readCCCredentials() was NOT called
    Expected Result: CC detection skipped entirely
    Evidence: .sisyphus/evidence/task-5-cc-disabled.txt
  ```

  **Commit**: YES
  - Message: `feat(accounts): integrate CC credentials into AccountManager.load`
  - Files: `src/accounts.ts`, `src/accounts.test.ts`
  - Pre-commit: `bun test`

- [x] 6. Add CC Credentials auth method + loader auto-detection

  **What to do**:
  - Add new entry to `auth.methods` array in `src/index.ts`:
    ```typescript
    {
      label: "Claude Code Credentials (auto-detected)",
      type: "oauth",
      authorize: async () => {
        // 1. Try reading CC credentials
        // 2. If found: create account, return success
        // 3. If not found: return instructions to install CC
      }
    }
    ```
  - Place this method FIRST in the `auth.methods` array (before "Claude Pro/Max")
  - In the `auth.loader` function, add auto-detection:
    1. Before loading OAuth accounts, check if CC credentials are available
    2. If available and `config.cc_credential_reuse.auto_detect`, load them
    3. The AccountManager.load() from Task 5 handles the actual integration
  - Add status logging: "Found N Claude Code credential(s)" or "No Claude Code credentials found, using OAuth"
  - When CC credentials are found via auth method, sync to OpenCode's auth.json for the loader to pick up

  **Must NOT do**:
  - Remove or reorder existing auth methods beyond placing CC first
  - Change existing OAuth authorize/callback flow
  - Auto-migrate or remove existing OAuth accounts
  - Block the auth flow if CC detection fails

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Integration across auth methods and loader, touches the main plugin entry point
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 7
  - **Blocked By**: Tasks 4, 5

  **References**:
  - `src/index.ts:706-809` — existing `auth.methods` array, add new entry at position 0
  - `src/index.ts:330-370` — `auth.loader`, add CC auto-detection early in loader
  - `src/index.ts:350-354` — `AccountManager.load()` call, CC credentials flow through here
  - `index.test.ts:228-254` — test helper factories (`makeClient()`), follow for new tests
  - `index.test.ts:316-357` — existing auth method tests, add CC credential method test

  **Acceptance Criteria**:
  - [ ] "Claude Code Credentials" appears as first option in Connect Provider dialog
  - [ ] Selecting it reads CC credentials and creates account if found
  - [ ] Selecting it shows instructions to install CC if not found
  - [ ] Auto-detection loads CC credentials in loader when config enabled
  - [ ] Existing OAuth methods work unchanged
  - [ ] `bun test` → all tests pass

  **QA Scenarios**:

  ```
  Scenario: CC auth method found and creates account
    Tool: Bash (bun test)
    Steps:
      1. Mock readCCCredentials() to return valid credential
      2. Invoke CC auth method's authorize()
      3. Assert callback returns { type: "success" }
      4. Assert account created with source "cc-file"
    Expected Result: Account created from CC credentials
    Evidence: .sisyphus/evidence/task-6-cc-method-success.txt

  Scenario: CC auth method when CC not installed
    Tool: Bash (bun test)
    Steps:
      1. Mock readCCCredentials() to return empty array
      2. Invoke CC auth method's authorize()
      3. Assert returns instructions mentioning "Claude Code"
    Expected Result: Helpful instructions returned, no crash
    Evidence: .sisyphus/evidence/task-6-cc-method-not-found.txt

  Scenario: Loader auto-detects CC credentials
    Tool: Bash (bun test)
    Steps:
      1. Mock readCCCredentials() to return valid credential
      2. Config: cc_credential_reuse.auto_detect=true
      3. Call auth.loader(getAuth, provider)
      4. Assert returned fetch handler uses CC account
    Expected Result: Loader initializes with CC credentials
    Evidence: .sisyphus/evidence/task-6-loader-autodetect.txt

  Scenario: Existing OAuth methods unchanged
    Tool: Bash (bun test)
    Steps:
      1. Run all existing index.test.ts tests
      2. Assert no test failures
    Expected Result: All existing auth tests pass
    Evidence: .sisyphus/evidence/task-6-oauth-unchanged.txt
  ```

  **Commit**: YES
  - Message: `feat(auth): add CC Credentials auth method + auto-detection`
  - Files: `src/index.ts`, `index.test.ts`
  - Pre-commit: `bun test`

- [x] 7. Documentation update

  **What to do**:
  - Update `README.md` with new section: "Claude Code Credential Reuse"
    - How it works (reads existing CC credentials, same token, zero detection)
    - Prerequisites (Claude Code installed and authenticated)
    - Platform support (macOS Keychain + file, Linux file)
    - Configuration options (`cc_credential_reuse` in `anthropic-auth.json`)
    - How to disable if not wanted
    - Troubleshooting: Keychain prompts, CC not installed, token expiry
  - Keep existing OAuth documentation intact

  **Must NOT do**:
  - Remove existing documentation
  - Add implementation details that don't help users

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: Documentation writing task
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (after Task 6)
  - **Blocks**: None
  - **Blocked By**: Task 6

  **References**:
  - `README.md` — existing documentation, add new section
  - griffinmartin's README — reference for user-facing credential reuse docs

  **Acceptance Criteria**:
  - [ ] README has "Claude Code Credential Reuse" section
  - [ ] Platform support documented (macOS + Linux)
  - [ ] Configuration options documented
  - [ ] Troubleshooting section added

  **QA Scenarios**:

  ```
  Scenario: README contains CC credential reuse section with required content
    Tool: Bash (grep)
    Preconditions: Task 6 completed, README.md updated
    Steps:
      1. grep -c "Claude Code Credential Reuse" README.md → assert >= 1
      2. grep -c "macOS" README.md → assert >= 1
      3. grep -c "Linux" README.md → assert >= 1
      4. grep -c "cc_credential_reuse" README.md → assert >= 1
      5. grep -c "Troubleshooting" README.md → assert >= 1
      6. grep -c "Keychain" README.md → assert >= 1
    Expected Result: All 6 grep commands return >= 1 match
    Failure Indicators: Any grep returns 0 (section or keyword missing)
    Evidence: .sisyphus/evidence/task-7-readme-content.txt

  Scenario: Existing documentation not removed
    Tool: Bash (grep)
    Steps:
      1. grep -c "Claude Pro/Max" README.md → assert >= 1
      2. grep -c "OAuth" README.md → assert >= 1
      3. grep -c "anthropic-auth.json" README.md → assert >= 1
    Expected Result: All existing doc sections still present
    Failure Indicators: Any existing section missing
    Evidence: .sisyphus/evidence/task-7-existing-docs-intact.txt
  ```

  **Commit**: YES
  - Message: `docs: document CC credential reuse feature`
  - Files: `README.md`
  - Pre-commit: —

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [x] F1. **Plan Compliance Audit** — `oracle`
      Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
      Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
      Run `npm run build` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp).
      Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
      Start from clean state. Verify CC credential reading with mocked Keychain output. Verify fallback to file when Keychain fails. Verify existing OAuth flow unchanged. Test build output.
      Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
      For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance. Detect cross-task contamination.
      Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| #   | Message                                                             | Files                                                               | Pre-commit |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| 1   | `feat(types): add credential source to ManagedAccount`              | `src/accounts.ts`, `src/types.ts`                                   | `bun test` |
| 2   | `feat(cc-credentials): add CC credential reader module`             | `src/cc-credentials.ts`, `src/__tests__/cc-credentials.test.ts`     | `bun test` |
| 3   | `feat(config): add cc_credential_reuse config section`              | `src/config.ts`, `src/config.test.ts`                               | `bun test` |
| 4   | `feat(token-refresh): gate refresh by credential source`            | `src/token-refresh.ts`, `src/token-refresh.test.ts` or inline tests | `bun test` |
| 5   | `feat(accounts): integrate CC credentials into AccountManager.load` | `src/accounts.ts`, `src/accounts.test.ts`                           | `bun test` |
| 6   | `feat(auth): add CC Credentials auth method + auto-detection`       | `src/index.ts`, `index.test.ts`                                     | `bun test` |
| 7   | `docs: document CC credential reuse feature`                        | `README.md`                                                         | —          |

---

## Success Criteria

### Verification Commands

```bash
npm run build     # Expected: builds without errors
bun test          # Expected: all tests pass (557+ existing + new)
```

### Final Checklist

- [x] CC credentials read from macOS Keychain
- [x] CC credentials read from `~/.claude/.credentials.json`
- [x] MCP-only entries filtered out
- [x] CC accounts never trigger HTTP token refresh
- [x] Expired CC tokens trigger `claude` CLI refresh
- [x] "Claude Code Credentials" appears in Connect Provider dialog
- [x] Auto-detection loads CC credentials on plugin init
- [x] Config flag `cc_credential_reuse.enabled` works
- [x] Existing OAuth flow works identically
- [x] All "Must NOT Have" items absent from codebase
- [x] All tests pass
