# CC Fingerprint Parity & Resilience Improvements

## TL;DR

> **Quick Summary**: Close all remaining gaps between our OAuth proxy fingerprint and Claude Code v2.1.81, plus add Stainless-style retry resilience for service-wide errors.
>
> **Deliverables**:
>
> - Temperature normalization matching CC's `temperatureOverride ?? 1` pattern
> - Sonnet 4.6 adaptive thinking support (alongside existing Opus 4.6)
> - Cache control `ttl: "1h"` on identity system prompt blocks
> - Speed parameter passthrough for fast mode (Opus 4.6 only, extra usage billing)
> - Stainless-compatible `x-should-retry` + `retry-after-ms` header parsing
> - Exponential backoff with jitter for 529/503/5xx errors (max 2 retries)
> - 5-minute foreground token expiry buffer
> - New beta flags in EXPERIMENTAL set
>
> **Estimated Effort**: Medium (7 commits, ~15 files touched)
> **Parallel Execution**: YES — 4 waves
> **Critical Path**: Task 1 → Task 2/3/4/5 (parallel) → Task 6 → Task 7/8 (parallel) → Final

---

## Context

### Original Request

Close ALL remaining gaps between the opencode-anthropic-fix fork and Claude Code v2.1.81's HTTP fingerprint. Verify nothing is missing using the CC mimicry auditor skill. Propose refactoring and improvements.

### Interview Summary

**Key Discussions**:

- Direct CC v2.1.81 npm extraction confirmed all gaps
- `sV()` function confirms Sonnet 4.6 uses adaptive thinking alongside Opus 4.6
- `sjY()` function reveals cache TTL is OAuth+allowlist-gated (always add for OAuth)
- Stainless SDK retry: 0.5·2^n backoff, max 8s, 25% jitter, max 2 retries
- Temperature: `temperatureOverride ?? 1` for non-thinking, removed for thinking

**Research Findings**:

- CC v2.1.81 extracted from npm tarball — all patterns verified against minified cli.js
- Stainless SDK retry logic: `x-should-retry` → `retry-after-ms` → `retry-after` → calculated backoff
- CC `sV()` function: `opus-4-6` OR `sonnet-4-6` → adaptive thinking; haiku/sonnet/opus (non-4.6) → no
- CC `sjY()` for TTL: requires OAuth AND not overaged AND querySource in server allowlist
- CC speed: `speed: _ ? "fast" : "normal"` — boolean flag from fast mode toggle

### Metis Review

**Identified Gaps** (addressed):

- Q1 (sjY TTL condition): Resolved — always add TTL for OAuth (safe cache hint)
- Q2 (speed trigger): Resolved — CC's `oH()` gates fast mode to Opus 4.6 only (`model.includes("opus-4-6")`). Fast mode requires extra usage billing (separate rate limits, costs more). We passthrough only; don't inject or validate.
- Q3 (temperature override): Resolved — keep explicit, default to 1
- Q4 (5xx retry placement): Resolved — new wrapper in `src/request/retry.ts`
- Q5 (retry header precedence): Resolved — match Stainless: ms → seconds → calculated
- Q6 (expiry buffer vs idle): Resolved — independent systems, no conflict
- Q7 (sV adaptive thinking): Resolved — Opus 4.6 AND Sonnet 4.6 confirmed

---

## Work Objectives

### Core Objective

Achieve byte-level fingerprint parity with Claude Code v2.1.81 for all request body, header, and beta flag fields, plus add Stainless-compatible resilience for service-wide API errors.

### Concrete Deliverables

- `src/models.ts`: `isSonnet46Model()` + unified `isAdaptiveThinkingModel()`
- `src/request/body.ts`: Temperature normalization + speed passthrough
- `src/system-prompt/builder.ts`: Cache control `ttl: "1h"` on identity blocks
- `src/backoff.ts`: `parseRetryAfterMsHeader()` + `parseShouldRetryHeader()`
- `src/request/retry.ts` (NEW): Stainless-style 5xx retry with exp backoff
- `src/index.ts`: Wire retry wrapper + 5-min expiry buffer
- `src/constants.ts`: New beta flags in EXPERIMENTAL set
- `src/thinking.ts`: Use unified `isAdaptiveThinkingModel()`
- `src/betas.ts`: Use unified `isAdaptiveThinkingModel()` for effort beta
- Tests for every change

### Definition of Done

- [ ] `bun test` passes with 0 failures (all existing 506+ tests + new tests)
- [ ] Fingerprint regression tests cover temperature, speed, cache TTL, Sonnet 4.6
- [ ] 5xx retry verified with mocked fetch returning 529→200 (success after retry)
- [ ] x-should-retry:false verified to suppress retry on 5xx
- [ ] Token expiry buffer verified with fake timers (4min remaining → refresh, 6min → no refresh)

### Must Have

- Temperature: `1` default for non-thinking, removed for thinking, explicit override preserved
- Sonnet 4.6: detected and handled identically to Opus 4.6
- Cache TTL: `ttl: "1h"` on identity block `cache_control`
- 5xx retry: max 2 retries, exp backoff 0.5·2^n (max 8s), 25% jitter
- Expiry buffer: 5 minutes before token expiry triggers foreground refresh
- x-should-retry + retry-after-ms: parsed from response headers

### Must NOT Have (Guardrails)

- MUST NOT override explicit caller temperature (CC's `temperatureOverride ?? 1` pattern)
- MUST NOT trigger account rotation for 5xx errors (retry same account)
- MUST NOT add CC Remote betas (`ccr-*`, `mcp-client-*`, `skills-*`, `environments-*`) as auto-included
- MUST NOT add telemetry emitter, session metrics, or auto-strategy adaptation
- MUST NOT restructure the account rotation loop (index.ts:437-650)
- MUST NOT modify existing fingerprint regression tests (only add new ones)
- MUST NOT inject speed parameter into body unless Opus 4.6 model (fast mode is Opus 4.6 only, uses extra usage billing)
- MUST NOT auto-enable fast mode — it must be explicitly requested (CC uses `/fast` toggle, gated by `oH()` → `opus-4-6` only)
- MUST NOT add new configuration options (use CC's exact defaults)
- MUST NOT change response pipeline (`src/response/streaming.ts`)
- MUST NOT add `ttl` to non-identity system prompt blocks (billing header, user blocks)

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.

### Test Decision

- **Infrastructure exists**: YES (vitest via `bun test`, 506+ tests, 11 test files)
- **Automated tests**: YES (tests-after — new tests for each feature)
- **Framework**: vitest 4.0.18 via `bun test`

### QA Policy

Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Unit tests**: `bun test -- --grep "pattern"` → assert pass count
- **Regression tests**: `bun test src/__tests__/fingerprint-regression.test.ts` → all pass
- **Full suite**: `bun test` → 0 failures

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — model detection + constants):
├── Task 1: Sonnet 4.6 detection + isAdaptiveThinkingModel [quick]
├── Task 2: Add missing betas to EXPERIMENTAL_BETA_FLAGS set [quick]

Wave 2 (Body transforms — all independent, MAX PARALLEL):
├── Task 3: Temperature normalization (depends: 1) [deep]
├── Task 4: Speed parameter passthrough [quick]
├── Task 5: Cache control TTL on identity blocks [quick]

Wave 3 (Retry infrastructure):
├── Task 6: retry-after-ms + x-should-retry header parsing [quick]
├── Task 7: Stainless-style 5xx exponential backoff (depends: 6) [deep]

Wave 4 (Token + wiring):
├── Task 8: 5-minute foreground expiry buffer [quick]
├── Task 9: Wire retry into fetch path + integration test (depends: 7) [deep]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high)
└── Task F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: Task 1 → Task 3 → Task 7 → Task 9 → F1-F4 → user okay
Parallel Speedup: ~60% faster than sequential
Max Concurrent: 3 (Wave 2)
```

### Dependency Matrix

| Task | Depends On | Blocks                                            |
| ---- | ---------- | ------------------------------------------------- |
| 1    | —          | 3, 7 (model detection used in body.ts + betas.ts) |
| 2    | —          | — (constants only)                                |
| 3    | 1          | —                                                 |
| 4    | —          | —                                                 |
| 5    | —          | —                                                 |
| 6    | —          | 7                                                 |
| 7    | 6          | 9                                                 |
| 8    | —          | —                                                 |
| 9    | 7          | F1-F4                                             |

### Agent Dispatch Summary

- **Wave 1**: **2** — T1 → `quick`, T2 → `quick`
- **Wave 2**: **3** — T3 → `deep`, T4 → `quick`, T5 → `quick`
- **Wave 3**: **2** — T6 → `quick`, T7 → `deep`
- **Wave 4**: **2** — T8 → `quick`, T9 → `deep`
- **FINAL**: **4** — F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

- [x] 1. Sonnet 4.6 Detection + Unified isAdaptiveThinkingModel

  **What to do**:
  - Add `isSonnet46Model(model: string): boolean` to `src/models.ts` matching CC's pattern: `/claude-sonnet-4[._-]6|sonnet[._-]4[._-]6/i`
  - Add `isAdaptiveThinkingModel(model: string): boolean` that returns `isOpus46Model(model) || isSonnet46Model(model)` — this is the CC `sV()` function
  - Replace `isOpus46Model()` with `isAdaptiveThinkingModel()` in:
    - `src/thinking.ts:40` — the `normalizeThinkingBlock()` guard
    - `src/betas.ts:86` — the effort beta inclusion check
  - Keep `isOpus46Model()` exported (still used in `src/index.ts:338` for 1M context detection)
  - Export `isSonnet46Model` and `isAdaptiveThinkingModel` from `src/models.ts`
  - Add tests to `src/__tests__/fingerprint-regression.test.ts`:
    - `effort-2025-11-24` beta included for `claude-sonnet-4-6`
    - `normalizeThinkingBlock()` produces `{type:"enabled",effort}` for Sonnet 4.6

  **Must NOT do**:
  - Do not remove `isOpus46Model()` — it's still needed for `hasOneMillionContext()`
  - Do not add Sonnet 4.6 to `hasOneMillionContext()` unless CC does (it doesn't in v2.1.81)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small, focused changes to 3 files with clear patterns to follow
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Tasks 3, 7 (model detection used in body transforms)
  - **Blocked By**: None

  **References**:
  - `src/models.ts:21-27` — `isOpus46Model()` pattern to mirror for Sonnet 4.6
  - `src/thinking.ts:35-56` — `normalizeThinkingBlock()` to update guard condition
  - `src/betas.ts:86-88` — effort beta check to update
  - CC `sV()` extraction: `q.includes("opus-4-6") || q.includes("sonnet-4-6")` — confirms both models
  - `src/__tests__/fingerprint-regression.test.ts` — add new tests following existing patterns (line 200+)

  **Acceptance Criteria**:
  - [ ] `bun test -- --grep "isSonnet46Model"` → PASS (detection tests)
  - [ ] `bun test -- --grep "isAdaptiveThinkingModel"` → PASS (unified check tests)
  - [ ] `bun test -- --grep "sonnet.*4.*6.*effort"` → PASS (beta inclusion test)
  - [ ] `bun test src/__tests__/fingerprint-regression.test.ts` → all pass (no regressions)
  - [ ] `bun test` → 0 failures (full suite)

  **QA Scenarios**:

  ```
  Scenario: Sonnet 4.6 adaptive thinking normalization
    Tool: Bash (bun test)
    Preconditions: All source changes applied
    Steps:
      1. Run `bun test -- --grep "sonnet.*4.*6"`
      2. Verify output shows test names matching Sonnet 4.6 detection
      3. Run `bun test src/__tests__/fingerprint-regression.test.ts`
      4. Verify all fingerprint tests pass including new Sonnet 4.6 ones
    Expected Result: All matching tests pass, 0 failures
    Failure Indicators: Any test failure mentioning "sonnet" or "effort"
    Evidence: .sisyphus/evidence/task-1-sonnet46-tests.txt

  Scenario: Existing Opus 4.6 still works after refactor
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "opus.*4.*6"`
      2. Verify all existing Opus 4.6 tests still pass
    Expected Result: Zero regressions on Opus 4.6 behavior
    Failure Indicators: Any opus-related test failure
    Evidence: .sisyphus/evidence/task-1-opus46-regression.txt
  ```

  **Commit**: YES
  - Message: `feat(models): add Sonnet 4.6 detection and unified isAdaptiveThinkingModel`
  - Files: `src/models.ts`, `src/thinking.ts`, `src/betas.ts`, `src/__tests__/fingerprint-regression.test.ts`
  - Pre-commit: `bun test`

- [x] 2. Add Missing CC v2.1.81 Beta Flags to EXPERIMENTAL Set

  **What to do**:
  - Add the following beta flags to `EXPERIMENTAL_BETA_FLAGS` set in `src/constants.ts`:
    - `"ccr-byoc-2025-07-29"` (CC Remote BYOC)
    - `"ccr-triggers-2026-01-30"` (CC Remote triggers)
    - `"environments-2025-11-01"` (Environments)
    - `"mcp-client-2025-11-20"` (MCP client)
    - `"skills-2025-10-02"` (Skills)
  - These go into the EXPERIMENTAL set ONLY (not auto-included) so they can be:
    - Disabled via `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`
    - Added manually via `/anthropic betas add`
  - Also add beta shortcuts to `BETA_SHORTCUTS` map if appropriate
  - Add a test verifying the EXPERIMENTAL set includes these new flags

  **Must NOT do**:
  - Do NOT auto-include these betas in any request path
  - Do NOT add them to the auto-beta logic in `buildAnthropicBetaHeader()`

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Constants-only change, single file, trivial
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `src/constants.ts:30-52` — `EXPERIMENTAL_BETA_FLAGS` set to extend
  - `src/constants.ts:54-75` — `BETA_SHORTCUTS` map for aliases
  - CC v2.1.81 beta extraction: `ccr-byoc-2025-07-29`, `ccr-triggers-2026-01-30`, `environments-2025-11-01`, `mcp-client-2025-11-20`, `skills-2025-10-02`

  **Acceptance Criteria**:
  - [ ] `bun test -- --grep "EXPERIMENTAL"` → PASS
  - [ ] `bun test` → 0 failures

  **QA Scenarios**:

  ```
  Scenario: New betas in experimental set
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "experimental.*beta"` or relevant grep pattern
      2. Verify new betas are in the set
    Expected Result: Tests pass confirming new flags exist in EXPERIMENTAL set
    Evidence: .sisyphus/evidence/task-2-experimental-betas.txt

  Scenario: New betas NOT auto-included
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test src/__tests__/fingerprint-regression.test.ts`
      2. Verify no fingerprint test includes ccr-*, environments-*, mcp-client-*, skills-*
    Expected Result: Zero auto-inclusion of new betas
    Evidence: .sisyphus/evidence/task-2-no-auto-include.txt
  ```

  **Commit**: YES (groups with Task 1 if both in Wave 1)
  - Message: `feat(betas): add missing CC v2.1.81 beta flags to experimental set`
  - Files: `src/constants.ts`, tests
  - Pre-commit: `bun test`

- [x] 3. Temperature Normalization Matching CC v2.1.81

  **What to do**:
  - In `src/request/body.ts` `transformRequestBody()`, after the thinking normalization block (line 28), add temperature logic matching CC's exact pattern:
    ```
    CC source: let F6 = !o6 ? z.temperatureOverride ?? 1 : void 0;
    // o6 = thinking config (truthy when thinking enabled for adaptive model)
    // F6 = temperature value: undefined when thinking, else override ?? 1
    // Then: ...F6 !== void 0 && { temperature: F6 }
    ```
    Implementation:
    ```typescript
    // Temperature normalization — CC pattern: !thinkingConfig ? temperatureOverride ?? 1 : undefined
    // When thinking is enabled → temperature is omitted entirely (CC sends no temperature field)
    // When thinking is off → temperature defaults to 1 unless caller explicitly set it
    const hasThinking = parsed.thinking && typeof parsed.thinking === "object" && parsed.thinking.type === "enabled";
    if (hasThinking) {
      delete parsed.temperature; // CC: F6 = void 0 → field omitted
    } else if (!Object.hasOwn(parsed, "temperature")) {
      parsed.temperature = 1; // CC: temperatureOverride ?? 1
    }
    // If parsed.temperature was explicitly set, it's preserved (acts as temperatureOverride)
    ```
  - Add fingerprint regression tests for all 3 cases
  - Add unit tests in body.test.ts (create if needed)

  **Must NOT do**:
  - Do NOT override explicit caller temperature
  - Do NOT apply temperature to non-messages endpoints (but `transformRequestBody` is only called for messages, so this is already scoped)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Body transform with edge cases, needs careful temperature+thinking interaction testing
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 5)
  - **Blocks**: None
  - **Blocked By**: Task 1 (model detection may be used in edge case logic)

  **References**:
  - `src/request/body.ts:11-77` — `transformRequestBody()` to modify
  - `src/request/body.ts:26-28` — thinking normalization block (add temperature after this)
  - CC extraction: `temperature:z.temperatureOverride??1` and `temperatureOverride:0` patterns
  - `src/__tests__/fingerprint-regression.test.ts` — add temperature fingerprint tests

  **Acceptance Criteria**:
  - [ ] `bun test -- --grep "temperature"` → PASS (3+ tests: default, thinking-removal, explicit-override)
  - [ ] `bun test src/__tests__/fingerprint-regression.test.ts` → all pass
  - [ ] `bun test` → 0 failures

  **QA Scenarios**:

  ```
  Scenario: Temperature defaults to 1 for non-thinking requests
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "temperature.*default"`
      2. Verify test asserts body contains "temperature":1 when no temp set and no thinking
    Expected Result: Test passes, body includes temperature:1
    Evidence: .sisyphus/evidence/task-3-temp-default.txt

  Scenario: Temperature removed when thinking enabled
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "temperature.*thinking"`
      2. Verify test asserts body does NOT contain "temperature" key when thinking:{type:"enabled"}
    Expected Result: Test passes, temperature field absent
    Evidence: .sisyphus/evidence/task-3-temp-thinking.txt

  Scenario: Explicit temperature preserved
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "temperature.*override\|temperature.*explicit"`
      2. Verify test asserts body contains "temperature":0.7 when caller sets 0.7
    Expected Result: Test passes, caller's temperature preserved
    Evidence: .sisyphus/evidence/task-3-temp-override.txt
  ```

  **Commit**: YES
  - Message: `feat(body): add temperature normalization matching CC v2.1.81`
  - Files: `src/request/body.ts`, body tests, `src/__tests__/fingerprint-regression.test.ts`
  - Pre-commit: `bun test`

- [x] 4. Speed Parameter Passthrough for Fast Mode (Opus 4.6 Only)

  **What to do**:
  CC's fast mode is gated by `oH()` which checks `opus-4-6` only. It requires extra usage billing and is toggled via `/fast`. The request body includes `...r !== void 0 && { speed: r }` where `r` is `"fast"` or `"normal"`.
  - In `src/request/body.ts` `transformRequestBody()`, ensure the `speed` field is NOT stripped from the request body during the parse-transform-serialize round-trip
  - Currently only `betas` is explicitly deleted (line 22-24) — `speed` should survive unchanged
  - Verify this is the case; if `speed` is being dropped, add explicit passthrough
  - Add tests confirming `speed: "fast"` and `speed: "normal"` survive body transformation
  - Add a fingerprint regression test documenting that speed is an Opus 4.6 feature
  - **Important context**: Fast mode uses EXTRA usage billing (separate from standard Pro/Max subscription limits). The `/fast` command in CC is only available for Opus 4.6. CC checks `oH(model)` which requires `model.includes("opus-4-6")`. Fast mode has its own rate limits and costs more tokens.

  **Must NOT do**:
  - Do NOT inject a `speed` field if the caller didn't provide one — this is a passthrough only
  - Do NOT strip or modify the `speed` field value
  - Do NOT auto-enable fast mode (it costs extra and is user-initiated in CC via `/fast`)
  - Do NOT gate speed by model in the proxy — let the API reject invalid model+speed combos. Our job is fingerprint passthrough, not validation.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Likely just adding tests — the passthrough may already work
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 5)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `src/request/body.ts:11-77` — verify `speed` field survives the parse-transform-serialize round-trip
  - `src/request/body.ts:22-24` — only `betas` is explicitly deleted; `speed` should be fine
  - CC extraction: `...r !== void 0 && { speed: r }` — CC conditionally includes speed in request body
  - CC `oH()`: `A.toLowerCase().includes("opus-4-6")` — fast mode is Opus 4.6 only
  - CC `dJ3()`: lists fast mode unavailability reasons including `"extra_usage_disabled"` — confirms extra billing requirement
  - CC `a_1()`: `!xq() || !pj() || !oH(A)` — must be enabled, available, AND Opus 4.6

  **Acceptance Criteria**:
  - [ ] `bun test -- --grep "speed"` → PASS (passthrough tests)
  - [ ] `bun test` → 0 failures

  **QA Scenarios**:

  ```
  Scenario: Speed "fast" survives body transformation
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "speed.*fast\|fast.*speed"`
      2. Verify test sends body with speed:"fast" and asserts it appears in transformed output
    Expected Result: speed:"fast" present in transformed body
    Evidence: .sisyphus/evidence/task-4-speed-fast.txt

  Scenario: Speed "normal" survives body transformation
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "speed.*normal"`
      2. Verify test sends body with speed:"normal" and asserts it appears in transformed output
    Expected Result: speed:"normal" present in transformed body
    Evidence: .sisyphus/evidence/task-4-speed-normal.txt

  Scenario: No speed field when not provided
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "speed.*absent\|no.*speed"`
      2. Verify test sends body WITHOUT speed field and confirms it's absent in output
    Expected Result: No speed field injected when caller doesn't include one
    Evidence: .sisyphus/evidence/task-4-no-speed-injection.txt
  ```

  **Commit**: YES
  - Message: `feat(body): passthrough speed parameter for fast mode (Opus 4.6)`
  - Files: `src/request/body.ts` (if needed), body tests, fingerprint regression tests
  - Pre-commit: `bun test`

- [x] 5. Cache Control TTL on Identity Block

  **What to do**:
  - In `src/system-prompt/builder.ts:47-51`, change the identity block's `cache_control` from:
    ```typescript
    cache_control: { type: "ephemeral" },
    ```
    to:
    ```typescript
    cache_control: { type: "ephemeral", ttl: "1h" },
    ```
  - This matches CC's `sjY(q)` behavior for OAuth sessions (which we always are)
  - Update the `SystemBlock` type in `src/types.ts` if `cache_control` is typed — it may need a `ttl` field
  - Add fingerprint regression test asserting `ttl: "1h"` is present on identity block
  - Ensure billing header block does NOT get TTL (only the identity block)

  **Must NOT do**:
  - Do NOT add TTL to the billing header system block (line 44)
  - Do NOT add TTL to user-provided system blocks (line 52)
  - Do NOT make TTL configurable (CC doesn't)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single-line change + type update + test addition
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `src/system-prompt/builder.ts:47-51` — identity block to modify
  - `src/types.ts` — `SystemBlock` type may need `ttl` in `cache_control`
  - CC extraction: `{type:"ephemeral",...sjY(q)?{ttl:"1h"}}` — confirmed TTL pattern
  - `src/__tests__/fingerprint-regression.test.ts` — add cache TTL test

  **Acceptance Criteria**:
  - [ ] `bun test -- --grep "cache.*ttl\|ttl.*cache"` → PASS
  - [ ] `bun test src/__tests__/fingerprint-regression.test.ts` → all pass
  - [ ] `bun test` → 0 failures

  **QA Scenarios**:

  ```
  Scenario: Identity block has ttl:"1h"
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "ttl"`
      2. Verify test asserts identity block cache_control = {type:"ephemeral",ttl:"1h"}
    Expected Result: TTL present on identity block
    Evidence: .sisyphus/evidence/task-5-cache-ttl.txt

  Scenario: Billing header does NOT have ttl
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "billing.*ttl\|billing.*cache"` or check within existing billing tests
      2. Verify billing block only has text, no cache_control with ttl
    Expected Result: Billing block has no ttl field
    Evidence: .sisyphus/evidence/task-5-billing-no-ttl.txt
  ```

  **Commit**: YES
  - Message: `feat(cache): add ttl:"1h" to identity block cache_control`
  - Files: `src/system-prompt/builder.ts`, `src/types.ts` (if needed), fingerprint regression tests
  - Pre-commit: `bun test`

- [x] 6. retry-after-ms and x-should-retry Header Parsing

  **What to do**:
  - Add `parseRetryAfterMsHeader(response: Response): number | null` to `src/backoff.ts`:
    ```typescript
    export function parseRetryAfterMsHeader(response: Response): number | null {
      const header = response.headers.get("retry-after-ms");
      if (!header) return null;
      const ms = parseFloat(header);
      return !isNaN(ms) && ms > 0 ? Math.round(ms) : null;
    }
    ```
  - Add `parseShouldRetryHeader(response: Response): boolean | null` to `src/backoff.ts`:
    ```typescript
    export function parseShouldRetryHeader(response: Response): boolean | null {
      const header = response.headers.get("x-should-retry");
      if (header === "true") return true;
      if (header === "false") return false;
      return null; // not present or unrecognized
    }
    ```
  - Add unit tests in `src/backoff.test.ts` for both functions
  - Test edge cases: missing header, malformed values, fractional ms

  **Must NOT do**:
  - Do NOT wire these into the fetch path yet (Task 7/9 does that)
  - Do NOT modify existing `parseRetryAfterHeader()` function

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Two small pure functions + tests, no side effects
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Task 7 — but 7 depends on 6, so 6 first)
  - **Blocks**: Task 7 (retry logic needs these parsers)
  - **Blocked By**: None

  **References**:
  - `src/backoff.ts:12-30` — existing `parseRetryAfterHeader()` pattern to follow
  - `src/backoff.test.ts` — existing test patterns for header parsing
  - Stainless SDK: `responseHeaders?.get('retry-after-ms')` → `parseFloat()` → `timeoutMillis`
  - Stainless SDK: `response.headers.get('x-should-retry')` → `"true"/"false"` string comparison

  **Acceptance Criteria**:
  - [ ] `bun test -- --grep "retry-after-ms"` → PASS (3+ tests: present, missing, malformed)
  - [ ] `bun test -- --grep "x-should-retry\|should.retry"` → PASS (3+ tests: true, false, absent)
  - [ ] `bun test` → 0 failures

  **QA Scenarios**:

  ```
  Scenario: retry-after-ms parsed correctly
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "retry-after-ms"`
      2. Verify tests cover: present value (e.g. "1500" → 1500), missing (→ null), malformed (→ null)
    Expected Result: All retry-after-ms parsing tests pass
    Evidence: .sisyphus/evidence/task-6-retry-after-ms.txt

  Scenario: x-should-retry parsed correctly
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "should.retry"`
      2. Verify tests cover: "true" → true, "false" → false, absent → null
    Expected Result: All x-should-retry parsing tests pass
    Evidence: .sisyphus/evidence/task-6-should-retry.txt
  ```

  **Commit**: YES
  - Message: `feat(backoff): add retry-after-ms and x-should-retry parsing`
  - Files: `src/backoff.ts`, `src/backoff.test.ts`
  - Pre-commit: `bun test`

- [x] 7. Stainless-Style 5xx Exponential Backoff Retry

  **What to do**:
  - Create `src/request/retry.ts` (NEW file) with:

    ```typescript
    export interface RetryConfig {
      maxRetries: number;       // default 2
      initialDelayMs: number;   // default 500
      maxDelayMs: number;       // default 8000
      jitterFraction: number;   // default 0.25
    }

    export function calculateRetryDelay(attempt: number, config: RetryConfig): number {
      const delay = Math.min(config.initialDelayMs * Math.pow(2, attempt), config.maxDelayMs);
      const jitter = 1 - Math.random() * config.jitterFraction;
      return Math.round(delay * jitter);
    }

    export function shouldRetryStatus(status: number, shouldRetryHeader: boolean | null): boolean {
      if (shouldRetryHeader === true) return true;
      if (shouldRetryHeader === false) return false;
      return status === 408 || status === 409 || status === 429 || status >= 500;
    }

    export async function fetchWithRetry(
      doFetch: () => Promise<Response>,
      config?: Partial<RetryConfig>,
    ): Promise<Response> { ... }
    ```

  - `fetchWithRetry()` wraps a fetch call and retries on 5xx/retryable errors:
    - Reads `x-should-retry` header (via `parseShouldRetryHeader()`)
    - Reads `retry-after-ms` then `retry-after` then calculated delay
    - Waits with jitter, then retries
    - Max 2 retries (3 total attempts)
    - Returns the final response (success or last failure)
  - Create `src/request/retry.test.ts` with tests using `vi.useFakeTimers()`:
    - 529 → 200 (success after 1 retry)
    - 529 → 529 → 200 (success after 2 retries)
    - 529 → 529 → 529 (exhausted, returns 529)
    - x-should-retry:false on 503 → no retry
    - retry-after-ms:2000 → waits ~2000ms
    - Verify backoff timing matches Stainless formula

  **Must NOT do**:
  - Do NOT modify the account rotation loop
  - Do NOT retry 4xx errors (429 is handled by account rotation, not this)
  - Do NOT wire into index.ts yet (Task 9 does that)
  - Do NOT retry streaming responses (only initial HTTP status)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: New module with async retry logic, timing-sensitive tests, edge cases
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (after Task 6 completes)
  - **Parallel Group**: Wave 3 (sequential after Task 6)
  - **Blocks**: Task 9 (wiring)
  - **Blocked By**: Task 6 (needs header parsers)

  **References**:
  - `src/backoff.ts` — `parseRetryAfterMsHeader()`, `parseShouldRetryHeader()`, `parseRetryAfterHeader()` (from Task 6)
  - Stainless SDK `calculateDefaultRetryTimeoutMillis()`: `min(0.5 * 2^n, 8.0) * (1 - random*0.25) * 1000`
  - Stainless SDK `shouldRetry()`: `x-should-retry` → status code checks (408, 409, 429, >=500)
  - `src/backoff.test.ts` — testing patterns with mocked responses

  **Acceptance Criteria**:
  - [ ] `bun test -- --grep "fetchWithRetry\|5xx.*retry\|retry.*5xx"` → PASS (6+ tests)
  - [ ] `bun test -- --grep "backoff.*timing\|delay.*jitter"` → PASS (timing tests)
  - [ ] `bun test` → 0 failures

  **QA Scenarios**:

  ```
  Scenario: 529 → 200 succeeds after 1 retry
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "529.*retry.*success\|retry.*529.*200"`
      2. Verify test mocks fetch: first call returns 529, second returns 200
      3. Verify fetchWithRetry() returns the 200 response
    Expected Result: Request succeeds after 1 retry
    Evidence: .sisyphus/evidence/task-7-529-retry-success.txt

  Scenario: Retries exhausted returns error
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "retry.*exhaust"`
      2. Verify test mocks 3 consecutive 529 responses
      3. Verify fetchWithRetry() returns the final 529 response
    Expected Result: Returns error response after exhausting retries
    Evidence: .sisyphus/evidence/task-7-retry-exhausted.txt

  Scenario: x-should-retry:false suppresses retry
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "should-retry.*false"`
      2. Verify 503 with x-should-retry:false returns immediately without retry
    Expected Result: No retry attempted when header says false
    Evidence: .sisyphus/evidence/task-7-should-retry-false.txt
  ```

  **Commit**: YES
  - Message: `feat(retry): add Stainless-style 5xx exponential backoff`
  - Files: `src/request/retry.ts` (NEW), `src/request/retry.test.ts` (NEW)
  - Pre-commit: `bun test`

- [x] 8. 5-Minute Foreground Token Expiry Buffer

  **What to do**:
  - In `src/index.ts`, find the token expiry check (line ~466-467):
    ```typescript
    if (!account.access || !account.expires || account.expires < Date.now()) {
    ```
    Change to:
    ```typescript
    const FOREGROUND_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
    if (!account.access || !account.expires || account.expires < Date.now() + FOREGROUND_EXPIRY_BUFFER_MS) {
    ```
  - Also update `src/token-refresh.ts:127` and `src/token-refresh.ts:136` which check `account.expires > Date.now()` — these should also use the buffer for foreground checks
  - Export the constant from a shared location (e.g., `src/constants.ts`)
  - Add tests with `vi.useFakeTimers()`:
    - Token expiring in 4 minutes → triggers refresh
    - Token expiring in 6 minutes → does NOT trigger refresh
    - Token already expired → triggers refresh

  **Must NOT do**:
  - Do NOT change the idle refresh timing (60-min window is separate)
  - Do NOT change the refresh timeout (10s is correct)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple constant addition + condition change + focused tests
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Task 9)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `src/index.ts:466-467` — main token expiry check in fetch interceptor
  - `src/token-refresh.ts:127` — lock fallback expiry check
  - `src/token-refresh.ts:136` — foreground refresh expiry check
  - `src/config.ts:107-111` — idle refresh config (DO NOT modify)

  **Acceptance Criteria**:
  - [ ] `bun test -- --grep "expiry.*buffer\|buffer.*expiry"` → PASS (3 tests)
  - [ ] `bun test` → 0 failures

  **QA Scenarios**:

  ```
  Scenario: Token near expiry triggers refresh
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "expiry.*buffer"`
      2. Verify test with token expiring in 4 minutes triggers refresh
      3. Verify test with token expiring in 6 minutes does NOT trigger refresh
    Expected Result: Buffer correctly triggers/suppresses refresh
    Evidence: .sisyphus/evidence/task-8-expiry-buffer.txt
  ```

  **Commit**: YES
  - Message: `feat(refresh): add 5-min foreground expiry buffer`
  - Files: `src/index.ts`, `src/token-refresh.ts`, `src/constants.ts`, tests
  - Pre-commit: `bun test`

- [x] 9. Wire 5xx Retry into Fetch Interceptor

  **What to do**:
  - In `src/index.ts`, find the service-wide error handling (line ~620-624):
    ```typescript
    debugLog("service-wide response error, returning directly", { status: response.status });
    return transformResponse(response);
    ```
    Replace with:
    ```typescript
    debugLog("service-wide response error, attempting retry", { status: response.status });
    // Retry the same request with Stainless-style exponential backoff
    const retried = await fetchWithRetry(
      () => fetch(new Request(input, { ...requestInit, headers: headersForRetry })),
      { maxRetries: 2 },
    );
    return transformResponse(retried);
    ```
  - Import `fetchWithRetry` from `src/request/retry.ts`
  - The retry should use the SAME account (no rotation) — this is critical
  - Ensure the retry request preserves all headers (auth, stainless, billing)
  - Add integration test in `index.test.ts`:
    - Mock fetch: first call returns 529, second returns 200 → verify success
    - Mock fetch: returns 529 x3 → verify 529 returned to caller
    - Verify account is NOT switched during retry
  - Add `X-Stainless-Retry-Count` header to retried requests

  **Must NOT do**:
  - Do NOT restructure the account rotation loop
  - Do NOT retry 4xx errors through this path
  - Do NOT retry mid-stream SSE errors (only initial HTTP status)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Integration point touching the core fetch interceptor, needs careful wiring
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 7 + Task 8)
  - **Parallel Group**: Wave 4 (after Task 7)
  - **Blocks**: Final verification
  - **Blocked By**: Task 7 (retry module), Task 6 (header parsers)

  **References**:
  - `src/index.ts:620-624` — service-wide error return to replace with retry
  - `src/request/retry.ts` — `fetchWithRetry()` from Task 7
  - `src/headers/builder.ts` — header building for retry requests
  - `index.test.ts:2249-2330` — existing service-wide error tests to extend

  **Acceptance Criteria**:
  - [ ] `bun test -- --grep "service.*wide.*retry\|529.*retry.*integration"` → PASS
  - [ ] `bun test -- --grep "retry.*count.*header\|Stainless-Retry-Count"` → PASS
  - [ ] `bun test` → 0 failures (ALL 506+ existing tests + all new tests)

  **QA Scenarios**:

  ```
  Scenario: 529 retried and succeeds in integration test
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "service.*wide.*retry"`
      2. Verify test mocks fetch interceptor: 529 → 200
      3. Verify the response returned to OpenCode is the 200 success
    Expected Result: Transparent retry — OpenCode sees success
    Evidence: .sisyphus/evidence/task-9-integration-retry.txt

  Scenario: Account NOT switched during 5xx retry
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test -- --grep "529.*no.*switch\|retry.*same.*account"`
      2. Verify same account used for retry (no markRateLimited/markFailure calls)
    Expected Result: Same account used throughout retry cycle
    Evidence: .sisyphus/evidence/task-9-no-account-switch.txt

  Scenario: Full test suite passes
    Tool: Bash (bun test)
    Steps:
      1. Run `bun test`
      2. Verify 0 failures across entire suite
    Expected Result: All tests pass, including all new and existing tests
    Evidence: .sisyphus/evidence/task-9-full-suite.txt
  ```

  **Commit**: YES
  - Message: `feat(proxy): wire 5xx retry into fetch interceptor`
  - Files: `src/index.ts`, `index.test.ts`
  - Pre-commit: `bun test`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [x] F1. **Plan Compliance Audit** — `oracle`
      Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, run `bun test -- --grep "pattern"`). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in .sisyphus/evidence/. Compare deliverables against plan.
      Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
      Run `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp).
      Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
      Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration (temperature + thinking + speed in same request). Test edge cases: empty body, missing model, concurrent retries. Save to `.sisyphus/evidence/final-qa/`.
      Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
      For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.
      Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

| Commit | Message                                                                      | Files                                                                 | Pre-commit |
| ------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| 1      | `feat(models): add Sonnet 4.6 detection and unified isAdaptiveThinkingModel` | src/models.ts, src/thinking.ts, src/betas.ts, src/constants.ts, tests | `bun test` |
| 2      | `feat(betas): add missing CC v2.1.81 beta flags to experimental set`         | src/constants.ts, tests                                               | `bun test` |
| 3      | `feat(body): add temperature normalization matching CC v2.1.81`              | src/request/body.ts, tests                                            | `bun test` |
| 4      | `feat(body): passthrough speed parameter for fast mode`                      | src/request/body.ts, tests                                            | `bun test` |
| 5      | `feat(cache): add ttl:"1h" to identity block cache_control`                  | src/system-prompt/builder.ts, tests                                   | `bun test` |
| 6      | `feat(backoff): add retry-after-ms and x-should-retry parsing`               | src/backoff.ts, src/backoff.test.ts                                   | `bun test` |
| 7      | `feat(retry): add Stainless-style 5xx exponential backoff`                   | src/request/retry.ts (NEW), tests                                     | `bun test` |
| 8      | `feat(refresh): add 5-min foreground expiry buffer`                          | src/index.ts, src/token-refresh.ts, tests                             | `bun test` |
| 9      | `feat(proxy): wire 5xx retry into fetch interceptor`                         | src/index.ts, integration tests                                       | `bun test` |

---

## Success Criteria

### Verification Commands

```bash
bun test                                         # All tests pass (506+ existing + ~30 new)
bun test src/__tests__/fingerprint-regression.test.ts  # All fingerprint tests pass
bun test -- --grep "temperature"                 # Temperature normalization tests pass
bun test -- --grep "sonnet.*4.*6"                # Sonnet 4.6 tests pass
bun test -- --grep "retry"                       # Retry logic tests pass
bun test -- --grep "speed"                       # Speed passthrough tests pass
bun test -- --grep "cache.*ttl"                  # Cache TTL tests pass
bun test -- --grep "expiry.*buffer"              # Expiry buffer tests pass
```

### Final Checklist

- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass (0 failures)
- [ ] Fingerprint regression tests cover all new features
- [ ] No new config options added
- [ ] No response pipeline changes
- [ ] No account rotation restructuring
