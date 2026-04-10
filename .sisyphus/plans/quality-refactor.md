# Quality Sweep & Refactor — opencode-anthropic-fix

## TL;DR

> **Quick Summary**: Complete quality overhaul of the opencode-anthropic-fix plugin — fix debug output leaking, eliminate silent error swallowing, decompose the 890-line index.ts, harden proxy lifecycle, fix regex bugs, clean up unbounded state growth, verify system prompt against CC source, and add tests for everything changed.
>
> **Deliverables**:
>
> - Debug output properly gated behind `config.debug` across all modules including subprocess
> - All silent `catch(() => {})` replaced with logged errors
> - `index.ts` decomposed into focused modules (~300 lines each)
> - Proxy lifecycle hardened with timeouts, signal handling, cleanup
> - Sanitization regex bugs fixed (word boundaries)
> - Unbounded state growth capped (fileAccountMap, pendingSlashOAuth, statsDeltas)
> - CC system prompt structure verified against source
> - Debug dump to /tmp removed
> - Tests covering all changed behavior
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 4 waves
> **Critical Path**: Task 1 (baseline) → Task 2-5 (debug/error fixes) → Task 6-8 (decomposition) → Task 9-14 (hardening/regex/state) → Task 15 (CC verification) → Task 16 (tests) → Final verification

---

## Context

### Original Request

Fix debug output leaking when `debug: false`. Do a complete quality check and code review. Refactor the code for proper behavior. Include unfixed gaps from the prior session. Verify system prompt against Claude Code's actual source.

### Interview Summary

**Key Discussions**:

- **Scope**: Full aggressive sweep — fix everything, defer nothing
- **Decompose index.ts**: YES — extract helpers into separate modules
- **Test strategy**: Tests-after (vitest exists, preserve existing tests)
- **Prior session gaps**: Include documented-but-unimplemented fixes
- **CC system prompt**: Extract from CC source and verify plugin's accuracy
- **User on Metis conservatism**: "Too conservative. This is a major revamp."

### Research Findings

- **Debug leak root cause**: `bun-fetch.ts` (6 ungated console.error) and `bun-proxy.ts` (5 ungated console.error) — these files were added recently without threading the debug flag
- **bun-proxy.ts constraint**: Runs as separate Bun subprocess with zero access to plugin config — needs env var mechanism
- **Silent error swallowing**: 6 confirmed QS-ERR-01 violations across accounts.ts, token-refresh.ts, index.ts, body.ts, metadata.ts
- **CC system prompt**: Full prompt is embedded in CC's compiled binary, not in open-source repo. Binary analysis already performed in `.omc/research/cch-source-analysis.md`
- **CC tool prefix**: CC uses `mcp__<server>__<tool>` (double underscore), plugin uses `mcp_` (single) — needs investigation
- **cache_control stripping**: Intentional design choice (documented in normalize.ts:75-79) — preserve, don't "fix"
- **Prior session comparison doc** (`.omc/research/cc-vs-plugin-comparison.md`): All headers, betas, billing format match CC 2.1.98 ✅

### Metis Review

**Identified Gaps** (addressed — expanded beyond Metis's conservative scope):

- Decomposition ordering: Do bug fixes first in current structure, THEN decompose (pure structural move)
- bun-proxy.ts debug: Needs env var mechanism, not just `debugLog()` wrapper
- cache_control stripping: Confirmed intentional — NOT a bug
- `cc_entrypoint` default: CC uses `"unknown"`, plugin uses `"cli"` — minor discrepancy to fix
- `cc_workload` field: CC includes AsyncLocalStorage workload tracking — plugin omits (acceptable)
- Tool prefix `mcp_` vs `mcp__`: Needs verification during execution

---

## Work Objectives

### Core Objective

Transform the plugin from "shipped fast with debug residue" to production-quality code with proper logging, error handling, architecture, and verified CC mimicry.

### Priority Ordering (CRITICAL — follow this sequence)

**Phase A — Fix broken behavior first:**

- Debug output leaking when it shouldn't (Tasks 2-4)
- Silent error swallowing hiding real problems (Task 5)
- Proxy not shutting down properly — validate and fix (Task 12, expanded)
- Debug dump writing to /tmp on every request (Task 4)

**Phase B — Code quality refactor after behavior is correct:**

- Decompose index.ts into focused modules (Tasks 6-8)
- Fix regex bugs, billing edge cases (Tasks 9-10)
- Harden proxy lifecycle with timeout (Task 11)
- Cap unbounded state growth (Task 13)
- Verify tool prefix and CC system prompt alignment (Tasks 14-15)
- Add tests (Task 16)

The wave structure reflects this: Wave 1 = behavior fixes, Wave 2+ = quality.

### Concrete Deliverables

- All console output gated behind debug flag (config or env var)
- 6 silent error catches replaced with proper logging
- `index.ts` split into 3-4 focused modules
- Proxy subprocess gets debug flag via env var
- Debug request dump to /tmp removed or gated
- Sanitization regex hardened with word boundaries
- Unbounded Maps/Sets capped with cleanup
- CC system prompt block structure verified against source analysis
- Tool prefix convention verified against CC behavior
- `cc_entrypoint` default corrected to match CC
- Tests for all changed behavior

### Definition of Done

- [ ] `npx vitest run` — all tests pass (baseline count + new tests)
- [ ] `npx tsc --noEmit` — same or fewer type errors than baseline
- [ ] `npm run build` — builds successfully, produces 3 dist artifacts
- [ ] No `console.error`/`console.log` in src/ that isn't gated by debug check (except CLI user output and IPC)
- [ ] No `catch(() => {})` or `catch { }` without at least a debugLog call
- [ ] `index.ts` significantly reduced from 890 lines (guideline: under 500, but quality over LOC — don't sacrifice readability for a number)
- [ ] All `/tmp/opencode-*` debug dumps removed or gated
- [ ] Proxy subprocess is killed on parent exit (verified via signal tests)

### Must Have

- Debug output gated across ALL modules
- Silent error swallowing eliminated
- index.ts decomposed
- Proxy lifecycle hardened with timeout
- CC system prompt structure verified

### Must NOT Have (Guardrails)

- Do NOT change function signatures during decomposition — pure move only
- Do NOT introduce a `PluginContext` class or state management redesign
- Do NOT change the closure-based state pattern — extract functions, not state ownership
- Do NOT modify refresh-lock.ts error handling — its catches are correctly structured
- Do NOT "fix" cache_control stripping — it's intentional (normalize.ts:75-79)
- Do NOT change the hardcoded proxy port without migration path
- Do NOT add speculative abstractions — solve known problems only
- Do NOT backfill tests for existing untested code — test only changed behavior

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES (vitest, 15 test files, 5000+ lines)
- **Automated tests**: Tests-after
- **Framework**: vitest
- **Baseline**: Capture `npx vitest run` output BEFORE any changes

### QA Policy

Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Module changes**: Use Bash — `npx vitest run` + `npx tsc --noEmit`
- **Debug gating**: Use Bash — grep for ungated console calls, run with debug env vars
- **Proxy lifecycle**: Use Bash (tmux) — spawn proxy, verify output, kill, verify cleanup
- **Build verification**: Use Bash — `npm run build` + check dist/ artifacts

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1a (Foundation — baseline):
└── Task 1: Capture test baseline                           [quick]

Wave 1b (Behavior fixes — after baseline):
├── Task 2: Gate debug output in bun-fetch.ts               [quick]  ──┐
├── Task 4: Remove/gate debug dump to /tmp                  [quick]  ──┘ SERIAL (same file: bun-fetch.ts)
├── Task 3: Gate debug output in bun-proxy.ts (env var)     [quick]    (parallel with 2+4)
└── Task 5: Fix silent error swallowing (6 violations)      [unspecified-high] (parallel with 2+4, 3)

NOTE: Tasks 2 and 4 MUST run serially (both edit bun-fetch.ts).
      Tasks 3 and 5 can run in parallel with each other and with 2→4.

Wave 2 (Decomposition — pure structural moves):
├── Task 6: Extract refresh helpers from index.ts           [deep]   ──┐
├── Task 7: Extract plugin helpers from index.ts            [deep]   ──┘ SERIAL (same file: index.ts)
└── Task 8: Clean up residual index.ts                      [quick]  (after 6→7)

NOTE: Tasks 6 and 7 MUST run serially (both edit index.ts).
      Task 6 first, then Task 7 operates on the already-modified index.ts.

Wave 3 (Hardening + correctness — all independent):
├── Task 9: Fix sanitization regex word boundaries          [quick]
├── Task 10: Fix cc_entrypoint default + billing edge cases [quick]
├── Task 11: Add upstream timeout to bun-proxy fetch        [quick]
├── Task 12: Validate & fix proxy shutdown lifecycle        [deep]
├── Task 13: Cap unbounded state growth                     [unspecified-high]
├── Task 14: Verify tool prefix convention against CC       [quick]
└── Task 17: Tighten ESLint + enforce zero warnings/errors  [unspecified-high]

Wave 4 (Verification + tests):
├── Task 15: Verify system prompt against CC source         [deep]
└── Task 16: Add tests for all changed behavior             [unspecified-high]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit                          [oracle]
├── Task F2: Code quality review                            [unspecified-high]
├── Task F3: Real manual QA                                 [unspecified-high]
└── Task F4: Scope fidelity check                           [deep]
-> Present results -> Get explicit user okay

Critical Path: T1 → T2-5 → T6-8 → T9-14,17 → T15-16 → F1-F4 → user okay
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 5 (Wave 1) or 7 (Wave 3)
```

### Dependency Matrix

| Task  | Depends On | Blocks | Serial Constraint          |
| ----- | ---------- | ------ | -------------------------- |
| 1     | —          | 2-17   | —                          |
| 2     | 1          | 4      | bun-fetch.ts → T4 after T2 |
| 3     | 1          | 6      | — (parallel with 2,5)      |
| 4     | 2          | 6      | bun-fetch.ts (after T2)    |
| 5     | 1          | 6      | — (parallel with 2,3)      |
| 6     | 3,4,5      | 7      | index.ts → T7 after T6     |
| 7     | 6          | 8      | index.ts (after T6)        |
| 8     | 7          | 9-17   | —                          |
| 9     | 8          | 16     | —                          |
| 10    | 8          | 16     | —                          |
| 11    | 8          | 16     | —                          |
| 12    | 8          | 16     | —                          |
| 13    | 8          | 16     | —                          |
| 14    | 8          | 16     | —                          |
| 15    | 8          | 16     | —                          |
| 16    | 9-15,17    | F1-F4  | —                          |
| 17    | 8          | 16     | —                          |
| F1-F4 | 16         | —      | —                          |

### Agent Dispatch Summary

- **Wave 1**: **5 tasks** — T1 `quick`, T2 `quick`, T3 `quick`, T4 `quick`, T5 `unspecified-high`
- **Wave 2**: **3 tasks** — T6 `deep`, T7 `deep`, T8 `quick`
- **Wave 3**: **7 tasks** — T9-11,14 `quick`, T12 `deep`, T13 `unspecified-high`, T17 `unspecified-high`
- **Wave 4**: **2 tasks** — T15 `deep`, T16 `unspecified-high`
- **FINAL**: **4 tasks** — F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

---

## TODOs

- [x] 1. Capture Test Baseline

  **What to do**:
  - Run `npx vitest run` and record exact pass/fail counts
  - Run `npx tsc --noEmit` and record current type errors (the LSP already shows ~150 in index.test.ts — these are pre-existing)
  - Run `npm run build` and verify 3 dist artifacts exist
  - Save all output as baseline evidence

  **Must NOT do**:
  - Do NOT fix any pre-existing test failures or type errors — just record them

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — must complete first
  - **Blocks**: Tasks 2-16
  - **Blocked By**: None

  **References**:
  - `package.json` — test/build scripts
  - `index.test.ts` — main test file (has pre-existing type errors, that's expected)
  - `src/__tests__/` — additional test files

  **Acceptance Criteria**:
  - [ ] Baseline test count recorded in evidence file
  - [ ] Build output recorded

  **QA Scenarios**:

  ```
  Scenario: Record test baseline
    Tool: Bash
    Steps:
      1. Run `npx vitest run 2>&1` — capture full output
      2. Run `npx tsc --noEmit 2>&1 | tail -5` — capture error summary
      3. Run `npm run build 2>&1` — capture build result
      4. Run `ls -la dist/` — verify artifacts
    Expected Result: All outputs saved, baseline numbers recorded
    Evidence: .sisyphus/evidence/task-1-baseline.txt
  ```

  **Commit**: NO (evidence only)

- [x] 2. Gate Debug Output in bun-fetch.ts

  **What to do**:
  - Accept `debug` boolean parameter in `ensureBunProxy()` and `fetchViaBun()` — thread it from the plugin's `config.debug`
  - Gate ALL 6 `console.error` calls (lines 159, 175, 176, 202, 206, 216) behind the debug flag
  - Exception: line 202 WARNING about falling back to Node.js fetch — keep this one as it's a user-visible degradation warning, but downgrade to single line
  - Pass `debug` flag to `spawnProxy()` calls so it can set `OPENCODE_ANTHROPIC_DEBUG` env var on the child process (needed for Task 3)

  **Must NOT do**:
  - Do NOT make debug a module-level variable — pass it as parameter
  - Do NOT change the proxy spawn logic beyond adding the env var

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 3, 5 — but NOT Task 4)
  - **Parallel Group**: Wave 1b (parallel with 3 and 5)
  - **Blocks**: Task 4 (same file: bun-fetch.ts — Task 4 runs AFTER Task 2)
  - **Blocked By**: Task 1

  **References**:
  - `src/bun-fetch.ts:148-260` — `ensureBunProxy()` and `fetchViaBun()` are the public API; callers in `src/index.ts` have access to `config.debug`
  - `src/index.ts:134-137` — `debugLog()` pattern to follow (stderr, `[opencode-anthropic-auth]` prefix)
  - `src/bun-fetch.ts:100-103` — `spawn()` call where env var should be set via `env: { ...process.env, OPENCODE_ANTHROPIC_DEBUG: debug ? "1" : "0" }`

  **Acceptance Criteria**:
  - [ ] `npx vitest run` passes (same count as baseline)
  - [ ] `grep -n 'console\.\(log\|error\)' src/bun-fetch.ts` shows zero ungated calls (except the degradation warning)

  **QA Scenarios**:

  ```
  Scenario: No debug output when debug=false
    Tool: Bash
    Steps:
      1. grep -c 'console\.\(log\|error\)' src/bun-fetch.ts
      2. Verify all remaining console calls are inside `if (debug)` blocks or are the degradation warning
    Expected Result: 0-1 ungated console calls (only degradation warning)
    Evidence: .sisyphus/evidence/task-2-grep-output.txt

  Scenario: Debug output when debug=true
    Tool: Bash
    Steps:
      1. Read the modified bun-fetch.ts
      2. Verify debug parameter is threaded through ensureBunProxy → spawnProxy → env var
      3. Verify fetchViaBun accepts and uses debug parameter
    Expected Result: Debug flag properly threaded, all logging gated
    Evidence: .sisyphus/evidence/task-2-code-review.txt
  ```

  **Commit**: YES
  - Message: `fix: gate debug output in bun-fetch.ts behind config.debug`
  - Files: `src/bun-fetch.ts`, `src/index.ts` (caller update)
  - Pre-commit: `npx vitest run`

- [x] 3. Gate Debug Output in bun-proxy.ts via Environment Variable

  **What to do**:
  - Read `OPENCODE_ANTHROPIC_DEBUG` env var at startup (set by parent in Task 2)
  - Gate the request logging block (lines 26-45 — the `=== /v1/messages REQUEST ===` dump) behind `process.env.OPENCODE_ANTHROPIC_DEBUG === "1"`
  - Keep `console.log(\`BUN_PROXY_PORT=${server.port}\`)` on line 71 UNGATED — it's IPC, not debug
  - Keep error response logging (the catch block on line 64-67) UNGATED — actual errors should always be visible

  **Must NOT do**:
  - Do NOT import any modules from the main plugin — bun-proxy.ts is standalone
  - Do NOT change the proxy's HTTP behavior

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 4, 5)
  - **Blocks**: Tasks 6, 7
  - **Blocked By**: Task 1

  **References**:
  - `src/bun-proxy.ts:26-45` — the request logging block to gate
  - `src/bun-proxy.ts:71` — IPC output, must remain ungated
  - `src/bun-fetch.ts:100-103` — where parent passes env var to child (modified in Task 2)

  **Acceptance Criteria**:
  - [ ] `npm run build` succeeds (bun-proxy.mjs built)
  - [ ] Request logging block wrapped in `if (process.env.OPENCODE_ANTHROPIC_DEBUG === "1")`

  **QA Scenarios**:

  ```
  Scenario: Request logging gated by env var
    Tool: Bash
    Steps:
      1. Read src/bun-proxy.ts
      2. Verify lines 26-45 (request dump) are inside env var check
      3. Verify line 71 (BUN_PROXY_PORT IPC) is NOT gated
      4. Run `npm run build` — verify bun-proxy.mjs is produced
    Expected Result: Only IPC line remains ungated
    Evidence: .sisyphus/evidence/task-3-proxy-review.txt
  ```

  **Commit**: YES
  - Message: `fix: gate debug output in bun-proxy.ts via DEBUG env var`
  - Files: `src/bun-proxy.ts`
  - Pre-commit: `npm run build`

- [x] 4. Remove Ungated Debug Dump to /tmp

  **What to do**:
  - Remove or gate the request/header dump block in `bun-fetch.ts:208-218` that writes to `/tmp/opencode-last-request.json` and `/tmp/opencode-last-headers.json` on EVERY `/v1/messages` request
  - This is debug instrumentation that was left in from the development session — it writes full request bodies to disk ungated
  - Gate behind `debug` parameter: only dump when debug is true
  - Security concern: this dumps authorization headers (redacted) and full request bodies to world-readable /tmp

  **Must NOT do**:
  - Do NOT remove the entire fetchViaBun function — only the dump block

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — same file as Task 2 (bun-fetch.ts)
  - **Parallel Group**: Wave 1b (runs AFTER Task 2 completes)
  - **Blocks**: Task 6
  - **Blocked By**: Task 2 (same file serialization)

  **References**:
  - `src/bun-fetch.ts:208-218` — the dump block: `writeFileSync("/tmp/opencode-last-request.json", ...)` and `writeFileSync("/tmp/opencode-last-headers.json", ...)`
  - QS-SEC-08: "Logs MUST NOT contain secrets, credentials, or PII"

  **Acceptance Criteria**:
  - [ ] No writes to `/tmp/opencode-*` unless `debug` is true
  - [ ] `grep -n '/tmp/opencode' src/bun-fetch.ts` shows calls inside debug guard

  **QA Scenarios**:

  ```
  Scenario: No /tmp dump when debug=false
    Tool: Bash
    Steps:
      1. Read src/bun-fetch.ts
      2. Verify writeFileSync calls to /tmp are inside `if (debug)` block
      3. Verify no other ungated file writes exist
    Expected Result: All /tmp writes gated behind debug flag
    Evidence: .sisyphus/evidence/task-4-tmp-dump.txt
  ```

  **Commit**: YES (grouped with Task 2)
  - Message: `fix: gate /tmp debug dump behind config.debug`
  - Files: `src/bun-fetch.ts`
  - Pre-commit: `npx vitest run`

- [x] 5. Fix Silent Error Swallowing (6 Violations)

  **What to do**:
  - Replace every `catch(() => {})` and `catch { }` with proper error logging. For each:
  1. **`src/accounts.ts:477`** — `this.saveToDisk().catch(() => {})` → `.catch((err) => { if (this.debug) console.error("[opencode-anthropic-auth] saveToDisk failed:", err.message); })` — Accept `debug` in AccountManager constructor or via a setter
  2. **`src/token-refresh.ts:236`** — `await onTokensUpdated().catch(() => undefined)` → `await onTokensUpdated().catch((err) => { debugLog?.("onTokensUpdated failed:", err.message); })` — Thread debugLog as parameter
  3. **`src/token-refresh.ts:249`** — `.catch(() => undefined)` on auth.set → same pattern, log the error
  4. **`src/index.ts:151`** — version fetch `.catch(() => {})` → `.catch((err) => debugLog("CC version fetch failed:", err.message))`
  5. **`src/request/body.ts:130-133`** — JSON parse `catch { return body }` → `catch (err) { debugLog?.("body parse failed:", (err as Error).message); return body; }` — Accept optional debugLog parameter
  6. **`src/request/metadata.ts:46`** — file ID extraction `catch { return [] }` → `catch (err) { debugLog?.("extractFileIds failed:", (err as Error).message); return []; }`
  - For `index.ts:127-131` (toast catch) — narrow to specific error: `catch (err) { if (!(err instanceof TypeError)) debugLog("toast failed:", err); }`

  **Must NOT do**:
  - Do NOT add `throw` to any of these — they were caught for a reason (prevent crash propagation). Just add logging.
  - Do NOT change error handling in `refresh-lock.ts` — its catches are correctly structured (rethrow non-EEXIST, non-ENOENT)
  - Do NOT change the return values of any catch blocks

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`quality-standard`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3, 4)
  - **Blocks**: Tasks 6, 7
  - **Blocked By**: Task 1

  **References**:
  - `src/index.ts:134-137` — `debugLog()` function pattern: `function debugLog(...args: unknown[]) { if (!config.debug) return; console.error("[opencode-anthropic-auth]", ...args); }`
  - `src/accounts.ts:477` — `requestSaveToDisk()` is called from a debounced path
  - `src/token-refresh.ts:236,249` — token refresh callback chain
  - `src/request/body.ts:130-133` — JSON parse of request body
  - `src/request/metadata.ts:46` — file ID extraction from messages
  - QS-ERR-01: "No silent failures. `catch(e) {}` is forbidden."

  **Acceptance Criteria**:
  - [ ] `npx vitest run` passes (same count as baseline)
  - [ ] `grep -rn 'catch.*{.*}' src/ --include='*.ts' | grep -v test | grep -v debugLog | grep -v 'cli\|commands'` — zero empty catches in non-CLI code

  **QA Scenarios**:

  ```
  Scenario: No silent catches in plugin code
    Tool: Bash
    Steps:
      1. Run: grep -rn 'catch\s*{' src/ --include='*.ts' | grep -v '__tests__' | grep -v 'cli.ts' | grep -v 'commands/' | grep -v debugLog | grep -v console
      2. Run: grep -rn '\.catch(()' src/ --include='*.ts' | grep -v '__tests__' | grep -v 'cli.ts' | grep -v 'commands/'
    Expected Result: Zero matches — all catches now have logging
    Evidence: .sisyphus/evidence/task-5-catch-audit.txt

  Scenario: Error logging works when debug=true
    Tool: Bash
    Steps:
      1. Read each modified file
      2. Verify each catch block includes debugLog or console.error with error message
      3. Verify no catch blocks swallow errors silently
    Expected Result: All 6 violations fixed with proper logging
    Evidence: .sisyphus/evidence/task-5-code-review.txt
  ```

  **Commit**: YES
  - Message: `fix: replace silent error swallowing with debugLog (6 violations)`
  - Files: `src/accounts.ts`, `src/token-refresh.ts`, `src/index.ts`, `src/request/body.ts`, `src/request/metadata.ts`
  - Pre-commit: `npx vitest run`

- [x] 6. Extract Refresh Helpers from index.ts

  **What to do**:
  - Create `src/refresh-helpers.ts` — extract these functions from `index.ts`:
    - `parseRefreshFailure()` (~15 lines)
    - `refreshAccountTokenSingleFlight()` (~55 lines)
    - `refreshIdleAccount()` (~35 lines)
    - `maybeRefreshIdleAccounts()` (~25 lines)
  - Move associated state to the new module:
    - `refreshInFlight` Map
    - `idleRefreshLastAttempt` Map
    - `idleRefreshInFlight` Set
    - `IDLE_REFRESH_*` constants
  - Export a factory function that accepts the dependencies these helpers need (accountManager, config, debugLog, toast, etc.) and returns the helper functions — preserves the closure pattern without introducing a class
  - Update `index.ts` to import from `src/refresh-helpers.ts`

  **Must NOT do**:
  - Do NOT change function signatures or behavior — pure structural move
  - Do NOT introduce a PluginContext class
  - Do NOT change the closure-based state pattern — the factory function captures state via closure, same as today
  - Do NOT change any return values or error handling

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`quality-standard`]

  **Parallelization**:
  - **Can Run In Parallel**: NO — same file as Task 7 (index.ts)
  - **Parallel Group**: Wave 2 (runs FIRST, before Task 7)
  - **Blocks**: Task 7 (same file serialization)
  - **Blocked By**: Tasks 3, 4, 5

  **References**:
  - `src/index.ts:56-63` — state declarations to move (refreshInFlight, idle refresh state)
  - `src/index.ts:156-174` — `parseRefreshFailure()` — error classification
  - `src/index.ts:175-217` — `refreshAccountTokenSingleFlight()` — the main refresh orchestrator
  - `src/index.ts:219-261` — `refreshIdleAccount()` — background refresh for single account
  - `src/index.ts:263-290` — `maybeRefreshIdleAccounts()` — idle refresh sweep
  - `src/token-refresh.ts` — `refreshAccountToken()` is the actual token refresh call that these helpers wrap

  **Acceptance Criteria**:
  - [ ] `npx vitest run` passes (exact same count as baseline)
  - [ ] `src/refresh-helpers.ts` exists with exported factory function
  - [ ] `src/index.ts` no longer contains the moved functions
  - [ ] `npx tsc --noEmit 2>&1 | grep -c 'error'` — same or fewer errors than baseline

  **QA Scenarios**:

  ```
  Scenario: Decomposition preserves behavior
    Tool: Bash
    Steps:
      1. Run `npx vitest run 2>&1` — capture full output
      2. Compare test pass count to baseline (Task 1 evidence)
      3. Run `wc -l src/index.ts` — verify reduced line count
      4. Run `wc -l src/refresh-helpers.ts` — verify new file exists
    Expected Result: Same test results, index.ts ~130 lines shorter
    Evidence: .sisyphus/evidence/task-6-decompose.txt
  ```

  **Commit**: YES
  - Message: `refactor: extract refresh helpers from index.ts`
  - Files: `src/index.ts`, `src/refresh-helpers.ts` (new)
  - Pre-commit: `npx vitest run`

- [x] 7. Extract Plugin Helpers from index.ts

  **What to do**:
  - Create `src/plugin-helpers.ts` — extract these functions from `index.ts`:
    - `toast()` (~15 lines)
    - `sendCommandMessage()` (~10 lines)
    - `runCliCommand()` (~25 lines)
    - `reloadAccountManagerFromDisk()` (~20 lines)
    - `persistOpenCodeAuth()` (~15 lines)
  - Move associated state:
    - `debouncedToastTimestamps` Map
  - Same factory pattern as Task 6 — export a factory that captures dependencies via closure

  **Must NOT do**:
  - Same constraints as Task 6 — pure move, no behavior changes

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`quality-standard`]

  **Parallelization**:
  - **Can Run In Parallel**: NO — same file as Task 6 (index.ts)
  - **Parallel Group**: Wave 2 (runs AFTER Task 6 completes)
  - **Blocks**: Task 8
  - **Blocked By**: Task 6 (same file serialization)

  **References**:
  - `src/index.ts:71-131` — toast, sendCommandMessage, runCliCommand (line numbers as of BEFORE Task 6 runs — executor must re-locate after Task 6 extracts refresh helpers)
  - `src/index.ts:78-96` — reloadAccountManagerFromDisk, persistOpenCodeAuth
  - `src/index.ts:54` — `debouncedToastTimestamps` Map
  - **NOTE**: After Task 6 runs, line numbers in index.ts will shift. The executor must locate functions by name, not line number.

  **Acceptance Criteria**:
  - [ ] `npx vitest run` passes (same count as baseline)
  - [ ] `src/plugin-helpers.ts` exists
  - [ ] `src/index.ts` no longer contains the moved functions

  **QA Scenarios**:

  ```
  Scenario: Decomposition preserves behavior
    Tool: Bash
    Steps:
      1. Run `npx vitest run 2>&1`
      2. Compare to baseline
      3. Run `wc -l src/index.ts` — verify reduced
    Expected Result: Same test results, index.ts ~85 lines shorter
    Evidence: .sisyphus/evidence/task-7-decompose.txt
  ```

  **Commit**: YES
  - Message: `refactor: extract plugin helpers from index.ts`
  - Files: `src/index.ts`, `src/plugin-helpers.ts` (new)
  - Pre-commit: `npx vitest run`

- [x] 8. Clean Up Residual index.ts

  **What to do**:
  - Review remaining `index.ts` after Tasks 6-7
  - Clean up imports (remove unused)
  - Add section comments for the remaining code blocks
  - Verify the file is significantly smaller than the 890-line original
  - Update `scripts/build.ts` if needed to include new files in the bundle
  - **Quality over LOC**: The line count goal (~400) is a GUIDELINE, not a hard gate. If keeping a function in index.ts produces cleaner, more readable code than extracting it to a new file with awkward parameter plumbing, keep it. Readability and naming clarity trump arbitrary line limits.

  **Must NOT do**:
  - Do NOT force-extract code just to hit a line count — if extraction creates worse naming, more parameters, or harder-to-follow control flow, leave the code where it reads best
  - Do NOT change behavior

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: Tasks 9-16
  - **Blocked By**: Tasks 6, 7

  **References**:
  - `src/index.ts` — post-decomposition state
  - `scripts/build.ts` — build configuration (may need new entry points)

  **Acceptance Criteria**:
  - [ ] `wc -l src/index.ts` significantly reduced from 890 (target: under 500, flexible)
  - [ ] `npx vitest run` passes
  - [ ] `npm run build` produces all 3 dist artifacts
  - [ ] No unused imports in index.ts
  - [ ] Remaining code in index.ts reads clearly without needing comments to explain "why is this here"

  **QA Scenarios**:

  ```
  Scenario: index.ts is clean and significantly smaller
    Tool: Bash
    Steps:
      1. Run `wc -l src/index.ts` — verify reduced from 890
      2. Run `npx vitest run`
      3. Run `npm run build && ls -la dist/`
    Expected Result: Meaningfully smaller, all tests pass, build succeeds
    Evidence: .sisyphus/evidence/task-8-cleanup.txt
  ```

  **Commit**: YES
  - Message: `refactor: clean up residual index.ts after decomposition`
  - Files: `src/index.ts`, `scripts/build.ts`
  - Pre-commit: `npx vitest run && npm run build`

- [x] 9. Fix Sanitization Regex Word Boundaries

  **What to do**:
  - `src/system-prompt/sanitize.ts:12` — `/opencode/gi` → `/\bopencode\b/gi` — prevents matching inside words like "myopencode"
  - `src/system-prompt/sanitize.ts:11` — `/OpenCode/g` → `/\bOpenCode\b/g` — same word boundary fix
  - `src/request/body.ts:50` — tighten THIRD_PARTY_MARKERS regex:
    - `|ohmy|` → `|\bohmy\b|` — prevents matching inside "ohmygod" in user content
    - `|\bomc\b|` is already bounded (good)
    - `|\bomo\b|` is already bounded (good)
  - Add test cases for edge cases: "myopencode", "ohmygod", "promotion" (should NOT match)

  **Must NOT do**:
  - Do NOT redesign the sanitization system
  - Do NOT change the list of markers — only add word boundaries

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10-14)
  - **Blocks**: Task 16
  - **Blocked By**: Task 8

  **References**:
  - `src/system-prompt/sanitize.ts:8-19` — `sanitizeSystemText()` function
  - `src/request/body.ts:50` — `THIRD_PARTY_MARKERS` regex

  **Acceptance Criteria**:
  - [ ] `npx vitest run` passes
  - [ ] Regex patterns use `\b` word boundaries

  **QA Scenarios**:

  ```
  Scenario: No false positive matches
    Tool: Bash
    Steps:
      1. node -e "const r = /\bopencode\b/gi; console.log(r.test('myopencode'), r.test('opencode'), r.test('OpenCode is good'))"
      2. Expected: false, true, true
    Expected Result: Word boundaries prevent false matches
    Evidence: .sisyphus/evidence/task-9-regex.txt
  ```

  **Commit**: YES
  - Message: `fix: add word boundaries to sanitization regexes`
  - Files: `src/system-prompt/sanitize.ts`, `src/request/body.ts`
  - Pre-commit: `npx vitest run`

- [x] 10. Fix cc_entrypoint Default + Document Billing Edge Cases

  **What to do**:
  - `src/headers/billing.ts:42` — CC uses `process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown"` but plugin uses `|| "cli"`. Change to match CC: `?? "cli"` (keep "cli" as default since plugin is always CLI context, but use nullish coalescing for correctness)
  - Document the `cc_workload` field from CC's billing header that the plugin omits — add a comment explaining it's an AsyncLocalStorage workload tracker not applicable to the plugin
  - Document why `cch` uses a dynamic hash instead of CC's `00000` placeholder — reference `.omc/research/cch-source-analysis.md`

  **Must NOT do**:
  - Do NOT change the cch algorithm — it works
  - Do NOT add cc_workload — not applicable

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 9, 11-14)
  - **Blocks**: Task 16
  - **Blocked By**: Task 8

  **References**:
  - `src/headers/billing.ts:42` — `const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "cli"`
  - `.omc/research/cch-source-analysis.md:28-39` — CC's `mk_()` function uses `?? "unknown"`
  - `.omc/research/cch-source-analysis.md:124-131` — `cc_workload` from AsyncLocalStorage

  **Acceptance Criteria**:
  - [ ] `npx vitest run` passes
  - [ ] Comments explain cc_workload omission and cch algorithm difference

  **QA Scenarios**:

  ```
  Scenario: Entrypoint uses nullish coalescing
    Tool: Bash
    Steps:
      1. grep 'entrypoint' src/headers/billing.ts
      2. Verify uses ?? operator, not || operator
    Expected Result: Uses ?? for correctness
    Evidence: .sisyphus/evidence/task-10-billing.txt
  ```

  **Commit**: YES
  - Message: `fix: use nullish coalescing for cc_entrypoint + document billing gaps`
  - Files: `src/headers/billing.ts`
  - Pre-commit: `npx vitest run`

- [x] 11. Add Upstream Timeout to bun-proxy Fetch

  **What to do**:
  - `src/bun-proxy.ts:49` — add `signal: AbortSignal.timeout(600_000)` to the fetch call (600s = 10 minutes, matching CC's `x-stainless-timeout: 600`)
  - This prevents the proxy from hanging indefinitely on a stalled upstream connection

  **Must NOT do**:
  - Do NOT change any other proxy behavior

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 16
  - **Blocked By**: Task 8

  **References**:
  - `src/bun-proxy.ts:48-53` — the upstream fetch call with no timeout
  - `.omc/research/cc-vs-plugin-comparison.md:33` — `x-stainless-timeout: 600`

  **Acceptance Criteria**:
  - [ ] `npm run build` succeeds
  - [ ] fetch call includes AbortSignal.timeout

  **QA Scenarios**:

  ```
  Scenario: Timeout added to proxy fetch
    Tool: Bash
    Steps:
      1. grep -n 'AbortSignal.timeout' src/bun-proxy.ts
    Expected Result: One match at the fetch call
    Evidence: .sisyphus/evidence/task-11-timeout.txt
  ```

  **Commit**: YES
  - Message: `fix: add 600s upstream timeout to bun-proxy fetch`
  - Files: `src/bun-proxy.ts`
  - Pre-commit: `npm run build`

- [x] 12. Validate & Fix Proxy Shutdown Lifecycle

  **What to do**:
  This is a behavior-critical task. The proxy subprocess may not actually shut down correctly in all scenarios. Investigate, fix, and prove it.

  **Step 1 — Audit current shutdown paths** in `src/bun-fetch.ts:23-38`:
  - `process.on("exit", cleanup)` — fires on normal exit
  - `process.on("SIGINT", ...)` — Ctrl+C
  - `process.on("SIGTERM", ...)` — kill signal
  - `process.on("SIGHUP", ...)` — terminal close
  - `process.on("beforeExit", cleanup)` — event loop empty
  - **MISSING**: `uncaughtException` — parent crashes, proxy orphaned
  - **MISSING**: `unhandledRejection` — unhandled promise rejection

  **Step 2 — Fix missing handlers**:
  - Add `process.on('uncaughtException', (err) => { cleanup(); console.error(err); process.exit(1); })`
  - Add `process.on('unhandledRejection', (err) => { cleanup(); console.error(err); process.exit(1); })`
  - Do NOT swallow the error — log it and exit after cleanup

  **Step 3 — Fix PID file cleanup**:
  - `killStaleProxy()` reads PID file → kills process → deletes PID file
  - Verify: what happens if PID file exists but process is already dead? (should be handled — `process.kill(pid, "SIGTERM")` throws if pid doesn't exist, caught by outer try/catch)
  - Verify: what happens if PID file is stale from a previous session? (check `kill(pid, 0)` before `SIGTERM` to test if process is alive)
  - Add staleness check: if PID file is older than 24 hours, just delete it without trying to kill

  **Step 4 — Fix `stopBunProxy()` ordering**:
  - `src/bun-fetch.ts:180-188` — verify `proxyProcess.kill()` waits for child to actually exit, not just sends signal
  - Consider adding a timeout: if child doesn't exit within 2s of SIGTERM, escalate to SIGKILL

  **Step 5 — Validate with actual proxy spawn/kill cycle**:
  - Write a QA scenario that spawns the proxy, verifies it's running, kills the parent context, and verifies the proxy is dead

  **Must NOT do**:
  - Do NOT change the proxy port or IPC protocol
  - Do NOT swallow uncaughtException errors

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`quality-standard`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 16
  - **Blocked By**: Task 8

  **References**:
  - `src/bun-fetch.ts:23-38` — current exit handlers
  - `src/bun-fetch.ts:64-75` — `killStaleProxy()` — PID file handling
  - `src/bun-fetch.ts:88-146` — `spawnProxy()` — child process spawn
  - `src/bun-fetch.ts:180-188` — `stopBunProxy()` — manual stop
  - Node.js docs: `child_process` event lifecycle, `process.kill()` semantics
  - `.omc/handoffs/session-2026-04-09.md:35` — "Proxy not closing: Exit handlers may not fire if parent is SIGKILL'd"

  **Acceptance Criteria**:
  - [ ] `npx vitest run` passes
  - [ ] `uncaughtException` and `unhandledRejection` handlers registered
  - [ ] `stopBunProxy()` has SIGKILL escalation after timeout
  - [ ] `killStaleProxy()` checks process liveness before sending SIGTERM
  - [ ] PID file staleness check added (24h threshold)

  **QA Scenarios**:

  ```
  Scenario: Proxy starts and stops cleanly (direct subprocess test)
    Tool: Bash
    Steps:
      1. pkill -f bun-proxy 2>/dev/null; rm -f /tmp/opencode-bun-proxy.pid
      2. npm run build
      3. bun dist/bun-proxy.mjs 48372 & PROXY_PID=$!
      4. sleep 1 && curl -s http://127.0.0.1:48372/__health
      5. kill $PROXY_PID 2>/dev/null; sleep 1
      6. curl -sf http://127.0.0.1:48372/__health || echo "PROXY_DEAD"
    Expected Result: Step 3 prints BUN_PROXY_PORT=48372. Step 4 returns "ok". Step 6 prints "PROXY_DEAD" (process exited cleanly on signal).
    Failure Indicators: Step 4 fails (proxy didn't start) or Step 6 returns "ok" (proxy survived kill)
    Evidence: .sisyphus/evidence/task-12-proxy-lifecycle.txt

  Scenario: Stale PID file from dead process
    Tool: Bash
    Steps:
      1. echo "99999" > /tmp/opencode-bun-proxy.pid
      2. bun -e "import {ensureBunProxy,stopBunProxy} from './src/bun-fetch.ts'; const p = await ensureBunProxy(); console.log('PORT=' + p); stopBunProxy(); process.exit(0);" 2>&1
      3. grep 'PORT=48372' from output
    Expected Result: Stale PID handled gracefully, fresh proxy starts on 48372
    Evidence: .sisyphus/evidence/task-12-stale-pid.txt

  Scenario: Exception handlers registered in code
    Tool: Bash
    Steps:
      1. grep -n 'uncaughtException\|unhandledRejection' src/bun-fetch.ts
    Expected Result: Both handlers present in registerExitHandler()
    Evidence: .sisyphus/evidence/task-12-handlers.txt
  ```

  **Commit**: YES
  - Message: `fix: harden proxy shutdown lifecycle with exception handlers and PID staleness checks`
  - Files: `src/bun-fetch.ts`
  - Pre-commit: `npx vitest run`

- [x] 13. Cap Unbounded State Growth

  **What to do**:
  - **`fileAccountMap`** (index.ts) — add max size cap (e.g., 1000 entries). When exceeded, evict oldest entries (FIFO). Files API is per-account, this map remembers which account owns each file_id.
  - **`pendingSlashOAuth`** (index.ts) — add TTL-based cleanup. Entries should expire after `PENDING_OAUTH_TTL_MS` (10 minutes, already defined in constants.ts:74). Add a cleanup sweep before each new entry.
  - **`statsDeltas`** (accounts.ts) — add max delta count. If `saveToDisk()` has failed and deltas exceed 100, force a synchronous save attempt and log failure. Prevents unbounded accumulation.
  - **`debouncedToastTimestamps`** (after Task 7, in plugin-helpers.ts) — cap at 50 entries, evict oldest on overflow.

  **Must NOT do**:
  - Do NOT change the data structures (Map/Set) to something else
  - Do NOT remove any existing entries — only add bounds

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`quality-standard`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 16
  - **Blocked By**: Task 8

  **References**:
  - `src/index.ts:67` — `fileAccountMap = new Map<string, number>()` — no cleanup
  - `src/index.ts:66` — `pendingSlashOAuth = new Map<string, PendingOAuthEntry>()` — no TTL enforcement
  - `src/accounts.ts:51` — `#statsDeltas = new Map<string, StatsDelta>()` — grows on every request
  - `src/constants.ts:74` — `PENDING_OAUTH_TTL_MS = 10 * 60 * 1000`

  **Acceptance Criteria**:
  - [ ] `npx vitest run` passes
  - [ ] Each Map/Set has a documented max size or TTL

  **QA Scenarios**:

  ```
  Scenario: Maps have bounds
    Tool: Bash
    Steps:
      1. grep -n 'MAX_\|_CAP\|_LIMIT\|evict\|cleanup\|expire' src/index.ts src/plugin-helpers.ts src/accounts.ts
    Expected Result: Each unbounded collection has a cap constant and enforcement logic
    Evidence: .sisyphus/evidence/task-13-bounds.txt
  ```

  **Commit**: YES
  - Message: `fix: cap unbounded state growth in maps and sets`
  - Files: `src/index.ts` (or post-decomposition files), `src/accounts.ts`
  - Pre-commit: `npx vitest run`

- [x] 14. Verify Tool Prefix Convention Against CC

  **What to do**:
  - Investigate the `mcp_` prefix in `src/request/body.ts:21,107-128`
  - CC uses `mcp__<server>__<tool>` (double underscore) for MCP-connected tools, but native tools have no prefix
  - The plugin currently adds `mcp_` (single underscore) to ALL tools indiscriminately
  - Read the existing tests and CC comparison doc to determine the correct behavior
  - If the current behavior is correct for the opencode ↔ plugin context (opencode already adds tool names differently than CC), document why. If incorrect, fix it.
  - This is an investigation + documentation task — fix only if clearly wrong

  **Must NOT do**:
  - Do NOT blindly change the prefix without understanding what opencode sends as tool names

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 16
  - **Blocked By**: Task 8

  **References**:
  - `src/request/body.ts:21` — `const TOOL_PREFIX = "mcp_"`
  - `src/request/body.ts:106-128` — tool name prefixing logic
  - `src/response/streaming.ts` — tool name prefix stripping on response
  - `.omc/research/cc-vs-plugin-comparison.md` — CC tool naming not explicitly compared
  - CC source: `mcp__<server>__<tool>` pattern for MCP tools

  **Acceptance Criteria**:
  - [ ] Tool prefix behavior documented with clear rationale
  - [ ] If incorrect: fixed and tested. If correct: comment explains why single underscore is used.

  **QA Scenarios**:

  ```
  Scenario: Tool prefix is documented
    Tool: Bash
    Steps:
      1. Read src/request/body.ts — check TOOL_PREFIX and its usage
      2. Read src/response/streaming.ts — check how prefix is stripped
      3. Verify comment explains the convention choice
    Expected Result: Clear documentation of prefix choice with rationale
    Evidence: .sisyphus/evidence/task-14-tool-prefix.txt
  ```

  **Commit**: YES (if code changes) or NO (if documentation only)
  - Message: `docs: document tool prefix convention vs CC`
  - Files: `src/request/body.ts`
  - Pre-commit: `npx vitest run`

- [x] 15. Verify System Prompt Structure Against CC Source

  **What to do**:
  - This is an **audit and documentation task**, not a fix — the current system prompt works for routing
  - Compare the plugin's system prompt structure against CC's documented structure:
    1. Read `.omc/research/cch-source-analysis.md` — binary analysis of CC's prompt construction
    2. Read `.omc/research/cc-vs-plugin-comparison.md` — existing comparison
    3. Read `src/system-prompt/builder.ts` — current plugin implementation
    4. Verify: billing block placement (first, no cache_control) ✅
    5. Verify: identity string text and cache_control ✅
    6. Verify: block ordering (billing → identity → rest) ✅
  - Document any remaining discrepancies as **future hardening notes** — things Anthropic might tighten checks on:
    - CC's full system prompt is much larger (includes tool instructions, permissions, etc.)
    - CC uses `cacheScope: null` internally; plugin uses no cache_control on billing (equivalent)
    - CC may add `cc_workload` field in the future
    - CC's tool naming uses `mcp__` double underscore
  - Save findings as a summary comment block in `src/system-prompt/builder.ts` header

  **Must NOT do**:
  - Do NOT try to replicate CC's full system prompt — it's embedded in the binary and irrelevant for routing
  - Do NOT change working behavior for "future-proofing" without evidence

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Task 16)
  - **Blocks**: Task 16
  - **Blocked By**: Task 8

  **References**:
  - `.omc/research/cch-source-analysis.md` — full binary analysis
  - `.omc/research/cc-vs-plugin-comparison.md` — side-by-side comparison
  - `src/system-prompt/builder.ts` — current implementation
  - `src/constants.ts:14` — identity string
  - `src/headers/billing.ts` — billing header construction

  **Acceptance Criteria**:
  - [ ] Summary comment block added to `src/system-prompt/builder.ts` documenting CC alignment status
  - [ ] All verified items marked ✅ or noted as future hardening

  **QA Scenarios**:

  ```
  Scenario: Documentation exists in builder.ts
    Tool: Bash
    Steps:
      1. Read src/system-prompt/builder.ts header
      2. Verify comment block documents CC alignment status
      3. Verify future hardening items are listed
    Expected Result: Comprehensive alignment documentation present
    Evidence: .sisyphus/evidence/task-15-cc-verification.txt
  ```

  **Commit**: YES
  - Message: `docs: verify and document system prompt alignment with CC source`
  - Files: `src/system-prompt/builder.ts`
  - Pre-commit: `npx vitest run`

- [x] 16. Add Tests for All Changed Behavior

  **What to do**:
  - Add vitest tests covering the behavior changes from Tasks 2-15:
  1. **Debug gating tests**: Verify `ensureBunProxy()` and `fetchViaBun()` respect debug parameter — mock child_process.spawn, verify console.error is not called when debug=false
  2. **Error logging tests**: Verify catch blocks call debugLog on failure — mock failing operations, verify debugLog was called
  3. **Sanitization regex tests**: Add edge case tests — "myopencode" should not match, "opencode" should match, "OpenCode" should match, "ohmygod" should not trigger third-party marker
  4. **State bounds tests**: Verify fileAccountMap evicts at cap, pendingSlashOAuth expires old entries, statsDeltas caps
  5. **Billing tests**: Verify `cc_entrypoint` uses `??` not `||`, verify version suffix edge cases (empty message, short message)
  6. **Decomposition smoke tests**: Import from `refresh-helpers.ts` and `plugin-helpers.ts`, verify exports exist and are callable

  **Must NOT do**:
  - Do NOT backfill tests for existing untested behavior
  - Do NOT modify existing test assertions

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`quality-standard`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Blocks**: F1-F4
  - **Blocked By**: Tasks 9-15

  **References**:
  - `index.test.ts` — existing test patterns: `makeClient()`, `makeStoredAccount()`, `vi.mock()`
  - `src/__tests__/fingerprint-regression.test.ts` — example of targeted regression tests
  - `src/__tests__/cc-comparison.test.ts` — example of comparison tests

  **Acceptance Criteria**:
  - [ ] `npx vitest run` passes with MORE tests than baseline
  - [ ] New tests cover: debug gating, error logging, regex edge cases, state bounds, billing edge cases

  **QA Scenarios**:

  ```
  Scenario: New tests pass and increase coverage
    Tool: Bash
    Steps:
      1. Run `npx vitest run 2>&1`
      2. Compare test count to baseline (Task 1 evidence)
      3. Verify new test count > baseline test count
    Expected Result: More tests, all passing
    Evidence: .sisyphus/evidence/task-16-tests.txt

  Scenario: Regex edge case tests exist
    Tool: Bash
    Steps:
      1. grep -n 'myopencode\|ohmygod\|word.bound' src/__tests__/*.test.ts index.test.ts
    Expected Result: Edge case test assertions found
    Evidence: .sisyphus/evidence/task-16-regex-tests.txt
  ```

  **Commit**: YES
  - Message: `test: add coverage for refactored and fixed modules`
  - Files: `index.test.ts`, `src/__tests__/*.test.ts`
  - Pre-commit: `npx vitest run`

- [x] 17. Tighten ESLint Rules + Enforce Zero Warnings/Errors

  **What to do**:
  Currently ESLint has 1 error (a `require()` in bun-fetch.ts debug dump — removed by Task 4) and 1 stale warning. The config is permissive: `no-explicit-any` is off, `no-console` is off.

  **Step 1 — Tighten ESLint rules** in `eslint.config.ts`:
  - Turn on `@typescript-eslint/no-explicit-any` as `"warn"` (not error — let teams tighten gradually). Allow `// eslint-disable-next-line` for justified cases with a comment explaining why.
  - Add `no-console: "warn"` for `src/` files (excluding `src/cli.ts`, `src/commands/`, `src/__tests__/`, `src/bun-proxy.ts`). This catches ungated console calls at lint time instead of relying on grep.
  - Add `@typescript-eslint/no-unused-vars` as `"error"` (currently "warn") — unused vars are dead code, not "maybe later" code.
  - Add `@typescript-eslint/consistent-type-imports` as `"warn"` — enforce `import type` where possible (already used in some files).
  - Keep `no-explicit-any: "warn"` not "error" — existing code has legitimate `any` uses (plugin API boundary, JSON parsing). Warnings surface them without blocking.

  **Step 2 — Fix all warnings and errors**:
  - Run `npx eslint .` and fix every warning/error
  - For justified `any` usage: add `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- [reason]`
  - For console calls in non-CLI code: convert to debugLog or gate behind config.debug (most already done by Tasks 2-4)
  - Remove unused vars/imports
  - Convert imports to `import type` where applicable

  **Step 3 — Add lint to pre-commit and CI gate**:
  - Verify `.husky/pre-commit` runs lint (check if `lint-staged` is configured — it is, per package.json)
  - Add `npx eslint .` to the verification commands in the plan's success criteria

  **Must NOT do**:
  - Do NOT set `no-explicit-any` to "error" — too disruptive for existing code. "warn" surfaces issues without blocking.
  - Do NOT add rules that don't serve the project (no style-only rules like `semi` or `quotes` — prettier handles that)
  - Do NOT suppress warnings with blanket `eslint-disable` at file level — per-line only, with reason

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`quality-standard`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 9-14)
  - **Blocks**: Task 16
  - **Blocked By**: Task 8

  **References**:
  - `eslint.config.ts` — current ESLint config (flat config format, typescript-eslint)
  - `package.json` — `lint-staged` config runs `eslint --fix` on staged files
  - `.husky/` — pre-commit hooks
  - Current lint status: 1 error (`require()` in bun-fetch.ts — removed by Task 4), 1 stale warning

  **Acceptance Criteria**:
  - [ ] `npx eslint . 2>&1 | grep -c 'problem'` outputs `0 problems` (zero warnings, zero errors)
  - [ ] `eslint.config.ts` includes `no-console`, `no-explicit-any`, `consistent-type-imports` rules
  - [ ] Every `eslint-disable` comment includes a `-- reason` explanation
  - [ ] `npx vitest run` still passes

  **QA Scenarios**:

  ```
  Scenario: Clean lint pass
    Tool: Bash
    Steps:
      1. Run `npx eslint . 2>&1`
    Expected Result: "0 problems" — zero warnings, zero errors
    Failure Indicators: Any warning or error in output
    Evidence: .sisyphus/evidence/task-17-lint.txt

  Scenario: no-console catches ungated calls
    Tool: Bash
    Steps:
      1. Temporarily add `console.log("test")` to src/index.ts
      2. Run `npx eslint src/index.ts 2>&1`
      3. Verify warning is raised
      4. Revert the test line
    Expected Result: ESLint catches the ungated console call
    Evidence: .sisyphus/evidence/task-17-no-console.txt

  Scenario: Lint rules documented
    Tool: Bash
    Steps:
      1. grep -c 'eslint-disable.*--' src/*.ts src/**/*.ts
    Expected Result: Every disable has a reason comment
    Evidence: .sisyphus/evidence/task-17-disable-reasons.txt
  ```

  **Commit**: YES
  - Message: `chore: tighten ESLint rules and enforce zero warnings`
  - Files: `eslint.config.ts`, all files with lint fixes
  - Pre-commit: `npx eslint . && npx vitest run`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [x] F1. **Plan Compliance Audit** — `oracle`

  **QA Scenarios**:

  ```
  Scenario: Must Have compliance
    Tool: Bash
    Steps:
      1. grep -rn 'debugLog\|config\.debug\|OPENCODE_ANTHROPIC_DEBUG' src/bun-fetch.ts src/bun-proxy.ts — verify debug gating exists
      2. grep -rn 'catch.*{' src/ --include='*.ts' | grep -v test | grep -v cli | grep -v commands | grep -v debugLog | grep -v console — verify zero empty catches
      3. ls src/refresh-helpers.ts src/plugin-helpers.ts — verify decomposition files exist
      4. grep -n 'AbortSignal.timeout' src/bun-proxy.ts — verify proxy timeout exists
      5. grep -n 'uncaughtException' src/bun-fetch.ts — verify exception handler exists
      6. ls .sisyphus/evidence/task-*.txt | wc -l — verify evidence files collected
    Expected Result: All Must Have items verified with file evidence
    Evidence: .sisyphus/evidence/final-qa/f1-compliance.txt
  ```

  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`

  **QA Scenarios**:

  ```
  Scenario: Full quality gate pass
    Tool: Bash
    Steps:
      1. npx eslint . 2>&1 — expected: 0 problems
      2. npx tsc --noEmit 2>&1 | tail -3 — expected: same or fewer errors than baseline
      3. npm run build 2>&1 — expected: success
      4. npx vitest run 2>&1 — expected: all pass
      5. grep -rn 'eslint-disable' src/ --include='*.ts' | grep -v '\-\-' — expected: zero (all disables must have reason)
      6. grep -rn 'as any' src/ --include='*.ts' | grep -v test | grep -v 'eslint-disable' — count remaining unexcused any casts
    Expected Result: Lint clean, build succeeds, tests pass, no unjustified suppressions
    Evidence: .sisyphus/evidence/final-qa/f2-quality.txt
  ```

  Output: `Lint [PASS/FAIL] | Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`

  **QA Scenarios**:

  ```
  Scenario: Proxy lifecycle end-to-end (direct subprocess)
    Tool: Bash
    Steps:
      1. pkill -f bun-proxy 2>/dev/null; rm -f /tmp/opencode-bun-proxy.pid
      2. npm run build
      3. bun dist/bun-proxy.mjs 48372 & PROXY_PID=$!
      4. sleep 1 && curl -s http://127.0.0.1:48372/__health
      5. kill $PROXY_PID 2>/dev/null; sleep 1
      6. ps aux | grep bun-proxy | grep -v grep | wc -l
      7. ls /tmp/opencode-bun-proxy.pid 2>&1
    Expected Result: Step 4 returns "ok". Step 6 = 0 (no orphan). Step 7 = "No such file".
    Evidence: .sisyphus/evidence/final-qa/f3-proxy-lifecycle.txt

  Scenario: Debug output silence when debug=false
    Tool: Bash
    Steps:
      1. npm run build
      2. OPENCODE_ANTHROPIC_DEBUG=0 bun dist/bun-proxy.mjs 48372 2>/tmp/f3-stderr.txt & PROXY_PID=$!
      3. sleep 1 && curl -s -X POST http://127.0.0.1:48372/ -H "x-proxy-url: https://httpbin.org/post" -H "content-type: application/json" -d '{"test":true}' > /dev/null
      4. kill $PROXY_PID 2>/dev/null; sleep 1
      5. grep -c '\[bun-proxy\] ===' /tmp/f3-stderr.txt
    Expected Result: Step 5 outputs 0 — no request dump on stderr when debug is off
    Evidence: .sisyphus/evidence/final-qa/f3-debug-silence.txt

  Scenario: Graceful fallback when bun is missing
    Tool: Bash
    Steps:
      1. npm run build
      2. PATH=/usr/bin:/bin node -e "const {ensureBunProxy} = require('./dist/opencode-anthropic-auth-plugin.js'); ensureBunProxy().then(p => { console.log('PORT=' + p); process.exit(0); });" 2>&1 | tee .sisyphus/evidence/final-qa/f3-no-bun.txt
      3. grep 'PORT=null' .sisyphus/evidence/final-qa/f3-no-bun.txt
    Expected Result: PORT=null printed (bun not in PATH, graceful fallback), no crash
    Evidence: .sisyphus/evidence/final-qa/f3-no-bun.txt
  ```

  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`

  **QA Scenarios**:

  ```
  Scenario: Diff matches plan scope
    Tool: Bash
    Steps:
      1. git diff --stat HEAD~17..HEAD (or appropriate range for all task commits)
      2. For each changed file: verify it's mentioned in at least one task's Commit → Files list
      3. For each task: verify every file in the Commit → Files list was actually changed
      4. grep -rn 'PluginContext\|class Plugin' src/ — verify no forbidden patterns introduced
      5. wc -l src/index.ts — verify reduced from 890
    Expected Result: 1:1 match between plan scope and actual changes, no scope creep
    Evidence: .sisyphus/evidence/final-qa/f4-fidelity.txt
  ```

  Output: `Tasks [N/N compliant] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Commit | Message                                                      | Files                                                                                                       | Pre-commit                       |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1      | `chore: capture test baseline`                               | vitest run output in commit msg                                                                             | —                                |
| 2      | `fix: gate debug output in bun-fetch.ts behind config.debug` | `src/bun-fetch.ts`                                                                                          | `npx vitest run`                 |
| 3      | `fix: gate debug output in bun-proxy.ts via DEBUG env var`   | `src/bun-proxy.ts`, `src/bun-fetch.ts`                                                                      | `npx vitest run`                 |
| 4      | `fix: remove ungated debug dump to /tmp`                     | `src/bun-fetch.ts`                                                                                          | `npx vitest run`                 |
| 5      | `fix: replace silent error swallowing with debugLog`         | `src/accounts.ts`, `src/token-refresh.ts`, `src/index.ts`, `src/request/body.ts`, `src/request/metadata.ts` | `npx vitest run`                 |
| 6      | `refactor: extract refresh helpers from index.ts`            | `src/index.ts`, `src/refresh-helpers.ts` (new)                                                              | `npx vitest run`                 |
| 7      | `refactor: extract plugin helpers from index.ts`             | `src/index.ts`, `src/plugin-helpers.ts` (new)                                                               | `npx vitest run`                 |
| 8      | `refactor: clean up residual index.ts`                       | `src/index.ts`                                                                                              | `npx vitest run`                 |
| 9      | `fix: add word boundaries to sanitization regexes`           | `src/system-prompt/sanitize.ts`, `src/request/body.ts`                                                      | `npx vitest run`                 |
| 10     | `fix: correct cc_entrypoint default to match CC`             | `src/headers/billing.ts`                                                                                    | `npx vitest run`                 |
| 11     | `fix: add upstream timeout to bun-proxy fetch`               | `src/bun-proxy.ts`                                                                                          | `npx vitest run`                 |
| 12     | `fix: add uncaughtException handler for proxy cleanup`       | `src/bun-fetch.ts`                                                                                          | `npx vitest run`                 |
| 13     | `fix: cap unbounded state growth in maps and sets`           | `src/index.ts`, `src/accounts.ts`                                                                           | `npx vitest run`                 |
| 14     | `fix: verify and align tool prefix with CC convention`       | `src/request/body.ts`                                                                                       | `npx vitest run`                 |
| 15     | `docs: verify system prompt structure against CC source`     | docs or inline comments                                                                                     | `npx vitest run`                 |
| 16     | `test: add coverage for refactored and fixed modules`        | `src/__tests__/*.test.ts`, `index.test.ts`                                                                  | `npx vitest run`                 |
| 17     | `chore: tighten ESLint rules and enforce zero warnings`      | `eslint.config.ts`, all files with lint fixes                                                               | `npx eslint . && npx vitest run` |

---

## Success Criteria

### Verification Commands

```bash
npx vitest run                          # Expected: all pass, 0 failures
npx tsc --noEmit                        # Expected: same or fewer errors than baseline
npm run build                           # Expected: success, 3 dist artifacts
npx eslint .                            # Expected: 0 problems (0 errors, 0 warnings)
grep -rn 'console\.\(log\|error\|warn\)' src/ --include='*.ts' | grep -v 'cli.ts\|commands/\|__tests__/' | grep -v debugLog | grep -v 'config\.debug\|process\.env\.\(VITEST\|DEBUG\)'  # Expected: only IPC line in bun-proxy.ts
grep -rn 'catch.*{.*}' src/ --include='*.ts' | grep -v debugLog | grep -v 'test'  # Expected: 0 empty catches
wc -l src/index.ts                      # Expected: significantly reduced from 890 (guideline: < 500)
ls /tmp/opencode-last-*.json 2>/dev/null  # Expected: no files (or gated behind debug)
```

### Final Checklist

- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass (baseline + new)
- [ ] Build succeeds
- [ ] `npx eslint .` — zero warnings, zero errors
- [ ] No ungated debug output
- [ ] No silent error swallowing
- [ ] index.ts significantly reduced from 890 lines (quality over LOC)
- [ ] Proxy subprocess verified to shut down on parent exit
