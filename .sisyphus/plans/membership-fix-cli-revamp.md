# Fix Membership Verification Error + CLI TUI Revamp

## TL;DR

> **Quick Summary**: Fix an intermittent "membership benefits" 403 error caused by missing error signal detection in `backoff.ts`, and fully rewrite the CLI from raw console.log/readline to @clack/prompts with grouped subcommands.
>
> **Deliverables**:
>
> - Bug fix: `backoff.ts` detects "membership" errors as account-specific, enabling automatic retry/account-switch
> - CLI rewrite: All 17 commands migrated to @clack/prompts TUI with 5 grouped subcommands (auth, account, usage, config, manage)
> - Short alias `oaa` registered alongside `opencode-anthropic-auth`
> - TDD test coverage for all changes
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 4 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 (bug fix) | Task 4 → Task 5 → Tasks 6-11 → Task 12-13 (CLI)

---

## Context

### Original Request

User experiences intermittent "We're unable to verify your membership benefits at this time" errors in OpenCode when using CC credential auto-detection OAuth mode. Retrying the message works. User also wants a full CLI TUI revamp with modern UX patterns.

### Interview Summary

**Key Discussions**:

- Root cause: Two bugs — missing error signals in `backoff.ts` + stale token race condition (solved by correct classification)
- Error handling: Targeted signal additions only, no general 403 retry
- CLI framework: @clack/prompts — lightweight, bundles well with esbuild
- Command coverage: ALL 17 commands get TUI treatment
- Command grouping: 5 top-level subcommands (auth, account, usage, config, manage)
- CLI naming: Keep `opencode-anthropic-auth` + add `oaa` short alias
- Tests: TDD with vitest (existing test infrastructure)

**Research Findings**:

- Bug 2 (stale token race) is automatically solved by AUTH_FAILED classification — the existing `index.ts:611-613` flow clears access tokens and forces refresh, which uses `applyDiskAuthIfFresher()` to pick up fresher disk tokens
- Current `bodyHasAccountError()` has 9 type signals + 12 message signals — none match "membership"
- `parseRateLimitReason()` must also be updated for correct remediation path
- CLI has 7 interactive readline prompts across 5 commands, 6 isTTY guards, and 12 output-only commands
- @clack/prompts has known `isCancel` regression (issue #470) when bundled — must verify

### Metis Review

**Identified Gaps** (addressed):

- Must add signals to BOTH `bodyHasAccountError()` AND `parseRateLimitReason()` — not just one
- AUTH_FAILED classification solves Bug 2 for free — no changes to `token-refresh.ts` or `accounts.ts` needed
- CLI test mocks need migration from `vi.mock("node:readline/promises")` to `vi.mock("@clack/prompts")`
- `cmdStatus` one-liner format must stay scriptable (no @clack intro/outro)
- `cmdManage` loop needs explicit design — @clack has no loop primitive
- `isCancel` must be verified in esbuild bundle output
- Capture exact Anthropic 403 error body as first task (recommended as code comment)
- `confirm` variable name at cli.ts:1520 conflicts with @clack import — must rename
- `--no-color` flag needs @clack compatibility via `NO_COLOR` env var

---

## Work Objectives

### Core Objective

Fix the intermittent membership verification failure by adding missing error detection signals, and modernize the CLI from raw console output to a professional TUI using @clack/prompts with grouped subcommands.

### Concrete Deliverables

- Modified `src/backoff.ts` with "membership" error signals in both detection functions
- New tests in `src/backoff.test.ts` for membership error detection (TDD)
- Integration test in `index.test.ts` for full 403→switch→refresh flow
- Rewritten `src/cli.ts` using @clack/prompts for all 17 commands
- Grouped subcommand dispatch (auth, account, usage, config, manage)
- Short alias `oaa` in `package.json` bin
- Migrated `cli.test.ts` with @clack/prompts mocks
- Verified esbuild bundle with `isCancel` working correctly

### Definition of Done

- [ ] `bun test src/backoff.test.ts` — all tests pass including new membership cases
- [ ] `bun test cli.test.ts` — all tests pass with @clack mocks
- [ ] `bun test` — full suite green
- [ ] `bun scripts/build.ts && node dist/opencode-anthropic-auth-cli.mjs help` — exit 0
- [ ] Bundle size documented (before/after)

### Must Have

- "membership" and "unable to verify" signals in `bodyHasAccountError()`
- Correct classification in `parseRateLimitReason()` (AUTH_FAILED for stale token scenario)
- All 17 CLI commands working with @clack/prompts
- Subcommand grouping: `auth`, `account`, `usage`, `config`, `manage`
- Short alias `oaa` in package.json
- All 6 `isTTY` guards preserved
- `--no-color` and `--force` flags working
- `cmdStatus` scriptable one-liner format unchanged
- `isCancel()` checked after every @clack prompt call

### Must NOT Have (Guardrails)

- No general 403 retry mechanism
- No broad catch-all signals like "unable" or "error" that false-positive
- No modifications to `storage.ts`, `config.ts`, `oauth.ts`, `accounts.ts`, `token-refresh.ts`, `index.ts` (beyond what the backoff fix already covers)
- No new CLI commands or features — only port existing 17
- No custom theming layer for @clack/prompts
- No changes to dispatch routing architecture beyond subcommand grouping
- No intro/outro for scriptable commands (status, config file paths)
- No adding spinners to sub-100ms operations

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES (vitest, `bun test`)
- **Automated tests**: TDD (failing tests first)
- **Framework**: vitest (existing)
- **Each task**: RED (failing test) → GREEN (minimal impl) → REFACTOR

### QA Policy

Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Bug fix tests**: Use Bash (`bun test`) — Run specific test files, assert pass/fail counts
- **CLI commands**: Use interactive_bash (tmux) — Run CLI commands, validate output
- **Bundle**: Use Bash — Build and execute bundled CLI, verify exit codes

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — bug fix + CLI infrastructure):
├── Task 1: Membership error signal detection + tests [quick]
├── Task 3: Add @clack/prompts dependency + verify esbuild bundling [quick]
└── Task 4: Design subcommand grouping dispatch structure [quick]

Wave 2 (After Wave 1 — integration test + CLI test migration + first auth migration):
├── Task 2: Integration test for 403→switch→refresh flow [deep] (parallel with 5→6)
├── Task 5: Migrate cli.test.ts mocks from readline to @clack/prompts [unspecified-high]
└── Task 6: Rewrite auth commands (login, logout, reauth, refresh) [unspecified-high] (after Task 5)

Wave 3 (After Wave 2 — CLI command migration, MAX PARALLEL):
├── Task 7: Rewrite account commands (list, switch, enable, disable, remove, reset) [unspecified-high]
├── Task 8: Rewrite usage commands (stats, reset-stats, status) [unspecified-high]
├── Task 9: Rewrite config commands + NEW strategy tests [unspecified-high]
└── Task 10: Rewrite manage interactive loop + NEW manage tests [deep]

Wave 4a (After Wave 3 — polish):
└── Task 11: Add short alias + help command + cleanup legacy helpers [quick]

Wave 4b (After Task 11 — final verification):
└── Task 12: Bundle verification + isCancel test + size audit [quick]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: Task 1 → Task 2 (bug fix) | Task 3 → Task 5 → Task 6 → Task 10 → Task 11 → Task 12 → FINAL
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 4 (Waves 2 & 3)
```

### Dependency Matrix

| Task | Depends On     | Blocks         | Wave |
| ---- | -------------- | -------------- | ---- |
| 1    | —              | 2              | 1    |
| 2    | 1              | FINAL          | 2    |
| 3    | —              | 5, 6           | 1    |
| 4    | —              | 6, 7, 8, 9, 10 | 1    |
| 5    | 3              | 6, 7, 8, 9, 10 | 2    |
| 6    | 3, 4, 5        | 11             | 2    |
| 7    | 4, 5           | 11             | 3    |
| 8    | 4, 5           | 11             | 3    |
| 9    | 4, 5           | 11             | 3    |
| 10   | 4, 5           | 11             | 3    |
| 11   | 6, 7, 8, 9, 10 | 12             | 4    |
| 12   | 11             | FINAL          | 4    |

### Agent Dispatch Summary

- **Wave 1**: **3** — T1 → `quick`, T3 → `quick`, T4 → `quick`
- **Wave 2**: **3** — T2 → `deep`, T5 → `unspecified-high`, T6 → `unspecified-high`
- **Wave 3**: **4** — T7 → `unspecified-high`, T8 → `unspecified-high`, T9 → `unspecified-high`, T10 → `deep`
- **Wave 4**: **2** — T11 → `quick`, T12 → `quick`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Add membership error signal detection with tests (TDD — write tests and implementation together)

  **What to do**:

  **Tests (RED → GREEN in one commit due to pre-commit hooks running `npm test`):**
  - Add test cases to `src/backoff.test.ts` that assert `bodyHasAccountError()` returns `true` for bodies containing "membership" language
  - Add test cases that assert `parseRateLimitReason()` returns `"AUTH_FAILED"` for the membership error
  - Add test cases that assert `isAccountSpecificError(403, body)` returns `true` for membership error bodies
  - Add negative test: `bodyHasAccountError()` returns `false` for unrelated 403 bodies (e.g., "Internal server error", "Access denied to unrelated resource")
  - Include both structured JSON body format (`{ error: { type: "...", message: "..." } }`) and raw string format

  **Implementation:**
  - Add `"membership"` to the `messageSignals` array in `bodyHasAccountError()` (line 111-123)
  - Add `"unable to verify"` to the `messageSignals` array (catches the specific Anthropic phrasing)
  - Add `"membership"` to the `authSignals` array in `parseRateLimitReason()` (line 158-166) — this classifies it as AUTH_FAILED, which triggers the existing token-clearing + refresh flow at `index.ts:611-613`, automatically fixing Bug 2 (stale token race)
  - Add a code comment: `// Anthropic returns "We're unable to verify your membership benefits" on 403 when access token is stale`

  **NOTE**: Pre-commit hook runs `npm test` (`.husky/pre-commit`), so tests and implementation must be committed together to pass the hook. Write tests first locally (verify they fail), then implement, then commit both.

  **Must NOT do**:
  - Do NOT add broad signals like "unable", "verify", "error", "benefit" individually — too many false positives
  - Do NOT modify `token-refresh.ts`, `accounts.ts`, or `index.ts`
  - Do NOT add a general 403 retry mechanism
  - Do NOT modify `typeSignals` array (the error is in the message field, not type field)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 4, 5)
  - **Blocks**: Task 2
  - **Blocked By**: None

  **References**:
  - `src/backoff.test.ts` — Existing test structure, 408 lines of signal detection tests covering `bodyHasAccountError`, `parseRateLimitReason`, `isAccountSpecificError`. Follow the exact same test patterns (describe blocks, test titles, assertion style)
  - `src/backoff.ts:97-130` — `bodyHasAccountError()` function with `typeSignals` array (line 100-109) and `messageSignals` array (line 111-123) — detection targets
  - `src/backoff.ts:155-195` — `parseRateLimitReason()` function with `authSignals` array (line 158-166) — classification target
  - `src/backoff.ts:136-150` — `isAccountSpecificError()` function — entry point for 403 detection
  - `src/backoff.ts:61-95` — `extractErrorSignals()` — how `message` and `text` fields are extracted
  - `src/index.ts:610-613` — AUTH_FAILED handling that clears tokens, solving Bug 2
  - `.husky/pre-commit` — Runs `npm test` + `npx lint-staged`. Tests must pass at commit time.

  **Acceptance Criteria**:
  - [ ] Test file modified: `src/backoff.test.ts` with new membership detection tests
  - [ ] Implementation modified: `src/backoff.ts` with new signals
  - [ ] `bun test src/backoff.test.ts` → PASS (all tests including new membership cases)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: All backoff tests pass including new membership cases
    Tool: Bash
    Preconditions: Tests and implementation complete
    Steps:
      1. Run `bun test src/backoff.test.ts --reporter=verbose 2>&1`
      2. Assert exit code is 0
      3. Assert output contains "membership" test names
      4. Assert all tests pass (zero failures)
    Expected Result: Zero failures, all tests pass
    Failure Indicators: Any test failure
    Evidence: .sisyphus/evidence/task-1-backoff-tests-pass.txt

  Scenario: Signal detection is precise (no false positives)
    Tool: Bash
    Preconditions: Implementation complete
    Steps:
      1. Verify via test output that "Internal server error" 403 body does NOT trigger account-specific detection
      2. Verify "Access denied to this resource" 403 body does NOT trigger membership detection
    Expected Result: Only membership-related messages trigger detection
    Failure Indicators: Unrelated 403 bodies trigger account-specific detection
    Evidence: .sisyphus/evidence/task-1-no-false-positives.txt

  Scenario: Existing backoff tests are not regressed
    Tool: Bash
    Preconditions: Changes complete
    Steps:
      1. Run `bun test src/backoff.test.ts --reporter=verbose 2>&1`
      2. Count total tests — should be existing count + new tests
      3. Assert all pre-existing tests still pass
    Expected Result: Existing tests unchanged and passing
    Failure Indicators: Any pre-existing test fails or is missing
    Evidence: .sisyphus/evidence/task-1-no-regression.txt
  ```

  **Commit**: YES
  - Message: `fix(backoff): detect membership-benefits 403 as account-specific error`
  - Files: `src/backoff.ts`, `src/backoff.test.ts`
  - Pre-commit: `bun test src/backoff.test.ts` (must pass — hook runs full suite)

- [x] 2. Integration test for full 403→switch→refresh flow

  **What to do**:
  - Add an integration test in `index.test.ts` that simulates the complete flow:
    1. Plugin has 2 accounts loaded
    2. First request returns 403 with `{ error: { message: "We're unable to verify your membership benefits at this time." } }`
    3. Assert: error is detected as account-specific
    4. Assert: account is marked with AUTH_FAILED reason
    5. Assert: `account.access` and `account.expires` are cleared (token invalidation)
    6. Assert: plugin tries next account (or same account with fresh token)
  - Follow existing integration test patterns in `index.test.ts` (the file is 166K lines — find similar 403/rate-limit integration tests as templates)

  **Must NOT do**:
  - Do NOT modify any source files
  - Do NOT add tests that require actual Anthropic API calls

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 5, 6)
  - **Parallel Group**: Wave 2
  - **Blocks**: FINAL
  - **Blocked By**: Task 1

  **References**:
  - `index.test.ts` — Massive test file (166K, ~4000 lines). Search for `isAccountSpecificError` or `rate.limit` or `account.switch` patterns to find existing integration tests for 403/429 flows. Use these as templates for the membership error flow.
  - `src/index.ts:598-630` — The error handling loop that checks `isAccountSpecificError()`, calls `parseRateLimitReason()`, and executes account switching. This is the code path being tested.
  - `src/index.ts:610-613` — Token invalidation code: `account.access = undefined; account.expires = undefined; markTokenStateUpdated(account);` — assert these mutations happen.
  - `src/backoff.ts:136-150` — `isAccountSpecificError()` entry point being tested end-to-end.

  **Acceptance Criteria**:
  - [ ] `bun test index.test.ts` → PASS (all tests including new integration test)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Integration test verifies full 403→switch flow
    Tool: Bash
    Preconditions: Task 2 complete
    Steps:
      1. Run `bun test index.test.ts --reporter=verbose -t "membership" 2>&1`
      2. Assert the test name appears and passes
      3. Assert exit code 0
    Expected Result: Integration test passes, full flow verified
    Failure Indicators: Test failure or test not found
    Evidence: .sisyphus/evidence/task-3-integration-test-pass.txt

  Scenario: Existing index tests are not regressed
    Tool: Bash
    Preconditions: New test added
    Steps:
      1. Run `bun test index.test.ts 2>&1`
      2. Assert exit code 0
      3. Assert total test count is existing + new
    Expected Result: All existing tests still pass
    Failure Indicators: Any pre-existing test fails
    Evidence: .sisyphus/evidence/task-3-no-regression.txt
  ```

  **Commit**: YES
  - Message: `test(index): add integration test for 403 membership→switch→refresh flow`
  - Files: `index.test.ts`
  - Pre-commit: `bun test index.test.ts`

- [x] 3. Add @clack/prompts dependency and verify esbuild bundling

  **What to do**:
  - Run `bun add @clack/prompts` to add the dependency
  - Run `bun scripts/build.ts` to verify esbuild bundles without errors
  - Run `node dist/opencode-anthropic-auth-cli.mjs help` to verify bundled CLI still works
  - Record baseline bundle size: `wc -c dist/opencode-anthropic-auth-cli.mjs`
  - Verify `isCancel` symbol import works in a trivial test: add a temporary import in a test file, assert `typeof isCancel` is `"function"`
  - Check that `@clack/prompts` is NOT in the `external` array in `scripts/build.ts` (it should be bundled, not externalized)

  **Must NOT do**:
  - Do NOT use @clack/prompts in any production code yet
  - Do NOT modify the build configuration unless needed for bundling

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 4)
  - **Blocks**: Tasks 5, 6
  - **Blocked By**: None

  **References**:
  - `package.json:56-58` — Current dependencies section. Add `@clack/prompts` here.
  - `scripts/build.ts` — esbuild configuration. Check the `external` array — `@clack/prompts` should NOT be external (must be bundled). Read this file to understand the build setup.
  - `dist/opencode-anthropic-auth-cli.mjs` — The built CLI bundle output. Verify it exists after build and runs.

  **Acceptance Criteria**:
  - [ ] `@clack/prompts` in package.json dependencies
  - [ ] `bun scripts/build.ts` → exit 0
  - [ ] `node dist/opencode-anthropic-auth-cli.mjs help` → exit 0, shows help text
  - [ ] Bundle size recorded in evidence file

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: esbuild bundles successfully with @clack/prompts
    Tool: Bash
    Preconditions: @clack/prompts installed
    Steps:
      1. Run `bun scripts/build.ts 2>&1`
      2. Assert exit code 0
      3. Run `ls -la dist/opencode-anthropic-auth-cli.mjs`
      4. Assert file exists
    Expected Result: Build succeeds, bundle file exists
    Failure Indicators: Build error, missing output file
    Evidence: .sisyphus/evidence/task-4-build-success.txt

  Scenario: Bundled CLI still works
    Tool: Bash
    Preconditions: Build complete
    Steps:
      1. Run `node dist/opencode-anthropic-auth-cli.mjs help 2>&1`
      2. Assert output contains "Usage" or command list
      3. Assert exit code 0
      4. Run `wc -c dist/opencode-anthropic-auth-cli.mjs` to record size
    Expected Result: CLI help works, size documented
    Failure Indicators: Runtime error, missing output
    Evidence: .sisyphus/evidence/task-4-cli-works.txt
  ```

  **Commit**: YES
  - Message: `chore: add @clack/prompts dependency and verify esbuild bundling`
  - Files: `package.json`, `bun.lock`
  - Pre-commit: `bun scripts/build.ts`

- [x] 4. Design subcommand dispatch structure

  **What to do**:
  - Restructure the `dispatch()` function (end of `cli.ts`) to support subcommand grouping:
    ```
    oaa auth login|logout|reauth|refresh
    oaa account list|switch|enable|disable|remove|reset
    oaa usage stats|reset-stats|status
    oaa config show|strategy
    oaa manage
    oaa help
    ```
  - When called without subcommand (e.g., `oaa auth`), show that group's help
  - When called with no args at all, default to `account list` (current behavior)
  - Preserve backward compatibility: `oaa login` should still work (map to `oaa auth login`)
  - Preserve all existing short aliases (`ln`, `lo`, `ra`, `rf`, `ls`, `st`, `sw`, etc.)
  - Add subcommand-level help: `oaa auth help` shows auth-specific commands
  - Update the `cmdHelp()` function to show the grouped command structure

  **Must NOT do**:
  - Do NOT introduce a command framework library (commander, yargs, etc.) — keep hand-written dispatch
  - Do NOT change command function signatures — keep `export async function cmdXxx()`
  - Do NOT change any command implementation logic yet — only the dispatch routing

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Tasks 6, 7, 8, 9, 10
  - **Blocked By**: None

  **References**:
  - `src/cli.ts:1596-1796` — Current `dispatch()` function and `main()` entry point. The big switch statement maps command names to handler functions. Restructure this to a two-level dispatch: group → subcommand.
  - `src/cli.ts:1570-1595` — Current `cmdHelp()` function. Update to show grouped layout.
  - `src/cli.ts:1-29` — File header comment documenting all commands. Update to reflect new grouping.
  - `cli.test.ts` — Tests call `main(["node", "script", "command", ...args])`. The argv structure must stay compatible.

  **Acceptance Criteria**:
  - [ ] `bun test cli.test.ts` → PASS (backward-compatible dispatch, existing tests pass)
  - [ ] `oaa auth login` maps to `cmdLogin()`
  - [ ] `oaa login` still maps to `cmdLogin()` (backward compat)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Subcommand dispatch works
    Tool: Bash
    Preconditions: Dispatch restructured
    Steps:
      1. Run `bun test cli.test.ts --reporter=verbose 2>&1`
      2. Assert exit code 0
      3. Assert all existing tests still pass (backward compat)
    Expected Result: All tests pass with new dispatch structure
    Failure Indicators: Any test failure
    Evidence: .sisyphus/evidence/task-5-dispatch-tests.txt

  Scenario: Help shows grouped commands
    Tool: interactive_bash (tmux)
    Preconditions: Build complete
    Steps:
      1. Run the help command via test or direct invocation
      2. Verify output shows "auth", "account", "usage", "config" groups
    Expected Result: Grouped help output visible
    Failure Indicators: Flat command list instead of groups
    Evidence: .sisyphus/evidence/task-5-grouped-help.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): add subcommand dispatch structure`
  - Files: `src/cli.ts`
  - Pre-commit: `bun test cli.test.ts`

- [x] 5. Migrate cli.test.ts mocks from readline to @clack/prompts

  **What to do**:
  - Replace `vi.mock("node:readline/promises")` (cli.test.ts:114-119) with `vi.mock("@clack/prompts")`
  - Create mock functions for the @clack/prompts APIs that will be used: `text()`, `confirm()`, `select()`, `spinner()`, `intro()`, `outro()`, `log.*`, `isCancel()`
  - Mock `isCancel` to return `false` by default (normal flow), with per-test overrides for cancel tests
  - Keep the AsyncLocalStorage-based IO capture pattern for non-prompt output (account lists, stats tables) since @clack/prompts log.\* output goes through its own renderer
  - Ensure all existing test assertions still work conceptually (may need test body updates to use new mock patterns)
  - At this stage, tests may break because cli.ts still uses readline — that's expected, they'll be fixed in Tasks 7-11

  **Must NOT do**:
  - Do NOT change cli.ts source code — only change test infrastructure
  - Do NOT delete existing test cases — only update their mock setup
  - Do NOT test @clack/prompts rendering — mock it completely

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 2, 6)
  - **Parallel Group**: Wave 2
  - **Blocks**: Tasks 6, 7, 8, 9, 10
  - **Blocked By**: Task 3

  **References**:
  - `cli.test.ts:114-119` — Current `vi.mock("node:readline/promises")` mock setup. Replace this with @clack/prompts mocks.
  - `cli.test.ts:1641-1677` — The `main()` function wrapper and AsyncLocalStorage IO capture. This pattern should remain for non-prompt output testing.
  - `cli.test.ts:123-148` — Individual command function imports. These stay the same.
  - `cli.test.ts:1-120` — Test setup boilerplate including all vi.mock calls. Understand the full mock landscape.

  **Acceptance Criteria**:
  - [ ] `vi.mock("@clack/prompts")` present in cli.test.ts
  - [ ] `vi.mock("node:readline/promises")` removed (or kept only for specific backward-compat tests during migration)
  - [ ] Mock functions created for: text, confirm, select, spinner, intro, outro, log.\*, isCancel

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Test file compiles and mock structure is valid
    Tool: Bash
    Preconditions: @clack/prompts installed
    Steps:
      1. Run `bun test cli.test.ts --reporter=verbose 2>&1 | head -50`
      2. Assert no import/mock errors
      3. Some tests may fail (expected — cli.ts still uses readline)
    Expected Result: Test file loads, mocks are valid, some failures expected
    Failure Indicators: Import errors, mock setup failures
    Evidence: .sisyphus/evidence/task-6-mock-migration.txt
  ```

  **Commit**: NO (tests may fail at this stage — merge into Task 6 commit which restores green tests)

- [x] 6. Rewrite auth commands (login, logout, reauth, refresh) with @clack/prompts

  **What to do**:
  - Rewrite `cmdLogin()` (cli.ts:367-426): Replace `createInterface` + `rl.question()` with `@clack/prompts text()` for code paste. Add `intro("Anthropic OAuth Login")` and `spinner()` for token exchange. Check `isCancel()` after text prompt.
  - Rewrite `cmdLogout()` (cli.ts:436-511): Replace `rl.question` confirmation with `@clack/prompts confirm()`. Keep `--force` bypass.
  - Rewrite `cmdLogoutAll()` (cli.ts:519-561): Same confirm() pattern.
  - Rewrite `cmdReauth()` (cli.ts:568-621): Same as login pattern — text() for code, spinner() for exchange.
  - Rewrite `cmdRefresh()` (cli.ts:628-677): Add spinner() for the refresh operation. Replace console.log with `log.success()` / `log.error()`.
  - Preserve all `process.stdin.isTTY` guards (login:368, logout:463, reauth:575)
  - Replace `openBrowser()` plain log with `log.info()` for URL display
  - For all commands: replace `console.log(c.green(...))` with `log.success(...)`, `console.error(c.red(...))` with `log.error(...)`, `console.log(c.dim(...))` with `log.info(...)` or `log.message(...)`

  **Must NOT do**:
  - Do NOT change the OAuth flow logic (authorize, exchange, revoke calls)
  - Do NOT change storage operations (loadAccounts, saveAccounts)
  - Do NOT change the account data model
  - Do NOT add new features to these commands

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 2)
  - **Parallel Group**: Wave 2 (after Tasks 3, 4, 5)
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 3, 4, 5

  **References**:
  - `src/cli.ts:310-357` — `runOAuthFlow()` — the inner OAuth flow used by login/reauth. Replace readline with @clack text().
  - `src/cli.ts:367-426` — `cmdLogin()` — full login command to rewrite.
  - `src/cli.ts:436-561` — `cmdLogout()` and `cmdLogoutAll()` — confirmation prompts to rewrite.
  - `src/cli.ts:568-677` — `cmdReauth()` and `cmdRefresh()` — reauth/refresh commands.
  - `src/cli.ts:290-303` — `openBrowser()` — keep as-is, just update the surrounding log calls.
  - `cli.test.ts` — Auth command tests. Update to use @clack mocks from Task 6.

  **Acceptance Criteria**:
  - [ ] `bun test cli.test.ts` → auth command tests PASS with @clack mocks
  - [ ] No `createInterface` calls remain in auth commands
  - [ ] `isCancel()` checked after every @clack prompt

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Auth command tests pass with @clack/prompts
    Tool: Bash
    Preconditions: Tasks 4, 5, 6 complete
    Steps:
      1. Run `bun test cli.test.ts --reporter=verbose -t "login|logout|reauth|refresh" 2>&1`
      2. Assert all auth-related tests pass
      3. Assert exit code 0
    Expected Result: All auth command tests pass
    Failure Indicators: Test failures in auth commands
    Evidence: .sisyphus/evidence/task-7-auth-commands.txt

  Scenario: Non-TTY guard still rejects interactive commands
    Tool: Bash
    Preconditions: Auth commands rewritten
    Steps:
      1. Run login test with isTTY mocked to false
      2. Assert error message about interactive terminal
    Expected Result: Non-TTY rejection works as before
    Failure Indicators: Login proceeds without TTY
    Evidence: .sisyphus/evidence/task-7-tty-guard.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): migrate auth commands to @clack/prompts`
  - Files: `src/cli.ts`, `cli.test.ts`
  - Pre-commit: `bun test cli.test.ts`

- [x] 7. Rewrite account commands (list, switch, enable, disable, remove, reset) with @clack/prompts

  **What to do**:
  - Rewrite `cmdList()` (cli.ts:687-806): Replace console.log table output with `log.info()` / `log.message()`. Add `spinner()` while fetching usage quotas. Keep the existing `renderUsageLines()`, `renderBar()` helper functions for progress bars — they're reusable since they return strings.
  - Rewrite `cmdSwitch()` (cli.ts:849-879): Replace console output with `log.success()` / `log.error()`.
  - Rewrite `cmdEnable()` (cli.ts:886-916): Same pattern.
  - Rewrite `cmdDisable()` (cli.ts:923-978): Same pattern.
  - Rewrite `cmdRemove()` (cli.ts:987-1047): Replace readline confirmation with `confirm()`. Keep `--force` bypass. Check `isCancel()`.
  - Rewrite `cmdReset()` (cli.ts:1054-1099): Replace console output with `log.success()`.
  - Keep `pad()`, `rpad()`, `stripAnsi()`, `shortPath()`, `formatDuration()`, `formatTimeAgo()` helpers — they're used for formatting within the @clack log output.

  **Must NOT do**:
  - Do NOT change the rendering logic of `renderUsageLines()` or `renderBar()` — they return strings
  - Do NOT modify storage operations
  - Do NOT change `cmdStatus()` output format (handled separately in Task 9)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 8, 9, 10)
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 4, 5

  **References**:
  - `src/cli.ts:687-806` — `cmdList()` — the main account listing with usage quotas. Most complex output command.
  - `src/cli.ts:849-1099` — Switch, enable, disable, remove, reset commands. Simpler output patterns.
  - `src/cli.ts:220-284` — Usage rendering helpers (`renderBar`, `renderUsageLines`, etc.). Keep as-is.
  - `src/cli.ts:62-135` — Formatting helpers (`pad`, `rpad`, `stripAnsi`, `shortPath`, `formatDuration`, `formatTimeAgo`). Keep as-is.
  - `cli.test.ts` — Account command tests. Update assertions to match new output format.

  **Acceptance Criteria**:
  - [ ] `bun test cli.test.ts` → account command tests PASS
  - [ ] cmdList shows spinner while fetching quotas
  - [ ] cmdRemove uses @clack confirm() with isCancel check

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Account command tests pass
    Tool: Bash
    Preconditions: Tasks 5, 6 complete
    Steps:
      1. Run `bun test cli.test.ts --reporter=verbose -t "list|switch|enable|disable|remove|reset" 2>&1`
      2. Assert all account-related tests pass
    Expected Result: All account command tests pass
    Failure Indicators: Any test failure
    Evidence: .sisyphus/evidence/task-8-account-commands.txt

  Scenario: Remove command respects --force flag
    Tool: Bash
    Preconditions: Account commands rewritten
    Steps:
      1. Run remove test with force flag
      2. Assert no confirmation prompt is shown
      3. Assert account is removed
    Expected Result: --force bypasses confirmation
    Failure Indicators: Prompt appears with --force
    Evidence: .sisyphus/evidence/task-8-force-flag.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): migrate account commands to @clack/prompts`
  - Files: `src/cli.ts`, `cli.test.ts`
  - Pre-commit: `bun test cli.test.ts`

- [x] 8. Rewrite usage commands (stats, reset-stats, status) with @clack/prompts

  **What to do**:
  - Rewrite `cmdStats()` (cli.ts:1249-1330): Replace console.log table with `log.message()` output. Keep the column-formatted table structure using `pad()` / `rpad()` helpers.
  - Rewrite `cmdResetStats()` (cli.ts:1337-1366): Replace console output with `log.success()`.
  - IMPORTANT: `cmdStatus()` (cli.ts:812-842) — this produces a **scriptable one-liner** format. Do NOT add @clack intro/outro/spinners. Only replace `console.log(line)` with a plain `process.stdout.write(line + "\n")` or keep console.log as-is. The output format MUST NOT change.

  **Must NOT do**:
  - Do NOT change `cmdStatus()` output format (it's used in shell scripts/prompts)
  - Do NOT add @clack intro/outro/spinner to cmdStatus
  - Do NOT modify the stats calculation logic

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 7, 9, 10)
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 4, 5

  **References**:
  - `src/cli.ts:812-842` — `cmdStatus()` — CRITICAL: scriptable one-liner, do NOT restyle.
  - `src/cli.ts:1249-1330` — `cmdStats()` — table output with column formatting.
  - `src/cli.ts:1337-1366` — `cmdResetStats()` — simple success/error output.
  - `cli.test.ts` — Stats/status tests. Verify cmdStatus output format is unchanged.

  **Acceptance Criteria**:
  - [ ] `bun test cli.test.ts` → usage command tests PASS
  - [ ] cmdStatus output format unchanged (regex match against existing test expectations)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: cmdStatus output format is unchanged
    Tool: Bash
    Preconditions: Usage commands rewritten
    Steps:
      1. Run status command test
      2. Assert output matches pattern: "anthropic: N account(s) (N active), strategy: *, next: #N"
      3. Assert no ANSI box characters or @clack guide lines in output
    Expected Result: Scriptable one-liner format preserved
    Failure Indicators: @clack styling in status output, format change
    Evidence: .sisyphus/evidence/task-9-status-format.txt

  Scenario: Stats command tests pass
    Tool: Bash
    Preconditions: Usage commands rewritten
    Steps:
      1. Run `bun test cli.test.ts --reporter=verbose -t "stats|status" 2>&1`
      2. Assert all tests pass
    Expected Result: All usage command tests pass
    Failure Indicators: Any test failure
    Evidence: .sisyphus/evidence/task-9-usage-commands.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): migrate usage commands to @clack/prompts`
  - Files: `src/cli.ts`, `cli.test.ts`
  - Pre-commit: `bun test cli.test.ts`

- [x] 9. Rewrite config commands (config, strategy) with @clack/prompts

  **What to do**:
  - Rewrite `cmdConfig()` (cli.ts:1105-1162): Replace console.log key-value display with `log.info()` and `log.message()`. Consider using `note()` for grouped config sections (Health Score, Token Bucket, Files).
  - Rewrite `cmdStrategy()` (cli.ts:1169-1232): When showing current strategy, use `log.message()` with strategy descriptions. When changing strategy, replace the plain output with `log.success()`. The existing `select` logic uses plain arg parsing — no interactive prompt needed for the change (it takes the strategy name from argv).
  - IMPORTANT: `cmdStrategy` is NOT currently tested in `cli.test.ts` — it's not even imported. Write NEW tests for `cmdStrategy`:
    - Test: shows current strategy when called without args
    - Test: changes strategy when given valid arg
    - Test: rejects invalid strategy name
    - Test: detects when strategy is already set
    - Export `cmdStrategy` from `src/cli.ts` and import it in `cli.test.ts`

  **Must NOT do**:
  - Do NOT add interactive strategy selection via @clack select() — current UX is `strategy <name>` from argv
  - Do NOT modify the actual config save/load logic

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 7, 8, 10)
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 4, 5

  **References**:
  - `src/cli.ts:1105-1162` — `cmdConfig()` — key-value config display. Tests for this command exist in cli.test.ts (imported at line 124).
  - `src/cli.ts:1169-1232` — `cmdStrategy()` — strategy display and change. **NOT imported or tested in cli.test.ts** — must add import and write new tests.
  - `src/config.ts:124` — `VALID_STRATEGIES` array used by strategy command.
  - `cli.test.ts:124` — Imports list. `cmdConfig` is imported. `cmdStrategy` is missing — add it.
  - `cli.test.ts:684-689` — Existing `cmdList` test that mentions "strategy" in output — this is NOT a cmdStrategy test, just a cmdList test checking strategy appears in listing output.

  **Acceptance Criteria**:
  - [ ] `cmdStrategy` exported from `src/cli.ts` and imported in `cli.test.ts`
  - [ ] New tests written for `cmdStrategy` (4+ test cases)
  - [ ] `bun test cli.test.ts` → config and strategy command tests PASS

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Config and new strategy tests pass
    Tool: Bash
    Preconditions: Config commands rewritten, new strategy tests added
    Steps:
      1. Run `bun test cli.test.ts --reporter=verbose -t "config|strategy" 2>&1`
      2. Assert config tests pass
      3. Assert new strategy tests pass (4+ test cases)
      4. Assert no skipped tests
    Expected Result: All config + strategy command tests pass
    Failure Indicators: Any test failure, missing strategy tests
    Evidence: .sisyphus/evidence/task-10-config-commands.txt

  Scenario: cmdStrategy is properly exported
    Tool: Bash
    Preconditions: Export added
    Steps:
      1. Run `grep "cmdStrategy" cli.test.ts`
      2. Assert import line exists
    Expected Result: cmdStrategy imported in test file
    Failure Indicators: Import missing
    Evidence: .sisyphus/evidence/task-10-strategy-export.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): migrate config commands to @clack/prompts`
  - Files: `src/cli.ts`, `cli.test.ts`
  - Pre-commit: `bun test cli.test.ts`

- [x] 10. Rewrite manage interactive loop with @clack/prompts

  **What to do**:
  - Rewrite `cmdManage()` (cli.ts:1376-1565): This is the most complex command — a while(true) loop with readline-based free-text command parsing.
  - Design: Replace the free-text `rl.question("> ")` with `@clack/prompts select()` showing options: Switch, Enable, Disable, Remove, Reset, Strategy, Quit.
  - When user selects an action that needs a target (switch/enable/disable/remove/reset), follow up with another `select()` listing the accounts.
  - The strategy sub-flow (current `rl.question("New strategy: ")`) should use `select()` from `VALID_STRATEGIES`.
  - Remove confirmation should use `confirm()`.
  - After each action, loop back to the main select. Check `isCancel()` after every prompt — treat cancel as "quit".
  - Keep the `process.stdin.isTTY` guard at the top (line 1384).
  - IMPORTANT: Rename the local variable `confirm` at line 1520 to `removeConfirm` to avoid shadowing the @clack import.
  - Re-read from disk each iteration (existing pattern at line 1395) — keep this.
  - IMPORTANT: `cmdManage` is NOT currently tested in `cli.test.ts` — it's not even imported. Write NEW tests:
    - Export `cmdManage` from `src/cli.ts` and import in `cli.test.ts`
    - Test: non-TTY rejection (isTTY = false → exit 1)
    - Test: no accounts configured → shows message and exits
    - Test: quit action exits loop cleanly
    - Test: switch action changes active index
    - Test: enable/disable toggle works
    - Test: remove action with confirm
    - Test: isCancel exits loop gracefully
    - Mock `@clack/prompts select()` to return action values, `confirm()` to return true/false

  **Must NOT do**:
  - Do NOT add new management actions beyond the existing s/e/d/r/R/t/q
  - Do NOT change the underlying storage operations
  - Do NOT build a generic loop abstraction — just use a while(true) + select pattern

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 7, 8, 9)
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 11
  - **Blocked By**: Tasks 4, 5

  **References**:
  - `src/cli.ts:1376-1565` — `cmdManage()` — the full interactive management loop. 190 lines of readline-based interaction to replace with @clack/prompts.
  - `src/cli.ts:1393-1399` — Disk re-read pattern at top of loop. Keep this.
  - `src/cli.ts:1520` — `const confirm = await rl.question(...)` — MUST rename to `removeConfirm` to avoid @clack import shadow.
  - `src/cli.ts:1384-1388` — `process.stdin.isTTY` guard. Keep this.
  - `src/config.ts:124` — `VALID_STRATEGIES` for strategy selection.
  - `cli.test.ts:120-148` — Imports list. `cmdManage` is **NOT imported** — must add the import. (Line 1500 mentions "manage" but only in a `cmdHelp` test checking help text, NOT a cmdManage test.)

  **Acceptance Criteria**:
  - [ ] `cmdManage` exported from `src/cli.ts` and imported in `cli.test.ts`
  - [ ] New tests written for `cmdManage` (7+ test cases covering all actions + edge cases)
  - [ ] `bun test cli.test.ts` → manage command tests PASS
  - [ ] No `createInterface` calls remain in cmdManage
  - [ ] `isCancel()` checked after every @clack prompt in the loop
  - [ ] Variable `confirm` renamed to `removeConfirm`

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: New manage command tests pass with @clack
    Tool: Bash
    Preconditions: Tasks 5, 6 complete, new tests written
    Steps:
      1. Run `bun test cli.test.ts --reporter=verbose -t "manage" 2>&1`
      2. Assert 7+ manage tests are listed
      3. Assert all manage tests pass
    Expected Result: All new manage command tests pass
    Failure Indicators: Tests missing, any test failure
    Evidence: .sisyphus/evidence/task-11-manage-command.txt

  Scenario: cmdManage is properly exported and imported
    Tool: Bash
    Preconditions: Export and import added
    Steps:
      1. Run `grep "cmdManage" cli.test.ts`
      2. Assert import line exists
    Expected Result: cmdManage imported in test file
    Failure Indicators: Import missing
    Evidence: .sisyphus/evidence/task-11-manage-export.txt

  Scenario: Cancel (isCancel) exits the manage loop
    Tool: Bash
    Preconditions: Manage rewritten with new tests
    Steps:
      1. Run manage test with isCancel mock returning true on first prompt
      2. Assert command exits cleanly with code 0
    Expected Result: Ctrl+C exits manage gracefully
    Failure Indicators: Loop continues after cancel, error thrown
    Evidence: .sisyphus/evidence/task-11-cancel-exit.txt

  Scenario: Non-TTY rejection still works
    Tool: Bash
    Preconditions: Manage rewritten with new tests
    Steps:
      1. Run manage test with isTTY = false
      2. Assert error message about interactive terminal
      3. Assert exit code 1
    Expected Result: Non-TTY rejection preserved
    Failure Indicators: Manage proceeds without TTY
    Evidence: .sisyphus/evidence/task-11-tty-guard.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): migrate manage interactive loop to @clack/prompts`
  - Files: `src/cli.ts`, `cli.test.ts`
  - Pre-commit: `bun test cli.test.ts`

- [x] 11. Add short alias + update help + cleanup legacy helpers

  **What to do**:
  - Add `"oaa"` to the `bin` field in `package.json` pointing to the same CLI entry: `"oaa": "./dist/opencode-anthropic-auth-cli.mjs"`
  - Update `cmdHelp()` to show the grouped subcommand structure:

    ```
    Anthropic Multi-Account Auth CLI

    Usage:
      oaa <command> [subcommand] [args]
      opencode-anthropic-auth <command> [subcommand] [args]

    Commands:
      auth     login, logout, reauth, refresh
      account  list, switch, enable, disable, remove, reset
      usage    stats, reset-stats, status
      config   show, strategy
      manage   Interactive account management

    Run 'oaa <command> help' for subcommand details.
    ```

  - Remove the `createInterface` import from `node:readline/promises` if no longer used anywhere in cli.ts
  - Remove unused color helpers from `c.*` object if @clack/prompts log.\* fully replaces them (but keep if still used by `renderBar()`, `renderUsageLines()`, or table formatting)
  - Verify `--no-color` flag compatibility: when `NO_COLOR` env var is set, @clack/prompts auto-disables colors. Ensure the `USE_COLOR` flag also gates remaining `c.*` usage.
  - Update the file header comment (cli.ts:1-29) to reflect the new grouped command structure

  **Must NOT do**:
  - Do NOT change the binary name `opencode-anthropic-auth` — only ADD the alias
  - Do NOT add new commands or features
  - Do NOT remove formatting helpers still in use by rendering functions

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (after all command migrations)
  - **Blocks**: Task 12
  - **Blocked By**: Tasks 6, 7, 8, 9, 10

  **References**:
  - `package.json:6-7` — Current `bin` field with only `opencode-anthropic-auth`. Add `oaa` entry.
  - `src/cli.ts:1570-1595` — `cmdHelp()` function. Rewrite to show grouped layout.
  - `src/cli.ts:1-29` — File header comment. Update to reflect grouping.
  - `src/cli.ts:31-57` — Color helpers and imports. Remove unused ones.

  **Acceptance Criteria**:
  - [ ] `"oaa"` in package.json bin field
  - [ ] `bun test cli.test.ts` → PASS
  - [ ] No unused imports or dead code from readline migration
  - [ ] Help output shows grouped commands

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Short alias registered in package.json
    Tool: Bash
    Preconditions: package.json updated
    Steps:
      1. Run `cat package.json | grep -A2 '"bin"'`
      2. Assert output contains "oaa"
      3. Assert output still contains "opencode-anthropic-auth"
    Expected Result: Both binary names present
    Failure Indicators: Missing oaa or missing opencode-anthropic-auth
    Evidence: .sisyphus/evidence/task-12-alias.txt

  Scenario: All CLI tests pass after cleanup
    Tool: Bash
    Preconditions: Cleanup complete
    Steps:
      1. Run `bun test cli.test.ts --reporter=verbose 2>&1`
      2. Assert exit code 0
      3. Assert no skipped or todo tests
    Expected Result: Full test suite passes
    Failure Indicators: Any failure or regression
    Evidence: .sisyphus/evidence/task-12-final-tests.txt
  ```

  **Commit**: YES
  - Message: `feat(cli): add oaa alias, update help, cleanup legacy helpers`
  - Files: `package.json`, `src/cli.ts`
  - Pre-commit: `bun test cli.test.ts`

- [x] 12. Bundle verification + isCancel test + size audit

  **What to do**:
  - Run full build: `bun scripts/build.ts`
  - Verify bundled CLI runs: `node dist/opencode-anthropic-auth-cli.mjs help` — assert exit 0 and grouped help output
  - Verify bundled CLI with subcommand: `node dist/opencode-anthropic-auth-cli.mjs auth help` — assert shows auth subcommands
  - Verify `isCancel` works at runtime in the bundle: Run multiple non-interactive bundled CLI commands (`account list`, `config show`, `help`) to confirm the bundle loads without Symbol/isCancel errors. This guards against the known @clack/prompts issue #470 where Symbol comparisons break when bundled.
  - Record final bundle size: `wc -c dist/opencode-anthropic-auth-cli.mjs` and compare against Task 4 baseline
  - Run the full test suite one final time: `bun test` — assert zero failures
  - If bundle size increased >100KB compared to baseline, flag in evidence as a note (not a blocker)

  **Must NOT do**:
  - Do NOT fix bundle size issues — only document them
  - Do NOT modify source code — this is a verification-only task

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (after Task 12)
  - **Blocks**: FINAL
  - **Blocked By**: Task 11

  **References**:
  - `scripts/build.ts` — esbuild configuration. Read to understand what gets bundled.
  - `dist/opencode-anthropic-auth-cli.mjs` — Built CLI output to verify.
  - `.sisyphus/evidence/task-4-cli-works.txt` — Baseline bundle size from Task 4.

  **Acceptance Criteria**:
  - [ ] `bun scripts/build.ts` → exit 0
  - [ ] `node dist/opencode-anthropic-auth-cli.mjs help` → exit 0, shows grouped subcommands
  - [ ] `bun test` → all tests pass (full suite)
  - [ ] Bundle size documented
  - [ ] Bundled CLI runs non-interactive commands without Symbol/isCancel errors

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Full build and verification
    Tool: Bash
    Preconditions: All tasks 1-12 complete
    Steps:
      1. Run `bun scripts/build.ts 2>&1` — assert exit 0
      2. Run `node dist/opencode-anthropic-auth-cli.mjs help 2>&1` — assert shows grouped commands
      3. Run `node dist/opencode-anthropic-auth-cli.mjs auth help 2>&1` — assert shows auth subcommands
      4. Run `wc -c dist/opencode-anthropic-auth-cli.mjs` — record size
      5. Compare size against task-4 baseline
    Expected Result: Build succeeds, CLI runs, size documented
    Failure Indicators: Build failure, runtime error, help missing groups
    Evidence: .sisyphus/evidence/task-13-bundle-verification.txt

  Scenario: Full test suite passes
    Tool: Bash
    Preconditions: All source changes complete
    Steps:
      1. Run `bun test --reporter=verbose 2>&1`
      2. Assert exit code 0
      3. Count total tests passed
    Expected Result: Zero failures across entire test suite
    Failure Indicators: Any test failure
    Evidence: .sisyphus/evidence/task-13-full-suite.txt

  Scenario: Bundled CLI loads and runs without isCancel/Symbol errors
    Tool: Bash
    Preconditions: Bundle built
    Steps:
      1. Run `node dist/opencode-anthropic-auth-cli.mjs account list 2>&1` (non-interactive command that exercises the bundled module loading)
      2. Assert no runtime errors containing "Symbol" or "isCancel" or "Cannot read properties"
      3. Assert the command produces output (even if "no accounts" message) without crashing
      4. Run `node dist/opencode-anthropic-auth-cli.mjs config show 2>&1` as a second non-interactive command
      5. Assert clean execution (exit 0 or 1 with proper error, no Symbol crash)
    Expected Result: Bundle loads cleanly, no Symbol/isCancel runtime errors — @clack/prompts internals work when bundled
    Failure Indicators: Crash with Symbol-related error, isCancel type error, module resolution failure
    Evidence: .sisyphus/evidence/task-13-iscancel-bundle.txt
  ```

  **Commit**: NO (verification-only task — no source changes)

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [ ] F1. **Plan Compliance Audit** — `oracle`
      Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
      Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
      Run `bun test` + linter. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names. Verify @clack/prompts `isCancel()` is checked after every prompt call.
      Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high`
      Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (CLI subcommands, help text, --no-color). Test edge cases: Ctrl+C during prompts, non-TTY mode, --force flag. Save to `.sisyphus/evidence/final-qa/`.
      Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
      For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Verify no modifications to storage.ts, config.ts, oauth.ts, accounts.ts, token-refresh.ts. Flag unaccounted changes.
      Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Commit | Message                                                                    | Files                                   | Pre-commit                         |
| ------ | -------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------- |
| 1      | `fix(backoff): detect membership-benefits 403 as account-specific error`   | `src/backoff.ts`, `src/backoff.test.ts` | `bun test src/backoff.test.ts`     |
| 2      | `test(index): add integration test for 403 membership→switch→refresh flow` | `index.test.ts`                         | `bun test index.test.ts`           |
| 3      | `chore: add @clack/prompts dependency and verify esbuild bundling`         | `package.json`, `bun.lock`              | `bun scripts/build.ts`             |
| 4      | `refactor(cli): add subcommand dispatch structure`                         | `src/cli.ts`                            | `bun test cli.test.ts`             |
| 5+6    | `refactor(cli): migrate auth commands + test mocks to @clack/prompts`      | `src/cli.ts`, `cli.test.ts`             | `bun test cli.test.ts`             |
| 7      | `refactor(cli): migrate account commands to @clack/prompts`                | `src/cli.ts`, `cli.test.ts`             | `bun test cli.test.ts`             |
| 8      | `refactor(cli): migrate usage commands to @clack/prompts`                  | `src/cli.ts`, `cli.test.ts`             | `bun test cli.test.ts`             |
| 9      | `refactor(cli): migrate config commands + add strategy tests`              | `src/cli.ts`, `cli.test.ts`             | `bun test cli.test.ts`             |
| 10     | `refactor(cli): migrate manage loop + add manage tests`                    | `src/cli.ts`, `cli.test.ts`             | `bun test cli.test.ts`             |
| 11     | `feat(cli): add oaa alias, update help, cleanup legacy helpers`            | `package.json`, `src/cli.ts`            | `bun test cli.test.ts`             |
| —      | (Task 12: verification only, no commit)                                    | —                                       | `bun scripts/build.ts && bun test` |

---

## Success Criteria

### Verification Commands

```bash
bun test                          # Expected: all tests pass
bun test src/backoff.test.ts      # Expected: membership signal tests pass
bun test cli.test.ts              # Expected: all CLI tests pass with @clack mocks
bun scripts/build.ts              # Expected: exit 0, bundle built
node dist/opencode-anthropic-auth-cli.mjs help     # Expected: shows grouped subcommands
node dist/opencode-anthropic-auth-cli.mjs auth help # Expected: shows auth subcommands
wc -c dist/opencode-anthropic-auth-cli.mjs         # Expected: documented size
```

### Final Checklist

- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] Bundle builds and runs
- [ ] isCancel works in bundle
- [ ] --no-color flag works
- [ ] cmdStatus one-liner format unchanged
