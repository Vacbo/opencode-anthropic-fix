# Parallel Request + Account Dedup Fix

## TL;DR

> **Quick Summary**: Fix three correlated bug classes in `@vacbo/opencode-anthropic-fix` by moving to a per-instance Bun proxy on kernel-assigned ephemeral ports with per-request circuit breaking, hardening the SSE response pipeline for stream-completeness validation, and introducing a stable-identity account abstraction that dedupes on `email` (OAuth) or `source+label` (CC) instead of rotating refresh tokens.
>
> **Deliverables**:
>
> - Per-instance Bun proxy with zero restart-kill behavior and cross-platform parent-PID death detection
> - SSE streaming wrapper that enforces `message_stop`/`event: error` terminal semantics and rejects truncated tool_use blocks
> - `AccountIdentity` abstraction eliminating duplicate-account creation on token rotation for BOTH OAuth and CC accounts
> - Refresh lock hardened against CC refresh durations (staleMs ≥ 90s, timeoutMs ≥ 15s)
> - `syncActiveIndexFromDisk` preserves `source` field and in-flight object references
> - Test infrastructure: 6 shared helpers + 4 new test files + parallel fan-out harness
> - All ~55 inventoried bugs addressed across 8 domains
>
> **Estimated Effort**: XL (55+ bugs, 8 domains, TDD workflow, 6 waves)
> **Parallel Execution**: YES — 6 waves with 3-8 parallel tasks per wave
> **Critical Path**: Wave 1 test infra → Wave 2 RED tests → Wave 3 bun-proxy + host safety → Wave 4 streaming + body → Wave 5 accounts + refresh → Wave 6 integration → Final verification

---

## Context

### Original Request

User reported three bug classes in the plugin:

1. **Parallel subagent failure**: `messages.89: tool_use ids were found without tool_result blocks immediately after: toolu_017yoePuM9yzMy1sgrxzcTum. Each tool_use block must have a corresponding tool_result block in the next message.` observed when Sisyphus (Ultraworker) uses Claude Sonnet 4.6 with parallel sub-agents.

2. **Parallel agent connection failure**: `Unable to connect. Is the computer able to access the url?` observed when delegating the F1-F4 review wave (Plan Compliance Audit (oracle), Code Quality Review (unspecified-high), Real Manual QA, Scope Fidelity Check (deep)). Multiple "Tool execution aborted" messages preceded the connection failure.

3. **Duplicate account creation on token rotation**: "When the plugin tries to fetch a new oauth token it creates a new account. When it's trying to refresh an existing code. This should not happen for both CC tokens and external oauth tokens."

User also added the architectural constraint: multiple OpenCode tabs must be supported; one proxy per instance, each proxy must handle parallel sub-agent requests concurrently.

### Interview Summary

**User-confirmed decisions**:

- **Fix scope**: Full Bun proxy rewrite (not minimal patch). Each instance owns its own proxy subprocess.
- **Proxy architecture**: Per-instance on kernel-assigned ephemeral ports. NOT a shared daemon. Rejected in favor of simpler lifecycle + zero cross-instance interference by construction.
- **Test strategy**: TDD with parallel request harness. Failing tests first (Wave 2 RED), fixes second (Waves 3-5 GREEN).
- **Streaming hardening**: IN scope. Harden `response/streaming.ts` buffer/event handling and enforce SSE completeness semantics.
- **Native fetch fallback**: Keep + harden. Graceful degradation when Bun is unavailable.
- **Constraint**: Single per-instance proxy must handle many parallel sub-agent requests without serialization, interference, or head-of-line blocking.

### Research Findings

Six parallel deep-category analyses ran against the codebase (all in `.sisyphus/drafts/parallel-request-fix.md`):

- **bg_1cbf6411 Bun proxy race** (7m 30s): validated the primary hypothesis + 15+ concurrency hazards including fixed-port cross-instance interference, global healthCheckFails race, restart-kill cascade, plugin-installed `process.exit(1)` handlers, startup banner chunk-fragility, and spawn timeout split-brain.
- **bg_c50dd5c6 SSE streaming** (5m 8s): identified 15 findings including the DIRECT cause of the tool_use orphan error — EOF flush emits malformed final SSE events, terminal chunks during in-flight tool_use are unsafe, multi-`data:` SSE events are rewritten incorrectly (parser/rewriter framing desync), and the wrapper never validates `message_stop` semantics.
- **bg_73c18b38 Account dedup** (8m 45s): confirmed refresh-token-only matching across 6 sites + 6 correlated bugs including `syncActiveIndexFromDisk` DROPPING the `source` field (CC accounts silently reclassified as OAuth), `saveAccounts` not unioning disk-only records, CC auto-detect bypassing `MAX_ACCOUNTS`, zombie CC account preference over fresh CC account, and `cmdLogin` CLI-side duplicate bug.
- **bg_d7556480 Refresh concurrency** (6m 50s): 7 bugs including 20s stale-lock reaper stealing live locks from 60s CC refreshes, `syncActiveIndexFromDisk` replacing `#accounts` objects and orphaning in-flight refs, 2s lock timeout < refresh duration causing rotation thrashing, idle→foreground single-flight reentry, save durability hole after refresh.
- **bg_ea71edd4 Tool-use pipeline** (6m 5s): RULED OUT direct `tool_use.id`/`tool_use_id` corruption (zero matches in codebase for ID mutation). RULED IN two independent bugs: non-SSE JSON responses are not de-prefixed, and outbound body unconditionally re-prefixes historical `mcp_`-prefixed names creating `mcp_mcp_...` drift. Root cause of orphan error is stream abort after `content_block_start(tool_use)` before `content_block_stop`.
- **bg_433ca84c Test infra gaps** (6m 16s): 20 test files, 663 tests, ~6.5s full suite; ZERO dedicated `streaming.ts` tests; ZERO `bun-fetch`/`bun-proxy` behavioral tests; ZERO parallel fan-out tests; proposed 10 new test files + 6 shared helper modules.

### Metis Review

Metis consultation (12m 17s) surfaced critical gaps beyond the agent analyses:

- **Existing test `src/__tests__/debug-gating.test.ts:33-39` asserts `bun-fetch.ts` CONTAINS `"uncaughtException"` and `"unhandledRejection"`.** HOST-1 fix MUST update these assertions atomically in the same commit.
- **`init.body` type assumption is unverified**: `index.ts:262` guards but `index.ts:390` doesn't. `body.ts:20` silently passes through non-strings, skipping tool prefixing and identity block — bypasses Claude Code mimicry.
- **Storage version bump is catastrophic**: `storage.ts:179-182` returns `null` on unknown version, wiping multi-account state. Must stay at v1 with additive fields.
- **`bun-proxy.ts` must poll parent PID from argv every 5s** for cross-platform "die with parent" (Linux SIGKILL does not propagate to children; Node doesn't expose `prctl(PR_SET_PDEATHSIG)`).
- **Refresh lock constants**: `staleMs ≥ 90000`, `timeoutMs ≥ 15000` (exceed max CC refresh duration).
- **Wave ordering mandate**: Wave 1 = test infra (additive, zero-risk). Wave 2 = TDD failing tests (RED). Wave 3+ = fixes by domain (GREEN). Full suite + `tsc --noEmit` + `npm run build` at each wave boundary.

---

## Work Objectives

### Core Objective

Eliminate parallel-request failures, tool_use orphan errors, and duplicate-account creation by restructuring proxy lifecycle to per-instance ownership with per-request circuit breaking, enforcing SSE stream completeness, and switching account matching to stable identity (email/label).

### Concrete Deliverables

**Plugin source (modified)**:

- `src/bun-fetch.ts` — per-instance proxy manager, no module-level failure counter, no restart-kill, no global process handlers
- `src/bun-proxy.ts` — parent-PID death watcher, per-request body/cancellation lifecycle, buffered stdout banner
- `src/response/streaming.ts` — event-block-aware SSE wrapper, `message_stop` terminal validation, `cancel()` propagation, unified parser/rewriter buffer
- `src/response/mcp.ts` — non-SSE JSON path for tool name de-prefixing
- `src/request/body.ts` — runtime `init.body` type invariant, double-prefix defense, body clone-on-retry
- `src/accounts.ts` — identity-first `addAccount` + `syncActiveIndexFromDisk` that preserves `source` and object identity
- `src/token-refresh.ts` — refresh lock constants, idle→foreground single-flight re-check, in-place account updates
- `src/refresh-helpers.ts` — fix idle→foreground reentry
- `src/refresh-lock.ts` — widen constants, preserve owner/inode verification
- `src/storage.ts` — union disk-only accounts, preserve `source` on load, stay at version 1
- `src/index.ts` — fetch interceptor: per-request state, body clone-before-use, DEDUP-A fix in CC authorize flow, DEDUP-B fix in OAuth authorize flow
- `src/cli.ts` — DEDUP-CLI fix in `cmdLogin`, reuse `cmdReauth`'s stable-slot pattern

**Plugin source (new)**:

- `src/account-identity.ts` — `AccountIdentity` type + `resolveIdentity` + `findByIdentity` + `identitiesMatch`
- `src/circuit-breaker.ts` — per-client circuit breaker primitive for proxy health
- `src/parent-pid-watcher.ts` — cross-platform parent-PID polling for subprocess death detection

**Test infrastructure (new)**:

- `src/__tests__/helpers/plugin-fetch-harness.ts`
- `src/__tests__/helpers/sse.ts`
- `src/__tests__/helpers/deferred.ts`
- `src/__tests__/helpers/in-memory-storage.ts`
- `src/__tests__/helpers/mock-bun-proxy.ts`
- `src/__tests__/helpers/conversation-history.ts`

**Test files (new)**:

- `src/response/streaming.test.ts` — direct unit tests for SSE transform edge cases
- `src/bun-fetch.test.ts` — per-instance proxy manager unit tests with DI
- `src/__tests__/bun-proxy.parallel.test.ts` — single proxy handles N concurrent requests
- `src/__tests__/index.parallel.test.ts` — N-concurrent interceptor fan-out
- `src/request/body.history.test.ts` — tool name drift / double-prefix regression
- `src/accounts.dedup.test.ts` — identity-based dedup across rotation cycles
- `src/account-identity.test.ts` — unit tests for identity resolution
- `src/circuit-breaker.test.ts` — circuit breaker unit tests
- `src/parent-pid-watcher.test.ts` — parent-PID death detection

**Test files (modified)**:

- `src/__tests__/debug-gating.test.ts` — flip assertions from `toContain` to `not.toContain` for `uncaughtException`/`unhandledRejection`
- `src/refresh-lock.test.ts` — update to new `staleMs`/`timeoutMs` constants
- `src/token-refresh.test.ts` — add concurrent-refresh scenarios
- `src/accounts.test.ts` — add identity-based dedup scenarios + `source` preservation tests

**Documentation (modified)**:

- `docs/mimese-http-header-system-prompt.md` — update with proxy lifecycle changes if any header/beta logic changes
- `README.md` — update proxy lifecycle section, per-instance behavior, known limitations (Windows fallback)
- `AGENTS.md` — update with new concurrency guarantees
- `CHANGELOG.md` — comprehensive entry for v0.1.0 (next release)

### Definition of Done

- [ ] `npx vitest run` — 663 existing tests pass + all new tests pass (count increases)
- [ ] `npx tsc --noEmit` — zero errors
- [ ] `npm run lint` — zero errors
- [ ] `npm run format:check` — zero errors
- [ ] `npm run build` — produces `dist/opencode-anthropic-auth-plugin.js`, `dist/opencode-anthropic-auth-cli.mjs`, `dist/bun-proxy.mjs` successfully
- [ ] Agent-executed QA: 50-concurrent-request parallel fan-out test passes with zero tool_use orphan errors, zero "Unable to connect" errors, zero duplicate accounts after 10 refresh cycles
- [ ] Manual QA script `scripts/qa-parallel.sh` passes end-to-end
- [ ] No `rg "healthCheckFails|MAX_HEALTH_FAILS" src/` matches (global counter removed)
- [ ] No `rg "48372|FIXED_PORT" src/` matches (fixed port removed)
- [ ] No `rg "opencode-bun-proxy\.pid|PID_FILE" src/` matches (global PID file removed)
- [ ] No `rg "process\.on\s*\(\s*['\"]uncaughtException|process\.on\s*\(\s*['\"]unhandledRejection" src/` matches (global handlers removed)

### Must Have

- Single per-instance Bun proxy per OpenCode instance
- Proxy listens on kernel-assigned ephemeral port (Bun.serve port 0)
- Stdout banner parsed via buffered line reader, not per-chunk
- Proxy child dies with parent across macOS/Linux/Windows (parent-PID polling in subprocess)
- Zero restart-kill behavior in `fetchViaBun` catch blocks
- Per-request circuit breaker (not global counter)
- Single proxy handles N=50 concurrent sub-agent requests without interference
- SSE wrapper rejects streams that close without `message_stop` or `event: error`
- SSE wrapper uses event-block framing, not line framing
- Parser and rewriter share one buffer and one normalization path
- Non-SSE JSON responses get tool name de-prefixing via a dedicated JSON path
- Outbound body defends against double-prefixing historical `tool_use.name` values
- Runtime `init.body` type invariant with clear error on violation
- Body clone-before-use for retry path
- `AccountIdentity` abstraction with `email` (OAuth) / `source+label` (CC) / `refreshToken` (legacy)
- `addAccount` + `load` CC auto-detect + Flow A/B authorize + `cmdLogin` all use identity-first matching
- `syncActiveIndexFromDisk` preserves `source` field AND in-flight object identity
- `syncActiveIndexFromDisk` does NOT rebuild `HealthScoreTracker`/`TokenBucketTracker` on auth-only refreshes
- `saveAccounts` unions disk-only accounts (no silent drops)
- `CC auto-detect` enforces `MAX_ACCOUNTS` cap
- Refresh lock `staleMs ≥ 90000`, `timeoutMs ≥ 15000`
- Idle→foreground single-flight re-check prevents duplicate refreshes after idle rejection
- "Save before release lock" invariant preserved
- Storage version stays at `1`; all new fields additive
- Debug-gating test updated atomically with HOST-1 handler removal
- Graceful native fetch fallback when Bun unavailable (Windows, missing bun binary, spawn failure)
- Zero plugin-installed global `process.exit()` handlers
- All 6 new test helpers created before Wave 2
- TDD: every fix has a failing test written BEFORE the fix
- Full vitest suite + `tsc --noEmit` + `npm run build` passes at each wave boundary
- Atomic commits: one task = one commit (with test + source changes together)

### Must NOT Have (Guardrails)

**Architecture**:

- Global failure counters mixing independent requests (BP-1, BP-3, BP-11)
- Restart logic that kills active streams (BP-2)
- Fixed shared PID/port (BP-9)
- Unconditional child exit handlers that clobber newer state (BP-6)
- Spawn with `detached: true` or `child.unref()` (we want child to die with parent)
- Module-level mutable state in `src/bun-proxy.ts` outside server bootstrap
- Any `await` in proxy fetch handler before upstream call that could serialize requests
- Lock/mutex/queue/rate-limit logic inside the proxy subprocess
- Synchronous blocking stdout writes in proxy subprocess

**Plugin host safety**:

- `process.on("uncaughtException")` handlers in the plugin
- `process.on("unhandledRejection")` handlers in the plugin
- `process.on("SIGINT/SIGTERM/SIGHUP")` handlers in the plugin that call `process.exit`
- `process.on("beforeExit")` handlers in the plugin that run cleanup unconditionally
- `process.exit()` called anywhere in the plugin layer

**Request/body**:

- Retrying with a consumed request body (must clone before first use)
- Dropping the body when `requestInit.body` is absent but `input` is a `Request` with a body
- Silently passing non-string bodies through `transformRequestBody`
- Assuming `init.body` is always a string without runtime validation

**Streaming**:

- Line-oriented SSE rewrite using `lastIndexOf("\n")` instead of event-block framing
- Flushing incomplete final event blocks on EOF as if they were valid
- Independent buffers for parser and rewriter with different normalization
- Emitting a terminal chunk while `content_block_start(tool_use)` is unclosed
- Rewriting `application/json` responses through the SSE path
- Missing final `TextDecoder.decode()` flush at EOF
- Treating stream close without `message_stop` or `event: error` as success

**Tool name round-trip**:

- Unconditional outbound `mcp_` prefix without guard against existing prefix
- Any rewrite touching `tool_use.id` or `tool_use_id` (confirmed safe; add regression test)

**Account identity / dedup**:

- Any dedup keyed on `refreshToken` alone
- `syncActiveIndexFromDisk` dropping the `source` field
- `syncActiveIndexFromDisk` replacing `#accounts` with new objects when in-flight requests hold refs
- Collapsing CC and OAuth accounts with the same email (intentional separation)
- Bumping `storage.version` above `1`
- `loadAccounts` returning `null` on unknown version (must tolerate and log)
- `AccountManager.addAccount` swapping fields on a refreshToken match without verifying identity is the same
- CC auto-detect bypassing `MAX_ACCOUNTS`

**Refresh concurrency**:

- Lock `staleMs` ≤ max observed refresh duration (CC at 60s + margin)
- Lock `timeoutMs` < typical refresh duration
- Releasing the lock BEFORE `saveToDisk` completes
- Rebuilding `HealthScoreTracker`/`TokenBucketTracker` on every disk token rotation

**Existing test preservation**:

- Deleting `debug-gating.test.ts` without updating its assertions in the same commit
- Breaking `index.test.ts` (4734 LOC main regression gate)
- Breaking `refresh-lock.test.ts` without updating to new constants

**Scope discipline (Metis tripwires)**:

- Touching `src/oauth.ts` beyond DEDUP call-site fixes
- Touching `src/system-prompt/*`, `src/headers/*`, stainless/billing logic
- Touching `src/request/url.ts` or `src/request/metadata.ts`
- Touching `src/commands/*` beyond the `cmdLogin` dedup fix
- Touching `src/rotation.ts` (selection algorithm is not the bug)
- Touching `src/account-state.ts` per-account stats tracking
- Touching `src/files-*` file-ID pinning
- Touching `src/env.ts` beyond the `VITEST` short-circuit
- Touching `src/models.ts` model registry
- Touching build scripts unless shipping `bun-proxy.mjs` requires it
- Renaming public APIs of existing modules (breaks compiled dist contract)
- Adding new runtime dependencies (use what's already there; escalate if needed)
- Rewriting `syncActiveIndexFromDisk` beyond "preserve source + in-place reconciliation"
- Adding a second refresh lock layer
- TCP→UDS proxy switch (ephemeral port is sufficient)
- Writing new test framework config

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.
> Acceptance criteria requiring "user manually tests/confirms" are FORBIDDEN.

### Test Decision

- **Infrastructure exists**: YES (vitest 4.1.0, 20 test files, 663 tests baseline)
- **Automated tests**: TDD — failing tests first (Wave 2), then fixes (Waves 3-5)
- **Framework**: vitest (no config changes)
- **If TDD**: Each fix task follows RED (failing test exists from Wave 2) → GREEN (minimal impl) → REFACTOR

### QA Policy

Every task MUST include agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **SSE streaming**: Use Bash (vitest) — run direct unit tests against synthetic streams
- **Bun proxy lifecycle**: Use Bash (vitest) + optional real-subprocess integration test via `scripts/qa-parallel.sh`
- **Account dedup**: Use Bash (vitest) with in-memory storage harness
- **Refresh concurrency**: Use Bash (vitest) with real temp-dir lock tests + fake timers
- **Parallel fan-out**: Use Bash (interactive tmux) or Bash (vitest) via `plugin-fetch-harness.ts` + `deferred.ts`
- **Full plugin integration**: Use Bash (vitest) via the existing `index.test.ts` harness

### Pre-commit Hook Interaction (IMPORTANT)

The repo has `.husky/pre-commit` running `npm test` + `npx lint-staged`. This enforces a green-suite invariant on every commit. The plan must respect this with one narrow, documented exception:

- **Wave 2 RED commits (T8-T16)** intentionally add failing tests. These commits MUST use `git commit --no-verify` with a standardized rationale in the commit message body:

  ```
  test(<domain>): add failing tests for <feature>

  TDD RED phase. These tests are expected to fail until the paired GREEN task
  lands. Bypassing pre-commit with --no-verify because the tests MUST be
  committed in a failing state to establish the TDD baseline. The matching
  GREEN task (T<N>) will re-run pre-commit with a passing suite.

  Pre-commit bypass justification: TDD RED phase.
  Paired GREEN task: T<N>
  ```

- **All OTHER commits (T0, T1-T7, T17-T41, F1-F4)** MUST NOT use `--no-verify`. Their pre-commit hook runs must pass cleanly. If a commit's pre-commit hook fails, fix the underlying issue — do NOT bypass.

- **Wave 3-5 GREEN commits land the matching RED-to-GREEN transitions**. After T20 lands, the T8/T11/T12/T15 RED tests are now passing, so the suite is green and the hook passes without bypass. Same for T17→T8, T18→T9, T23→T13, etc. The GREEN task's pre-commit hook enforces that both the new tests and the full suite are green.

- **T40 is the full-suite reconciliation point**. Any residual cross-wave test updates land there; T40's pre-commit runs the full suite.

### Checkpoint Commands

Run at the END of each wave (not each task):

```bash
npx vitest run                                           # all tests pass
npx tsc --noEmit                                         # type check
npm run lint                                             # lint check
npm run format:check                                     # format check
npm run build                                            # build produces dist artifacts
rg "healthCheckFails|MAX_HEALTH_FAILS" src/              # expect 0 matches after Wave 3
rg "48372|FIXED_PORT" src/                               # expect 0 matches after Wave 3
rg "opencode-bun-proxy\.pid|PID_FILE" src/               # expect 0 matches after Wave 3
rg 'process\.on\s*\(\s*["'"'"']uncaughtException' src/   # expect 0 matches after Wave 3
rg 'process\.on\s*\(\s*["'"'"']unhandledRejection' src/  # expect 0 matches after Wave 3
```

---

## Execution Strategy

### Parallel Execution Waves

> Maximize throughput by grouping independent tasks into parallel waves.
> Each wave completes (all tasks + checkpoint commands green) before the next begins.
> Target: 5-8 tasks per wave; Wave 1 is larger because test infra is pure addition.

```
Wave 1 (Test Infrastructure - 7 parallel, all additive/zero-risk):
├── T1: Shared helper — plugin-fetch-harness.ts          [quick]
├── T2: Shared helper — sse.ts (SSE encoder/chunker)     [quick]
├── T3: Shared helper — deferred.ts                      [quick]
├── T4: Shared helper — in-memory-storage.ts             [quick]
├── T5: Shared helper — mock-bun-proxy.ts                [deep]
├── T6: Shared helper — conversation-history.ts          [quick]
└── T7: Update tsconfig/test globs for new helpers       [quick]

Wave 2 (TDD - Failing Tests RED - 9 parallel, all new test files):
├── T8:  src/circuit-breaker.test.ts (new)                     [quick]
├── T9:  src/parent-pid-watcher.test.ts (new)                  [deep]
├── T10: src/account-identity.test.ts (new)                    [quick]
├── T11: src/bun-fetch.test.ts (new)                           [deep]
├── T12: src/__tests__/bun-proxy.parallel.test.ts (new)        [deep]
├── T13: src/response/streaming.test.ts (new)                  [deep]
├── T14: src/accounts.dedup.test.ts (new)                      [deep]
├── T15: src/__tests__/index.parallel.test.ts (new)            [deep]
└── T16: src/request/body.history.test.ts (new)                [quick]

Wave 3 (Bun Proxy + Host Safety - 5 work items, T20+T21 is ONE atomic pair):
├── T17: src/circuit-breaker.ts (new module)                           [deep]        (parallel)
├── T18: src/parent-pid-watcher.ts (new module)                        [deep]        (parallel)
├── T19: src/bun-proxy.ts rewrite (per-request, parent-PID, buffered)  [deep]        (parallel)
├── T20+T21: src/bun-fetch.ts rewrite + remove global handlers         [deep]        (parallel with T17-T19, but T20 and T21 are ONE atomic work item / ONE commit)
└── T22: Graceful native fetch fallback hardening                      [deep]        (sequential after T20+T21)

Wave 4 (SSE Streaming + Tool Name + Body - 6 parallel, fixes RED to GREEN):
├── T23: src/response/streaming.ts rewrite (event-framing, message_stop terminal, cancel propagation) [deep]
├── T24: src/response/mcp.ts — non-SSE JSON path for tool name stripping [deep]
├── T25: src/request/body.ts — runtime init.body invariant + double-prefix defense [deep]
├── T26: src/index.ts fetch interceptor — body clone-before-use + per-request state [deep]
├── T27: SSE stream-completeness error propagation         [deep]
└── T28: Upstream abort signal tied to client disconnect (BPSP-2) [deep]

Wave 5 (Account Dedup + Refresh Concurrency - 8 parallel, fixes RED to GREEN):
├── T29: src/account-identity.ts (new module)              [deep]
├── T30: src/accounts.ts — addAccount identity-first + preserve source in sync [deep]
├── T31: src/accounts.ts — saveToDisk unions disk-only accounts [deep]
├── T32: src/storage.ts — preserve source on load + tolerate unknown version [deep]
├── T33: src/index.ts — DEDUP-A (CC auto-detect authorize) + DEDUP-B (OAuth authorize) [deep]
├── T34: src/cli.ts cmdLogin — DEDUP-CLI fix (reuse cmdReauth pattern) [deep]
├── T35: src/refresh-lock.ts — widen staleMs/timeoutMs constants + update tests [deep]
└── T36: src/refresh-helpers.ts — idle→foreground re-check + token-refresh.ts in-place updates [deep]

Wave 6 (Integration + Docs + Final Verification - STRICT SEQUENTIAL, NO parallelism — all tasks touch README/CHANGELOG or gate the full suite):
├── T37: Update README.md + agents.md + docs/mimese                       [writing]            (first)
├── T38: Update CHANGELOG.md + package.json v0.1.0 bump                   [writing]            (after T37)
├── T39: Manual QA script scripts/qa-parallel.sh + short README/CHANGELOG note [deep]          (after T38)
├── T40: Bulk sweep — update existing tests for new APIs (full-suite gate) [deep]              (after T39)
└── T41: Final regression suite — vitest + tsc + build + guardrails       [unspecified-high]   (after T40; final task before Final Verification Wave)

Wave FINAL (After ALL tasks — 4 parallel reviews):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real manual QA (unspecified-high + playwright/interactive_bash as needed)
└── F4: Scope fidelity check (deep)
-> Present results -> Get explicit user okay

Critical Path: T0 (baseline) → T1-T7 (helpers) → T13 (streaming TDD) → T23 (streaming fix) → T40 (full suite gate) → T41 (regression) → F1-F4 → user okay
Parallel Speedup: ~55% vs sequential (Wave 6 now sequential; Waves 3/5 have atomic pairs)
Max Concurrent: 9 (Wave 2 TDD tests)
Est. sequential time: ~42 tasks × avg 25min = ~17 hours
Est. parallel time: 6 waves × avg 50min per wave = ~5 hours
```

### Dependency Matrix (abbreviated; full matrix embedded in task blocks)

- **T0** (baseline): no dependencies. Blocks ALL other tasks.
- **T1-T6** (Wave 1 helpers): depend on T0. Parallel with each other.
- **T7** (Wave 1 close-out): depends on T1-T6. Blocks Wave 2.
- **T8-T16** (Wave 2 RED tests): depend on T7 (helpers must exist). Parallel with each other.
- **T17** (circuit-breaker): depends on T8. Blocks T20+T21.
- **T18** (parent-pid-watcher): depends on T9. Blocks T19.
- **T19** (bun-proxy rewrite): depends on T12, T18. Parallel with T17, T18, T20+T21. Blocks T22, T28.
- **T20+T21 (atomic pair — ONE commit)**: depends on T11, T15, T17. Parallel with T17, T18, T19. Blocks T22, T26.
- **T22** (native fetch fallback): depends on T20+T21. Sequential after the pair.
- **T23** (streaming rewrite): depends on T13. Parallel within Wave 4 with T24, T25.
- **T24** (mcp non-SSE path): depends on T13. Parallel with T23, T25.
- **T25** (body defense): depends on T16. Parallel with T23, T24.
- **T26** (index.ts interceptor): depends on T20+T21, T23, T25. Sequential after those.
- **T27** (stream error propagation): depends on T23. Sequential after T23.
- **T28** (upstream abort): depends on T19, T23. Sequential after those.
- **T29** (account-identity): depends on T10. Blocks T30, T33, T34.
- **T30** (accounts addAccount + sync): depends on T14, T29. Blocks T31, T33.
- **T31** (accounts saveToDisk union): depends on T30 (SAME FILE `src/accounts.ts` — sequential after T30).
- **T32** (storage preserve source): depends on T14. Parallel with T30, T31 (different file). Blocks T30 soft (T30 reads T32's interface additions).
- **T33** (index.ts DEDUP A/B): depends on T29, T30. Parallel with T34, T35, T36.
- **T34** (cli.ts DEDUP-CLI): depends on T29, T30. Parallel with T33.
- **T35** (refresh-lock constants): depends on T14. Parallel with T33, T34.
- **T36** (refresh-helpers reentry): depends on T14, T35. Sequential after T35.
- **T37** (docs — README, agents.md, mimese): depends on all Waves 1-5 complete. Wave 6 start.
- **T38** (CHANGELOG + version): depends on T37 (SAME FILES README/CHANGELOG — sequential).
- **T39** (qa-parallel.sh + short README/CHANGELOG note): depends on T38 (SAME FILES — sequential).
- **T40** (bulk test sweep — full suite gate): depends on T39.
- **T41** (final regression): depends on T40.
- **F1-F4** (parallel final wave): depend on T41.

### Agent Dispatch Summary

- **T0** (baseline): `quick`
- **Wave 1 (7 tasks)**: T1-T4, T6, T7 → `quick` category (single file, additive, pattern-matching from existing helpers); T5 → `deep` (mock subprocess harness is non-trivial)
- **Wave 2 (9 tasks)**: T8, T10, T16 → `quick`; T9, T11-T15 → `deep` (TDD tests for concurrent scenarios need careful construction)
- **Wave 3 (5 work items, T20+T21 is ONE atomic pair)**: T17, T18, T19, T20+T21 pair, T22 → all `deep`
- **Wave 4 (6 tasks)**: All `deep`
- **Wave 5 (8 tasks)**: All `deep`
- **Wave 6 (5 sequential tasks)**: T37, T38 → `writing`; T39 → `deep`; T40 → `deep`; T41 → `unspecified-high`
- **FINAL (4 parallel tasks)**: F1 → `oracle`; F2 → `unspecified-high`; F3 → `unspecified-high` (+ `interactive_bash` skill); F4 → `deep`
- **Total commits expected**: 41 (42 tasks minus 1 for the T20+T21 atomic pair). F1/F2/F4 verify this count.

---

## TODOs

- [x] 0. Baseline capture — establish the current state of lint/typecheck/build/tests before any changes

  **What to do**:
  - Run each of the following commands on the clean working tree (post-dependency-install) and capture full output to the matching evidence file. Capture the exit code for each. Do NOT assume what the output will be; whatever the clean tree reports IS the baseline.
  - `git rev-parse HEAD > .sisyphus/evidence/task-0-baseline-sha.txt`
  - `npx vitest run` → `.sisyphus/evidence/task-0-baseline-vitest.txt` (record total tests, pass/fail counts, suite count)
  - `npx tsc --noEmit` → `.sisyphus/evidence/task-0-baseline-tsc.txt` (record every error line verbatim; may be empty if clean)
  - `npm run lint` → `.sisyphus/evidence/task-0-baseline-lint.txt` (record every warning/error verbatim; may be empty)
  - `npm run format:check` → `.sisyphus/evidence/task-0-baseline-format.txt` (record every non-matching file; may be empty)
  - `npm run build` → `.sisyphus/evidence/task-0-baseline-build.txt` (record exit code + `ls -la dist/` listing)
  - Create `.sisyphus/evidence/task-0-baseline.md` summarizing, using the actual captured numbers:
    - Commit SHA
    - Vitest: total files / total tests / pass / fail
    - tsc: error count
    - lint: error count + warning count
    - format: unformatted-file count
    - build: exit code + dist artifact list
  - Document in the baseline note: "These captured values are the 'no-regression' baseline. The plan's Definition of Done is 'no net-new regressions against this baseline'. If every command was clean on this commit, the DoD is strict pass/zero-errors; if any command reported pre-existing warnings, the DoD is 'equal or better'."

  **Must NOT do**:
  - Fix any pre-existing warnings in this task (scope: capture only)
  - Modify any source files
  - Modify any test files
  - Assume specific error counts or specific files have errors — whatever the commands actually output IS the baseline

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure information capture; no code changes; runs commands and saves outputs
  - **Skills**: `[]`
    - No domain overlap beyond basic shell execution

  **Parallelization**:
  - **Can Run In Parallel**: NO (must complete before any other task)
  - **Parallel Group**: Pre-Wave 0 — blocks everything
  - **Blocks**: ALL subsequent tasks (provides the baseline they must not regress from)
  - **Blocked By**: None — runs first

  **References**:

  **Pattern References**:
  - `.github/workflows/ci.yml` — shows the exact commands CI runs; mirror them here
  - `package.json:scripts` — canonical commands: `test`, `build`, `lint`, `format:check`

  **WHY each reference matters**:
  - `ci.yml` defines the authoritative passing criteria for the main branch; if CI passes, the baseline is passing-with-known-warnings
  - `package.json` scripts guarantee we invoke the same tooling as CI

  **Acceptance Criteria**:
  - [ ] `.sisyphus/evidence/task-0-baseline-tsc.txt` exists and contains full tsc output
  - [ ] `.sisyphus/evidence/task-0-baseline-lint.txt` exists
  - [ ] `.sisyphus/evidence/task-0-baseline-format.txt` exists
  - [ ] `.sisyphus/evidence/task-0-baseline-build.txt` exists
  - [ ] `.sisyphus/evidence/task-0-baseline.md` exists with summary table
  - [ ] Baseline note explicitly lists pre-existing tsc-error files and their counts

  **QA Scenarios**:

  ```
  Scenario: Capture clean baseline state
    Tool: Bash
    Preconditions: git worktree is clean, on main branch, dependencies installed
    Steps:
      1. mkdir -p .sisyphus/evidence
      2. git rev-parse HEAD > .sisyphus/evidence/task-0-baseline-sha.txt
      3. npx vitest run 2>&1 | tee .sisyphus/evidence/task-0-baseline-vitest.txt
      4. npx tsc --noEmit 2>&1 | tee .sisyphus/evidence/task-0-baseline-tsc.txt
      5. npm run lint 2>&1 | tee .sisyphus/evidence/task-0-baseline-lint.txt || true
      6. npm run format:check 2>&1 | tee .sisyphus/evidence/task-0-baseline-format.txt || true
      7. npm run build 2>&1 | tee .sisyphus/evidence/task-0-baseline-build.txt
      8. ls -la dist/ >> .sisyphus/evidence/task-0-baseline-build.txt
    Expected Result: All 5 evidence files exist, non-empty, and contain the exact tooling output
    Failure Indicators: Missing evidence file, empty file, or failure to run tooling at all (not to be confused with tooling reporting errors — those are the baseline)
    Evidence: .sisyphus/evidence/task-0-baseline-*.txt
  ```

  **Evidence to Capture**:
  - [ ] task-0-baseline-sha.txt (commit SHA)
  - [ ] task-0-baseline-vitest.txt (test results)
  - [ ] task-0-baseline-tsc.txt (type errors)
  - [ ] task-0-baseline-lint.txt (lint errors)
  - [ ] task-0-baseline-format.txt (format errors)
  - [ ] task-0-baseline-build.txt (build output + dist listing)
  - [ ] task-0-baseline.md (summary)

  **Commit**: YES (single commit)
  - Message: `chore(plan): capture baseline state before parallel-and-auth-fix plan`
  - Files: `.sisyphus/evidence/task-0-baseline-*`
  - Pre-commit: none (evidence files only)

- [ ] 1. Shared helper: `src/__tests__/helpers/plugin-fetch-harness.ts`

  **What to do**:
  - Create `src/__tests__/helpers/plugin-fetch-harness.ts`
  - Extract reusable plugin bootstrap logic from `index.test.ts` helpers: `makeClient`, `makeProvider`, `makeStoredAccount`, `makeAccountsData`, `setupFetchFn`, `mockTokenRefresh`
  - Export typed factory functions:
    - `createFetchHarness(opts?: HarnessOptions): Promise<FetchHarness>` — returns a configured plugin, a mock fetch, a controllable account manager, and teardown helper
    - `HarnessOptions` interface with: `accounts?: StoredAccount[]`, `config?: Partial<AnthropicAuthConfig>`, `mockResponses?: MockResponseMap`, `initialAccount?: number`
    - `FetchHarness` interface with: `plugin: AnthropicAuthPlugin`, `fetch: (input, init) => Promise<Response>`, `accountManager: AccountManager`, `mockFetch: Mock`, `tearDown(): Promise<void>`
  - Helper does NOT spawn real Bun subprocess; uses `VITEST=1` short-circuit in `ensureBunProxy` (existing)
  - Mock `globalThis.fetch` with `vi.fn()`; the harness wires `setupFetchFn` into the plugin's auth loader

  **Must NOT do**:
  - Spawn real Bun subprocess (use VITEST=1 short-circuit)
  - Modify `index.test.ts` in this task (that's T40's job)
  - Copy-paste inline — only extract shared scaffolding

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single-file additive helper; pattern-matched from existing `index.test.ts`
  - **Skills**: `[]`
    - No cross-cutting domain knowledge required

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T2-T7)
  - **Blocks**: T11, T15, T40
  - **Blocked By**: T0 (baseline)

  **References**:

  **Pattern References**:
  - `index.test.ts:264-340` — existing `makeClient`, `makeProvider`, `waitForAssertion` helpers
  - `index.test.ts:742+` — `setupFetchFn` existing pattern
  - `src/__tests__/helpers/` — currently empty directory (if not present, create it)

  **API References**:
  - `src/index.ts:AnthropicAuthPlugin` — plugin factory signature
  - `src/accounts.ts:AccountManager` — the manager type to expose

  **Type References**:
  - `src/accounts.ts:ManagedAccount`, `StoredAccount`
  - `src/config.ts:AnthropicAuthConfig`
  - `@opencode-ai/plugin:Plugin` type

  **WHY each reference matters**:
  - Existing helpers are the canonical pattern; divergence creates test drift
  - Plugin factory contract must be respected to avoid breaking signatures
  - Type interfaces must match the existing test suite so refactors can delete inline copies

  **Acceptance Criteria**:
  - [ ] File `src/__tests__/helpers/plugin-fetch-harness.ts` exists
  - [ ] Exports: `createFetchHarness`, `HarnessOptions`, `FetchHarness`, `MockResponseMap`
  - [ ] `npx tsc --noEmit` — NO NEW errors vs T0 baseline
  - [ ] Unit smoke test: create a harness, fire one mock request, assert it lands on the mock; tear down cleanly
  - [ ] No `stopBunProxy` or real subprocess calls

  **QA Scenarios**:

  ```
  Scenario: Harness creates a usable plugin with mocked fetch
    Tool: Bash (vitest)
    Preconditions: dependencies installed, T0 baseline captured
    Steps:
      1. Create inline smoke test in src/__tests__/helpers/plugin-fetch-harness.smoke.test.ts
      2. const harness = await createFetchHarness({ accounts: [makeStoredAccount()] })
      3. harness.mockFetch.mockResolvedValueOnce(new Response('{"ok":true}', {status: 200}))
      4. const r = await harness.fetch('https://api.anthropic.com/v1/messages', {method:'POST', body:'{}'})
      5. expect(r.status).toBe(200)
      6. expect(harness.mockFetch).toHaveBeenCalledTimes(1)
      7. await harness.tearDown()
    Expected Result: Test passes, mock called once, response body matches, no lingering timers
    Failure Indicators: Test fails, mock not called, Response body differs, or teardown leaves open handles
    Evidence: .sisyphus/evidence/task-1-harness-smoke.txt (vitest output)
  ```

  **Evidence to Capture**:
  - [ ] task-1-harness-smoke.txt (vitest output of smoke test)
  - [ ] task-1-tsc.txt (confirming no new errors)

  **Commit**: YES (single commit)
  - Message: `test(infra): add plugin-fetch-harness helper for integration tests`
  - Files: `src/__tests__/helpers/plugin-fetch-harness.ts`, `src/__tests__/helpers/plugin-fetch-harness.smoke.test.ts`
  - Pre-commit: `npx vitest run src/__tests__/helpers/plugin-fetch-harness.smoke.test.ts`

- [ ] 2. Shared helper: `src/__tests__/helpers/sse.ts`

  **What to do**:
  - Create `src/__tests__/helpers/sse.ts`
  - Export:
    - `encodeSSEEvent(event: {event?: string; data: unknown; id?: string}): string` — formats one SSE event block with proper `\n\n` terminator
    - `encodeSSEStream(events: SSEEvent[], terminator?: 'message_stop' | 'error' | 'none'): string` — joins N events plus the chosen terminal event
    - `chunkUtf8AtOffsets(text: string, offsets: number[]): Uint8Array[]` — splits a UTF-8 string at arbitrary byte offsets, handling multi-byte safely
    - `makeSSEResponse(body: string | Uint8Array[]): Response` — returns a `Response` with `content-type: text/event-stream` and a chunked `ReadableStream`
    - `makeTruncatedSSEResponse(events: SSEEvent[], truncateAfter: number): Response` — emits N events, then closes the stream WITHOUT a terminator (simulates proxy kill)
    - `makeMalformedSSEResponse(rawBytes: string): Response` — emits raw bytes directly (to test malformed SSE cases)
  - Provide typed event factories for Anthropic events:
    - `messageStartEvent(overrides?)`, `contentBlockStartEvent({type, ...})`, `contentBlockDeltaEvent(...)`, `contentBlockStopEvent(index)`, `messageDeltaEvent(...)`, `messageStopEvent()`, `errorEvent(reason)`

  **Must NOT do**:
  - Hardcode UTF-8 chunking at character boundaries (must handle multi-byte)
  - Default to emitting `message_stop` — the tests need to control this explicitly

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure utility module with no runtime dependencies
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T3-T7)
  - **Blocks**: T13, T15, T23, T27
  - **Blocked By**: T0

  **References**:

  **Pattern References**:
  - `index.test.ts:1028-1076` — existing chunked ReadableStream pattern for SSE tests (limited coverage, small chunks)
  - `index.test.ts:4193-4405` — existing SSE error event tests
  - Anthropic streaming docs: https://docs.anthropic.com/en/api/messages-streaming

  **API References**:
  - `Response` constructor with `ReadableStream` body
  - `TextEncoder.encode` for UTF-8

  **WHY each reference matters**:
  - Existing tests use this shape; helper must stay compatible so inline copies can be migrated
  - Anthropic docs define the canonical SSE event structure that the helper emits

  **Acceptance Criteria**:
  - [ ] File `src/__tests__/helpers/sse.ts` exists
  - [ ] All 6 factory functions exported + typed event factories
  - [ ] `npx tsc --noEmit` — no new errors vs baseline
  - [ ] Smoke test: encode one event, parse it back, roundtrip correctness
  - [ ] Smoke test: chunk a UTF-8 string at 3 offsets, concat chunks, assert equals original
  - [ ] Smoke test: `chunkUtf8AtOffsets("café", [1, 2, 3])` correctly handles the multi-byte `é`

  **QA Scenarios**:

  ```
  Scenario: SSE helper roundtrip and chunking
    Tool: Bash (vitest)
    Preconditions: T0 baseline captured
    Steps:
      1. Create src/__tests__/helpers/sse.smoke.test.ts
      2. Test 1: encodeSSEEvent({event:'test', data:{x:1}}) → assert contains 'event: test' and 'data: {"x":1}' and terminal '\n\n'
      3. Test 2: encodeSSEStream([e1,e2], 'message_stop') → assert ends with messageStopEvent block
      4. Test 3: chunkUtf8AtOffsets("hello world", [5]) → returns 2 Uint8Arrays, concat equals original
      5. Test 4: chunkUtf8AtOffsets("café", [1,2,3]) → no Uint8Array contains an incomplete UTF-8 byte sequence when decoded individually with {stream:true}
      6. Test 5: makeTruncatedSSEResponse([contentBlockStartEvent({type:'tool_use',name:'mcp_x',id:'t1'})], 1).body.getReader() → reads the one event, then done without message_stop
    Expected Result: All 5 tests pass
    Failure Indicators: Any assertion failure; UTF-8 boundary corruption; SSE format drift from Anthropic docs
    Evidence: .sisyphus/evidence/task-2-sse-smoke.txt
  ```

  **Evidence to Capture**:
  - [ ] task-2-sse-smoke.txt

  **Commit**: YES (single commit)
  - Message: `test(infra): add sse helper with encoder, chunker, and truncated-stream builder`
  - Files: `src/__tests__/helpers/sse.ts`, `src/__tests__/helpers/sse.smoke.test.ts`
  - Pre-commit: `npx vitest run src/__tests__/helpers/sse.smoke.test.ts`

- [ ] 3. Shared helper: `src/__tests__/helpers/deferred.ts`

  **What to do**:
  - Create `src/__tests__/helpers/deferred.ts`
  - Export:
    - `createDeferred<T>(): { promise: Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void, settled: boolean }` — a controllable promise
    - `createDeferredQueue<T>(): { enqueue(): Deferred<T>, resolveNext(v: T), rejectNext(e: unknown), pending: number }` — FIFO queue for controlling N parallel callers
    - `nextTick(): Promise<void>` — await 1 microtask; useful for yielding between awaits in concurrency tests

  **Must NOT do**:
  - Depend on fake timers (deferred should work with real + fake timers)
  - Swallow rejections (unhandled rejections should still fail the test)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Trivially small utility
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1-T2, T4-T7)
  - **Blocks**: T11, T12, T14, T15 (concurrency tests need controllable promises)
  - **Blocked By**: T0

  **References**:

  **Pattern References**:
  - Inline `Promise.withResolvers()` usage in `index.test.ts` (not yet extracted)
  - Node 22+ has native `Promise.withResolvers()` — can delegate or provide compatible wrapper

  **WHY each reference matters**:
  - Concurrency tests need to force specific interleavings that real timers can't reliably produce; a `createDeferred` primitive is the canonical approach

  **Acceptance Criteria**:
  - [ ] File exists
  - [ ] All 3 helpers exported
  - [ ] Smoke test: create deferred, resolve it, assert `.promise` resolves with expected value
  - [ ] Smoke test: queue with 3 deferreds, resolveNext × 3, assert FIFO order

  **QA Scenarios**:

  ```
  Scenario: Deferred primitives work as expected
    Tool: Bash (vitest)
    Preconditions: T0
    Steps:
      1. const d = createDeferred<number>()
      2. setTimeout(() => d.resolve(42), 0)
      3. expect(await d.promise).toBe(42)
      4. expect(d.settled).toBe(true)
      5. Queue test: enqueue 3, resolveNext with 1/2/3, assert await order
    Expected Result: Both tests pass
    Failure Indicators: Promise never resolves, settled flag wrong, queue order wrong
    Evidence: .sisyphus/evidence/task-3-deferred-smoke.txt
  ```

  **Evidence to Capture**:
  - [ ] task-3-deferred-smoke.txt

  **Commit**: YES
  - Message: `test(infra): add deferred helper for controllable promise races`
  - Files: `src/__tests__/helpers/deferred.ts`, `src/__tests__/helpers/deferred.smoke.test.ts`
  - Pre-commit: `npx vitest run src/__tests__/helpers/deferred.smoke.test.ts`

- [ ] 4. Shared helper: `src/__tests__/helpers/in-memory-storage.ts`

  **What to do**:
  - Create `src/__tests__/helpers/in-memory-storage.ts`
  - Export:
    - `createInMemoryStorage(initial?: AccountStorage): InMemoryStorage`
    - `InMemoryStorage` interface with: `snapshot(): AccountStorage`, `setSnapshot(s: AccountStorage)`, `mutateDiskOnly(mut: (s: AccountStorage) => void)`, `loadAccountsMock: Mock`, `saveAccountsMock: Mock`
  - Wire the mocks via `vi.mock('../../storage.js', () => ({ loadAccounts: helper.loadAccountsMock, saveAccounts: helper.saveAccountsMock, ... }))`
  - Supports concurrent-process simulation: `mutateDiskOnly` lets a test simulate another process writing to disk between loads

  **Must NOT do**:
  - Use real filesystem (in-memory only)
  - Mutate the internal snapshot via references (callers must use `setSnapshot` or `mutateDiskOnly`)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Thin wrapper around vi.mock
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T14, T33, T36
  - **Blocked By**: T0

  **References**:

  **Pattern References**:
  - `src/storage.test.ts` — shows the shape of `AccountStorage` + test mocks
  - `src/accounts.test.ts` — uses storage mocks extensively (`vi.mock("./storage.js")`)

  **Type References**:
  - `src/storage.ts:AccountStorage`, `AccountMetadata`

  **WHY each reference matters**:
  - Tests mock storage module at the boundary; helper must follow the same pattern for drop-in compatibility
  - Concurrent-process simulation requires separating "what memory thinks is on disk" from "what disk actually has"

  **Acceptance Criteria**:
  - [ ] File exists
  - [ ] Exports `createInMemoryStorage` + `InMemoryStorage` type
  - [ ] Smoke test: create storage, set snapshot, load via mock, assert identity
  - [ ] Smoke test: `mutateDiskOnly` changes disk state without affecting in-memory snapshot used by caller

  **QA Scenarios**:

  ```
  Scenario: In-memory storage roundtrip
    Tool: Bash (vitest)
    Preconditions: T0
    Steps:
      1. const storage = createInMemoryStorage({version:1, accounts:[], activeIndex:0})
      2. storage.setSnapshot({version:1, accounts:[<cc-account>], activeIndex:0})
      3. const loaded = await storage.loadAccountsMock()
      4. expect(loaded.accounts[0].source).toBe('cc-keychain')
      5. storage.mutateDiskOnly(s => s.accounts.push(<oauth-account>))
      6. const reloaded = await storage.loadAccountsMock()
      7. expect(reloaded.accounts).toHaveLength(2)
    Expected Result: Test passes; disk-only mutation visible on next load
    Failure Indicators: Mutation not reflected; reference leak across setSnapshot calls
    Evidence: .sisyphus/evidence/task-4-inmem-smoke.txt
  ```

  **Evidence to Capture**:
  - [ ] task-4-inmem-smoke.txt

  **Commit**: YES
  - Message: `test(infra): add in-memory-storage helper for accounts dedup tests`
  - Files: `src/__tests__/helpers/in-memory-storage.ts`, `src/__tests__/helpers/in-memory-storage.smoke.test.ts`
  - Pre-commit: `npx vitest run src/__tests__/helpers/in-memory-storage.smoke.test.ts`

- [ ] 5. Shared helper: `src/__tests__/helpers/mock-bun-proxy.ts`

  **What to do**:
  - Create `src/__tests__/helpers/mock-bun-proxy.ts`
  - Export:
    - `createMockBunProxy(opts?: MockProxyOptions): MockBunProxy` — DI harness for `spawn` + stdout/stderr
    - `MockProxyOptions` interface with: `bannerDelay?: number`, `spawnError?: Error`, `forwardToMockFetch?: boolean`, `parentDeathSimulation?: boolean`
    - `MockBunProxy` interface with: `mockSpawn: Mock<typeof spawn>`, `child: ChildProcess-like`, `simulateExit(code: number, signal?: string)`, `simulateStdoutBanner()`, `simulateCrash()`, `getInFlightCount(): number`
  - The mock spawn intercepts calls to `child_process.spawn` and returns a fake child process with controllable stdout/stderr EventEmitters and a `kill` method that records signals
  - The mock proxy does NOT actually start a server; it integrates with `globalThis.fetch` mock to fake upstream responses
  - Supports concurrent-request scenarios: `forwardToMockFetch = true` passes each proxied fetch through a shared `vi.fn()` mock

  **Must NOT do**:
  - Actually spawn a subprocess (pure DI mock)
  - Use real network
  - Leak timers (all intervals must be cleanable via teardown)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Non-trivial DI layer around Node's `child_process`; cross-cutting tests depend on it
  - **Skills**: `["tooling", "testing"]`
    - `tooling`: understand subprocess lifecycle semantics
    - `testing`: vi.mock patterns and ChildProcess mocking idioms

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T11 (bun-fetch test), T12 (bun-proxy parallel test)
  - **Blocked By**: T0

  **References**:

  **Pattern References**:
  - `src/bun-fetch.ts:130-190` — existing `spawnProxy()` logic showing what to mock
  - `src/__tests__/cc-credentials.test.ts` — existing `execSync` mock pattern
  - Node `child_process.ChildProcess` API: stdout, stderr as EventEmitter streams; `on('exit')`, `kill(signal)`, `pid`

  **API References**:
  - `vi.mock` with factory function
  - `node:events.EventEmitter` for synthetic streams

  **WHY each reference matters**:
  - The real `spawnProxy` reads stdout for a banner, listens for exit events, calls kill on stop — the mock must simulate all of these
  - Existing cc-credentials mock shows the DI pattern for `child_process`

  **Acceptance Criteria**:
  - [ ] File exists
  - [ ] Exports documented API
  - [ ] Smoke test: spawn mock, trigger banner, assert child.pid set
  - [ ] Smoke test: simulate exit, assert `on('exit')` handler fires
  - [ ] Smoke test: simulate spawn error, assert spawn rejects
  - [ ] Smoke test: fire 10 concurrent fetches through the mock, assert all complete without interference

  **QA Scenarios**:

  ```
  Scenario: Mock bun proxy intercepts spawn
    Tool: Bash (vitest)
    Preconditions: T0, `vi.mock("child_process")` working
    Steps:
      1. const mock = createMockBunProxy()
      2. const child = mock.mockSpawn(...) → returns fake child
      3. mock.simulateStdoutBanner() (emits "BUN_PROXY_PORT=48532\n")
      4. Wait for the banner regex to match
      5. expect(child.pid).toBeTruthy()
      6. mock.simulateExit(0)
      7. Assert exit handler was called
    Expected Result: All 4 assertions pass
    Failure Indicators: Banner not parsed, pid undefined, exit handler not called
    Evidence: .sisyphus/evidence/task-5-mock-proxy-smoke.txt

  Scenario: Mock proxy handles 10 parallel fetches
    Tool: Bash (vitest)
    Preconditions: T0
    Steps:
      1. const mock = createMockBunProxy({forwardToMockFetch: true})
      2. Set mockFetch to respond with distinct body per call
      3. Promise.all(10 concurrent fetchViaBun calls)
      4. expect(all 10 responses to contain distinct bodies)
      5. expect(mock.getInFlightCount()).toBe(0) after all complete
    Expected Result: All 10 fetches complete distinctly
    Failure Indicators: Body cross-pollination, in-flight count wrong
    Evidence: .sisyphus/evidence/task-5-mock-proxy-parallel.txt
  ```

  **Evidence to Capture**:
  - [ ] task-5-mock-proxy-smoke.txt
  - [ ] task-5-mock-proxy-parallel.txt

  **Commit**: YES
  - Message: `test(infra): add mock-bun-proxy helper with injectable subprocess`
  - Files: `src/__tests__/helpers/mock-bun-proxy.ts`, `src/__tests__/helpers/mock-bun-proxy.smoke.test.ts`
  - Pre-commit: `npx vitest run src/__tests__/helpers/mock-bun-proxy.smoke.test.ts`

- [ ] 6. Shared helper: `src/__tests__/helpers/conversation-history.ts`

  **What to do**:
  - Create `src/__tests__/helpers/conversation-history.ts`
  - Export factory functions for building message histories:
    - `buildValidHistory(options?): MessageHistory` — well-formed assistant turn with tool_use + user turn with matching tool_result
    - `buildOrphanToolUseHistory(): MessageHistory` — assistant turn with tool_use but NO following tool_result (reproduces the reported error)
    - `buildDoublePrefixHistory(toolName: string): MessageHistory` — assistant history with `mcp_${toolName}` as name (simulates poisoned history from aborted stream)
    - `buildMismatchedToolUseIdHistory(): MessageHistory` — assistant tool_use with id X, user tool_result with id Y
    - `buildIncompleteToolUseInputHistory(): MessageHistory` — assistant tool_use with incomplete JSON input (simulates stream abort mid-delta)
  - Each returns a shape that matches the Anthropic Messages API `messages` array

  **Must NOT do**:
  - Hardcode specific tool names; make them parameterizable
  - Return mutable references (each call returns a fresh object)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure factory functions
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T16 (body history tests), T25 (body defense), T27 (stream completeness errors)
  - **Blocked By**: T0

  **References**:

  **Pattern References**:
  - Anthropic Messages API docs: https://docs.anthropic.com/en/api/messages
  - `src/request/body.ts:119-142` — shows the tool_use shape the plugin expects

  **WHY each reference matters**:
  - Helper must emit shapes that match exactly what opencode/anthropic send over the wire; otherwise tests exercise a fictional API
  - Poisoned-history simulation is the key test case for TOOL-2 double-prefix defense

  **Acceptance Criteria**:
  - [ ] File exists
  - [ ] All 5 factories exported
  - [ ] Smoke test: valid history has assistant with tool_use followed by user with matching tool_result (same id)
  - [ ] Smoke test: orphan history's next message is NOT a tool_result
  - [ ] Smoke test: double-prefix history's assistant turn name starts with `mcp_`

  **QA Scenarios**:

  ```
  Scenario: History factories return valid structures
    Tool: Bash (vitest)
    Preconditions: T0
    Steps:
      1. const valid = buildValidHistory({toolName: 'read_file'})
      2. Find assistant turn → tool_use block → id
      3. Find next user turn → tool_result block → tool_use_id
      4. expect(tool_use.id === tool_result.tool_use_id)
      5. const orphan = buildOrphanToolUseHistory()
      6. expect(next message after tool_use has NO tool_result block)
      7. const double = buildDoublePrefixHistory('read_file')
      8. expect(double.assistant tool_use name === 'mcp_read_file')
    Expected Result: All assertions pass
    Failure Indicators: ID mismatch in valid, orphan has tool_result, double-prefix not set
    Evidence: .sisyphus/evidence/task-6-history-smoke.txt
  ```

  **Evidence to Capture**:
  - [ ] task-6-history-smoke.txt

  **Commit**: YES
  - Message: `test(infra): add conversation-history helper for malformed message scenarios`
  - Files: `src/__tests__/helpers/conversation-history.ts`, `src/__tests__/helpers/conversation-history.smoke.test.ts`
  - Pre-commit: `npx vitest run src/__tests__/helpers/conversation-history.smoke.test.ts`

- [ ] 7. Register test helper globs in vitest config + Wave 1 close-out notes

  **What to do**:
  - Verify `vitest` auto-discovers `.smoke.test.ts` files in `src/__tests__/helpers/` (default globs include `**/*.test.ts`)
  - If vitest config exists, add the helpers path; if not, add a minimal `vitest.config.ts` at repo root ONLY if needed
  - Run `npx vitest run --reporter=verbose` and confirm all 6 helper smoke tests are executed
  - Verify `.sisyphus/evidence/task-7-vitest-helpers-listed.txt` shows all 6 smoke tests discovered
  - **Always create** `.sisyphus/evidence/wave-1-close-out.md` with a Wave 1 summary (regardless of whether vitest config needed changes). This ensures T7 always produces a commit and the commit-count rule in F1/F2 can be satisfied.

  **Must NOT do**:
  - Change any non-helper test globs
  - Add new vitest config options unrelated to helper discovery
  - Create a new vitest.config.ts if default discovery already works

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Config verification; likely no code changes needed
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO (this is the Wave 1 close-out verification)
  - **Parallel Group**: Wave 1 final (after T1-T6)
  - **Blocks**: Wave 2 kickoff
  - **Blocked By**: T1, T2, T3, T4, T5, T6

  **References**:

  **Pattern References**:
  - `package.json` — `"test": "vitest run"` with no custom config
  - `node_modules/vitest` — default test discovery patterns

  **WHY**:
  - Wave 1 deliverables are useless if vitest can't find the smoke tests
  - Default discovery should work; this task is defensive verification

  **Acceptance Criteria**:
  - [ ] `npx vitest run --reporter=verbose` lists all 6 smoke test files under `src/__tests__/helpers/`
  - [ ] All 6 smoke tests pass
  - [ ] No new vitest config added unless necessary

  **QA Scenarios**:

  ```
  Scenario: All helper smoke tests discovered and passing
    Tool: Bash (vitest)
    Preconditions: T1-T6 all complete
    Steps:
      1. npx vitest run --reporter=verbose 2>&1 | tee .sisyphus/evidence/task-7-vitest-helpers-listed.txt
      2. grep -c "src/__tests__/helpers/.*\\.smoke\\.test\\.ts" .sisyphus/evidence/task-7-vitest-helpers-listed.txt
      3. Expect: 6
      4. Check overall result: "Test Files  X passed" where X matches baseline + 6
    Expected Result: All 6 smoke tests discovered and pass; total test count increased by 6
    Failure Indicators: Smoke tests missing from output; any smoke test fails
    Evidence: .sisyphus/evidence/task-7-vitest-helpers-listed.txt
  ```

  **Evidence to Capture**:
  - [ ] task-7-vitest-helpers-listed.txt

  **Commit**: YES (always — T7 always produces at least the `wave-1-close-out.md` evidence commit to satisfy the commit-count rule)
  - Message: `test(infra): Wave 1 close-out — verify vitest helper discovery`
  - Files: `.sisyphus/evidence/wave-1-close-out.md` (always) + `vitest.config.ts` (ONLY if config changes were needed)
  - Pre-commit: `npx vitest run`

---

## Wave 1 Checkpoint (after T1-T7)

Run the checkpoint commands defined in the Verification Strategy section. Expected: all 6 smoke tests pass, no new tsc errors vs baseline, no build regressions. If any check fails, fix within the offending task (no cross-task drift).

---

- [ ] 8. RED: `src/circuit-breaker.test.ts` — per-client circuit breaker tests

  **What to do**:
  - Create `src/circuit-breaker.test.ts` with failing tests for the `CircuitBreaker` class that will be built in T17
  - Test coverage (each a separate `it` block):
    - `starts in CLOSED state`
    - `opens after N consecutive failures within window`
    - `half-opens after cooldown period`
    - `closes again after successful probe in HALF_OPEN`
    - `re-opens on failed probe in HALF_OPEN`
    - `per-client isolation: breaker A failures do not affect breaker B`
    - `recordSuccess resets failure counter in CLOSED state`
    - `does NOT share state across instances (no module-level singletons)`
    - `timer resets on clock change (no leaked setTimeout)`
  - Tests import from `../circuit-breaker.js` which does not yet exist → tests MUST fail at import resolution time
  - Use `vi.useFakeTimers()` for time-based state transitions

  **Must NOT do**:
  - Implement `CircuitBreaker` itself (that's T17)
  - Rely on real timers
  - Assume any global registry of breakers

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure test file, pattern-matching from existing `src/rotation.test.ts:HealthScoreTracker` tests
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2)
  - **Parallel Group**: Wave 2 (with T9-T16)
  - **Blocks**: T17 (provides the contract T17 must satisfy)
  - **Blocked By**: T0, T3 (deferred helper for timer-free concurrent tests)

  **References**:

  **Pattern References**:
  - `src/rotation.test.ts` — `HealthScoreTracker` test pattern (similar state-machine + fake timers)
  - Classic circuit breaker pattern docs (fowler.com)

  **API References**:
  - Vitest `vi.useFakeTimers`, `vi.advanceTimersByTime`

  **WHY each reference matters**:
  - Rotation tests show the canonical way to test time-based state machines in this codebase
  - Classic CB pattern defines the CLOSED → OPEN → HALF_OPEN → CLOSED cycle semantics

  **Acceptance Criteria**:
  - [ ] File exists
  - [ ] 9 `it` blocks covering listed scenarios
  - [ ] `npx vitest run src/circuit-breaker.test.ts` — tests FAIL with module resolution error (expected for RED phase)
  - [ ] Documented in test file header: "RED phase — expected to fail until T17 implements circuit-breaker.ts"

  **QA Scenarios**:

  ```
  Scenario: RED phase — tests fail at import
    Tool: Bash (vitest)
    Preconditions: Wave 1 complete
    Steps:
      1. npx vitest run src/circuit-breaker.test.ts 2>&1 | tee .sisyphus/evidence/task-8-red.txt
      2. grep -q "Cannot find module.*circuit-breaker" .sisyphus/evidence/task-8-red.txt || grep -q "failed" .sisyphus/evidence/task-8-red.txt
    Expected Result: Tests fail with module resolution error (or if T17 runs before this, tests fail at assertion level)
    Failure Indicators: Tests pass (indicates the RED assertion is wrong OR T17 sneaked in first)
    Evidence: .sisyphus/evidence/task-8-red.txt
  ```

  **Evidence to Capture**:
  - [ ] task-8-red.txt (vitest RED output)

  **Commit**: YES (TDD RED commit — uses `--no-verify` per plan's Pre-commit Hook Interaction policy)
  - Command: `git commit --no-verify -m "..."` with the standardized TDD RED message template (see Verification Strategy → Pre-commit Hook Interaction section)
  - Message: `test(circuit-breaker): add failing tests for per-client circuit breaker\n\n[standard TDD RED rationale]\nPaired GREEN task: T17`
  - Files: `src/circuit-breaker.test.ts`
  - Pre-commit: BYPASSED via `--no-verify` (TDD RED, hook would reject since tests fail intentionally)

- [ ] 9. RED: `src/parent-pid-watcher.test.ts` — cross-platform parent death detection

  **What to do**:
  - Create `src/parent-pid-watcher.test.ts` with failing tests for `ParentPidWatcher` (built in T18)
  - Test coverage:
    - `exits when parent process is gone (SIGCHLD-style)`
    - `polls at configurable interval (default 5000ms)`
    - `uses process.kill(pid, 0) to check liveness`
    - `exits with configurable exit code`
    - `does NOT poll if parentPid is invalid (0, -1, NaN)`
    - `stop() cancels the polling interval`
    - `handles ESRCH (no process) by exiting gracefully`
    - `handles EPERM (permission denied) as "parent still alive"`
    - `does NOT leak timer on stop()`
  - Use fake timers; use `vi.spyOn(process, 'kill')` to simulate PID liveness

  **Must NOT do**:
  - Actually call `process.exit` (mock it)
  - Use real timers

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Cross-platform process semantics are subtle; EPERM vs ESRCH distinction
  - **Skills**: `["tooling"]`
    - `tooling`: POSIX signal semantics + Node.js child_process / process.kill behavior

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T18, T19
  - **Blocked By**: T0

  **References**:

  **Pattern References**:
  - `src/refresh-lock.test.ts` — uses real timers for lock semantics; this test uses fake timers
  - POSIX `kill(pid, 0)` semantics

  **API References**:
  - `process.kill(pid, 0)` — throws ESRCH if gone, EPERM if no permission
  - `setInterval`, `clearInterval`

  **WHY each reference matters**:
  - ESRCH vs EPERM are the two valid outcomes on POSIX; Windows has different semantics
  - Tests must exercise both branches

  **Acceptance Criteria**:
  - [ ] File exists
  - [ ] 9 `it` blocks
  - [ ] Tests FAIL at import (T18 not yet built)
  - [ ] Header comment: "RED phase — will be GREEN after T18"

  **QA Scenarios**:

  ```
  Scenario: RED phase — parent-pid-watcher tests fail at import
    Tool: Bash (vitest)
    Preconditions: Wave 1 complete
    Steps:
      1. npx vitest run src/parent-pid-watcher.test.ts 2>&1 | tee .sisyphus/evidence/task-9-red.txt
    Expected Result: Fails with module resolution error
    Evidence: .sisyphus/evidence/task-9-red.txt
  ```

  **Evidence to Capture**:
  - [ ] task-9-red.txt

  **Commit**: YES (TDD RED — `--no-verify`)
  - Message: `test(parent-pid-watcher): add failing tests for cross-platform parent death detection\n\n[standard TDD RED rationale]\nPaired GREEN task: T18`
  - Files: `src/parent-pid-watcher.test.ts`
  - Pre-commit: BYPASSED (`--no-verify`, TDD RED)

- [ ] 10. RED: `src/account-identity.test.ts` — identity resolution and matching

  **What to do**:
  - Create `src/account-identity.test.ts` with failing tests for `account-identity.ts` (built in T29)
  - Test coverage:
    - `resolveIdentity returns oauth for OAuth accounts with email`
    - `resolveIdentity returns cc for CC accounts with source + label`
    - `resolveIdentity returns legacy for OAuth without email`
    - `resolveIdentity returns legacy for CC without label`
    - `identitiesMatch returns true for same oauth email`
    - `identitiesMatch returns false for oauth vs cc same email (intentional separation)`
    - `identitiesMatch returns true for same cc source+label`
    - `identitiesMatch returns false for cc keychain vs cc file (different source)`
    - `identitiesMatch returns true for same legacy refreshToken`
    - `findByIdentity returns correct account from array`
    - `findByIdentity returns null when no match`
    - `resolveIdentity handles missing source field (treats as oauth/legacy fallback)` — covers the DEDUP-SYNC-SOURCE sibling bug
  - Use the `in-memory-storage` helper (T4) to construct test accounts

  **Must NOT do**:
  - Implement `account-identity.ts`
  - Reuse old refresh-token-matching logic

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure predicate/factory unit tests
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T29
  - **Blocked By**: T0, T4 (in-memory-storage)

  **References**:

  **Pattern References**:
  - `src/rotation.test.ts` — pure-function test pattern
  - Draft `.sisyphus/drafts/parallel-request-fix.md` "Stable identity strategy" section

  **Type References**:
  - `src/accounts.ts:ManagedAccount`
  - `src/cc-credentials.ts:CCCredential`

  **WHY each reference matters**:
  - Draft defines the exact identity kinds; tests pin the contract
  - ManagedAccount shape informs what fields are available for resolution

  **Acceptance Criteria**:
  - [ ] File exists with 12 `it` blocks
  - [ ] Tests FAIL at import
  - [ ] Header: "RED phase — will be GREEN after T29"

  **QA Scenarios**:

  ```
  Scenario: RED phase — account-identity tests fail at import
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/account-identity.test.ts 2>&1 | tee .sisyphus/evidence/task-10-red.txt
    Expected Result: Fails with module resolution error
    Evidence: .sisyphus/evidence/task-10-red.txt
  ```

  **Evidence to Capture**:
  - [ ] task-10-red.txt

  **Commit**: YES (TDD RED — `--no-verify`)
  - Message: `test(account-identity): add failing tests for identity resolution and matching\n\n[standard TDD RED rationale]\nPaired GREEN task: T29`
  - Files: `src/account-identity.test.ts`
  - Pre-commit: BYPASSED (`--no-verify`, TDD RED)

- [ ] 11. RED: `src/bun-fetch.test.ts` — per-instance proxy manager lifecycle

  **What to do**:
  - Create `src/bun-fetch.test.ts` with failing tests for the refactored `fetchViaBun` + `ensureBunProxy` (T20)
  - Use `mock-bun-proxy` helper (T5) to inject subprocess mocks
  - Test coverage:
    - `creates a new proxy per plugin instance (no module-level state sharing)`
    - `proxy uses kernel-assigned port (Bun.serve port: 0)`
    - `banner parsed from buffered stdout (line-by-line, not per-chunk)`
    - `returns native fetch fallback when Bun unavailable`
    - `never calls stopBunProxy from within fetchViaBun catch blocks`
    - `per-request circuit breaker opens after N consecutive failures`
    - `per-request circuit breaker does NOT trip on unrelated sibling requests`
    - `10 concurrent fetches share one proxy without interference`
    - `1-of-10 concurrent fetches failing does NOT kill the other 9`
    - `1-of-10 concurrent fetches failing does NOT kill the proxy process`
    - `N=50 concurrent fetches all complete with distinct bodies` (per user constraint)
    - `exit handler tied to current child PID, not cleared for old children`
    - `hot-reload creates a new proxy instance; old instance still handles its in-flight requests`
    - `spawn error triggers graceful fallback, not process.exit`
    - `no process.on("uncaughtException") or process.on("unhandledRejection") in bun-fetch.ts after refactor`
  - Use `deferred` (T3) helper to control race timing

  **Must NOT do**:
  - Spawn real Bun subprocess
  - Assume the test file already has a passing assertion for the "no global handlers" case (that's an assertion about the source file's future state — it will pass after T21)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Concurrency + subprocess + lifecycle; ~15 test cases
  - **Skills**: `["testing", "tooling"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T20, T22
  - **Blocked By**: T0, T3, T5

  **References**:

  **Pattern References**:
  - `src/bun-fetch.ts` (current) — identify what's module-level and what needs to be closure-scoped
  - `src/__tests__/debug-gating.test.ts` — existing source-code grep tests (CAUTION: this test asserts the PRESENCE of handler strings we're removing; see T21)
  - Wave 1 `mock-bun-proxy.ts` helper

  **API References**:
  - `fetchViaBun(input, init, debug)` signature
  - `ensureBunProxy(debug)` signature

  **WHY each reference matters**:
  - Current `bun-fetch.ts` uses module-level `let proxyPort`, `let proxyProcess`, `let starting`, `let healthCheckFails` — tests must prove these become instance-scoped
  - `debug-gating.test.ts` is the trap: it asserts presence of handlers we'll remove; must update atomically with T21

  **Acceptance Criteria**:
  - [ ] File exists with 15 `it` blocks covering listed scenarios
  - [ ] Tests FAIL (existing `bun-fetch.ts` has global state, so "no module-level state" assertions fail now)
  - [ ] Header: "RED phase — some tests may already pass against existing bun-fetch; marked expected-fail via .todo() or .skip with comment"
  - [ ] Concurrent-request tests use `deferred` primitives, NOT real timing

  **QA Scenarios**:

  ```
  Scenario: RED phase — bun-fetch tests fail
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/bun-fetch.test.ts 2>&1 | tee .sisyphus/evidence/task-11-red.txt
    Expected Result: Multiple test failures documented in the output; NO passing-but-wrong cases
    Failure Indicators: All tests pass (indicates assertions are too weak or T20 ran first)
    Evidence: .sisyphus/evidence/task-11-red.txt
  ```

  **Evidence to Capture**:
  - [ ] task-11-red.txt

  **Commit**: YES (TDD RED — `--no-verify`)
  - Message: `test(bun-fetch): add failing tests for per-instance proxy manager lifecycle\n\n[standard TDD RED rationale]\nPaired GREEN task: T20 (atomic with T21)`
  - Files: `src/bun-fetch.test.ts`
  - Pre-commit: BYPASSED (`--no-verify`, TDD RED)

- [ ] 12. RED: `src/__tests__/bun-proxy.parallel.test.ts` — single proxy handles N concurrent requests

  **What to do**:
  - Create `src/__tests__/bun-proxy.parallel.test.ts` with failing tests that encode the user's "each proxy process must handle parallel requests" constraint (T19)
  - Use `mock-bun-proxy` helper (T5) + `sse` helper (T2)
  - Test coverage:
    - `single proxy handles 10 concurrent fetches with distinct bodies`
    - `single proxy handles 50 concurrent fetches with distinct bodies` (AC-PAR1)
    - `concurrent SSE streams maintain per-stream event ordering` (AC-PAR2)
    - `canceling 1 of 10 requests does not affect siblings` (AC-PAR4)
    - `upstream timeout of 1 does not cascade` (AC-PAR5)
    - `no module-level state in bun-proxy.ts fetch handler` (grep + AST check)
    - `parent-PID watcher exits subprocess on parent death` (uses parent-pid-watcher mock)
    - `client disconnect propagates AbortSignal to upstream fetch` (BPSP-2)
    - `request body buffering does not cross-pollinate concurrent requests`
    - `upstream fetch is tied to incoming request signal`

  **Must NOT do**:
  - Use real network
  - Assume any ordering between unrelated concurrent requests

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: High-concurrency tests + lifecycle
  - **Skills**: `["testing"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T19
  - **Blocked By**: T0, T2, T3, T5, T9

  **References**:

  **Pattern References**:
  - `src/bun-proxy.ts` (current) — confirm what's stateless
  - Bun.serve docs: `https://bun.sh/docs/api/http`

  **WHY**:
  - User's explicit constraint: "each proxy process can handle parallel requests for many sub-agents"
  - Tests must encode N=50 as an executable assertion

  **Acceptance Criteria**:
  - [ ] File exists with 10 `it` blocks
  - [ ] Tests FAIL (import error OR assertion error)
  - [ ] The N=50 parallel test is explicit and visible in test name

  **QA Scenarios**:

  ```
  Scenario: RED phase
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/__tests__/bun-proxy.parallel.test.ts 2>&1 | tee .sisyphus/evidence/task-12-red.txt
    Expected Result: Failures documented
    Evidence: .sisyphus/evidence/task-12-red.txt
  ```

  **Evidence to Capture**:
  - [ ] task-12-red.txt

  **Commit**: YES (TDD RED — `--no-verify`)
  - Message: `test(bun-proxy): add failing parallel request tests (N=50, cancellation isolation)\n\n[standard TDD RED rationale]\nPaired GREEN task: T19`
  - Files: `src/__tests__/bun-proxy.parallel.test.ts`
  - Pre-commit: BYPASSED (`--no-verify`, TDD RED)

- [ ] 13. RED: `src/response/streaming.test.ts` — SSE edge cases + message_stop semantics

  **What to do**:
  - Create `src/response/streaming.test.ts` (currently does not exist)
  - Use `sse` helper (T2)
  - Test coverage from the SSE agent analysis (each is a direct regression test for a numbered finding):
    - SSE-1: `buffers newline-free chunks until EOF without unbounded growth`
    - SSE-3: `truncated final SSE event without blank-line terminator is NOT flushed as valid output`
    - SSE-4: `malformed final event on parser side does not silently corrupt callbacks`
    - SSE-5: `truncated stream after content_block_start(tool_use) surfaces an error to the consumer`
    - SSE-7: `multi-data-line SSE event with tool_use name is correctly rewritten`
    - SSE-9: `parser and rewriter see the same logical events (unified framing)`
    - SSE-10: `mid-stream error event does not bleed into downstream output after accountErrorHandled`
    - SSE-14: `non-SSE JSON response is NOT wrapped in SSE transform`
    - SSE-15: `final TextDecoder.decode() flush is called at EOF`
    - STREAM-COMPLETENESS: `stream closed without message_stop or event:error surfaces as error`
    - `cancel() on the wrapper propagates to the underlying reader`
    - `tool_use.id is preserved through the rewrite pipeline` (TOOL-ID-SAFE guard)
    - `tool_use.name prefix is stripped exactly once (no under-stripping)`
    - `stream with only text content_block and no tool_use passes through unchanged`
  - Use `deferred` (T3) for stream control; use `chunkUtf8AtOffsets` for byte-level chunking

  **Must NOT do**:
  - Test the mcp.ts non-SSE path here (that's T14 — wait, actually T24 is the fix, so RED goes in this file as SSE-14 above but also in the next file)
  - Depend on `transformResponse` being modified yet

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: ~14 edge cases, streaming semantics, multi-byte handling
  - **Skills**: `["testing"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T23, T24, T27
  - **Blocked By**: T0, T2, T3

  **References**:

  **Pattern References**:
  - `index.test.ts:1028-1160` — existing streaming coverage; MUST keep passing after our refactor
  - Draft section "DEEP AGENT FINDINGS: SSE Streaming" for exact bug descriptions

  **API References**:
  - `src/response/streaming.ts:transformResponse` — the function under test
  - `src/response/mcp.ts:stripMcpPrefixFromParsedEvent`

  **WHY**:
  - Each test corresponds 1:1 to a finding in the draft; the RED → GREEN transition proves the fix
  - Existing integration tests in `index.test.ts` must keep passing — this file targets edge cases they don't cover

  **Acceptance Criteria**:
  - [ ] File exists with 14 `it` blocks
  - [ ] Every `it` maps to a bug ID in the draft (name the test with the ID in the description)
  - [ ] Tests FAIL against the current `streaming.ts`
  - [ ] Existing `index.test.ts` tests still pass

  **QA Scenarios**:

  ```
  Scenario: RED phase — streaming edge cases fail against current impl
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/response/streaming.test.ts 2>&1 | tee .sisyphus/evidence/task-13-red.txt
      2. grep -c "FAIL" .sisyphus/evidence/task-13-red.txt
      3. Expect: at least 10 failures (some tests may pass if the bug is partial)
      4. npx vitest run index.test.ts 2>&1 | tee .sisyphus/evidence/task-13-regression.txt
      5. grep -c "FAIL" .sisyphus/evidence/task-13-regression.txt
      6. Expect: same as T0 baseline (no regression)
    Expected Result: streaming.test.ts has ≥10 failures; index.test.ts matches baseline
    Evidence: .sisyphus/evidence/task-13-red.txt, task-13-regression.txt
  ```

  **Evidence to Capture**:
  - [ ] task-13-red.txt
  - [ ] task-13-regression.txt

  **Commit**: YES (TDD RED — `--no-verify`)
  - Message: `test(streaming): add failing tests for SSE edge cases and message_stop semantics\n\n[standard TDD RED rationale]\nPaired GREEN task: T23 (+T24, T27 for related fixes)`
  - Files: `src/response/streaming.test.ts`
  - Pre-commit: BYPASSED (`--no-verify`, TDD RED)

- [ ] 14. RED: `src/accounts.dedup.test.ts` — identity-based dedup across rotation cycles

  **What to do**:
  - Create `src/accounts.dedup.test.ts`
  - Use `in-memory-storage` (T4) + `account-identity` (target of T29) + `conversation-history` helpers
  - Test coverage:
    - `CC rotation cycle does not create duplicate accounts` (simulate 10 cycles)
    - `OAuth re-login for same email updates in place` (DEDUP-B)
    - `CC auto-detect at startup deduplicates rotated credentials` (DEDUP-C)
    - `addAccount with rotated refreshToken but same email updates in place` (DEDUP-D)
    - `addAccount respects MAX_ACCOUNTS even in CC auto-detect path` (DEDUP-MAX-BYPASS)
    - `syncActiveIndexFromDisk preserves source field` (DEDUP-SYNC-SOURCE)
    - `syncActiveIndexFromDisk preserves in-flight account references` (REFRESH-STALE-REFS — partial)
    - `saveToDisk unions disk-only accounts from a concurrent writer` (DEDUP-SAVE-UNION)
    - `CC and OAuth accounts with same email are kept SEPARATE`
    - `authFallback dedup uses stable identity, not just refresh token` (DEDUP-AUTH-FALLBACK)
    - `cmdLogin CLI path does not create duplicates on repeated login` (DEDUP-CLI)
    - `account_uuid remains stable across token rotations` (DEDUP-ID-CHURN)
    - `load tolerates storage.version != CURRENT_VERSION without wiping`

  **Must NOT do**:
  - Implement fixes (Wave 5 job)
  - Depend on real file system

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: 13 scenarios across multiple flows
  - **Skills**: `["testing"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T29, T30, T31, T32, T33, T34
  - **Blocked By**: T0, T4, T6

  **References**:

  **Pattern References**:
  - `src/accounts.test.ts` — existing shape, extend
  - Draft section "DEEP AGENT FINDINGS: Account Dedup" for exact bug IDs

  **API References**:
  - Target: `src/account-identity.ts` (T29)
  - `src/accounts.ts:AccountManager`

  **WHY**:
  - Every bug ID in the draft becomes an executable test; plan compliance is auditable against this file

  **Acceptance Criteria**:
  - [ ] File exists with 13 `it` blocks
  - [ ] Tests FAIL against current code
  - [ ] Header links each test to its bug ID

  **QA Scenarios**:

  ```
  Scenario: RED phase — dedup tests fail against current code
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/accounts.dedup.test.ts 2>&1 | tee .sisyphus/evidence/task-14-red.txt
      2. Expect ≥12 failures (some may partially pass)
    Evidence: .sisyphus/evidence/task-14-red.txt
  ```

  **Evidence to Capture**:
  - [ ] task-14-red.txt

  **Commit**: YES (TDD RED — `--no-verify`)
  - Message: `test(accounts): add failing tests for identity-first dedup across rotations\n\n[standard TDD RED rationale]\nPaired GREEN tasks: T29, T30, T31, T32, T33, T34`
  - Files: `src/accounts.dedup.test.ts`
  - Pre-commit: BYPASSED (`--no-verify`, TDD RED)

- [ ] 15. RED: `src/__tests__/index.parallel.test.ts` — concurrent fetch interceptor fan-out

  **What to do**:
  - Create `src/__tests__/index.parallel.test.ts`
  - Use `plugin-fetch-harness` (T1) + `sse` (T2) + `deferred` (T3)
  - Test coverage:
    - `10 concurrent auth.loader.fetch calls all complete successfully`
    - `1-of-10 induced transport failure does not affect the other 9`
    - `50 concurrent calls with delayed mock responses complete correctly` (mirror of AC-PAR1 at plugin level)
    - `mid-stream error in call 1 marks account failed; calls 2-10 rotate to account 2`
    - `stream abort in call 1 does NOT trigger proxy restart`
    - `concurrent calls on different accounts refresh tokens independently`
    - `concurrent calls on SAME account coalesce refresh via single-flight`
    - `body clone-before-use: retrying a call after 500 uses the SAME body content`
    - `hot-reload of plugin closure does not break in-flight old-closure calls`
    - `per-request circuit breaker does not share state across concurrent calls`

  **Must NOT do**:
  - Use real subprocess (VITEST=1 short-circuit)
  - Test without the harness

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Integration-level concurrency
  - **Skills**: `["testing"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T20, T26
  - **Blocked By**: T0, T1, T2, T3

  **References**:

  **Pattern References**:
  - `index.test.ts` — existing integration test pattern
  - Draft section "USER-ADDED CONSTRAINT"

  **WHY**:
  - The user's reported bugs are at this level of integration — must reproduce them
  - Wave 3-5 fixes are validated at this boundary

  **Acceptance Criteria**:
  - [ ] File exists with 10 `it` blocks
  - [ ] Tests FAIL against current code
  - [ ] Uses the harness, not ad-hoc setup

  **QA Scenarios**:

  ```
  Scenario: RED phase — parallel integration tests fail
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/__tests__/index.parallel.test.ts 2>&1 | tee .sisyphus/evidence/task-15-red.txt
    Expected Result: Multiple failures
    Evidence: .sisyphus/evidence/task-15-red.txt
  ```

  **Evidence to Capture**:
  - [ ] task-15-red.txt

  **Commit**: YES (TDD RED — `--no-verify`)
  - Message: `test(index): add failing tests for concurrent fetch interceptor fan-out\n\n[standard TDD RED rationale]\nPaired GREEN tasks: T20, T26`
  - Files: `src/__tests__/index.parallel.test.ts`
  - Pre-commit: BYPASSED (`--no-verify`, TDD RED)

- [ ] 16. RED: `src/request/body.history.test.ts` — tool name drift and double-prefix defense

  **What to do**:
  - Create `src/request/body.history.test.ts`
  - Use `conversation-history` helper (T6)
  - Test coverage:
    - `outbound body with clean history prefixes tool_use.name correctly`
    - `outbound body with already-prefixed historical tool_use.name does NOT double-prefix` (TOOL-2)
    - `outbound body with tools[].name correctly prefixes tool definitions`
    - `outbound body does NOT touch tool_use.id`
    - `outbound body does NOT touch tool_result.tool_use_id`
    - `transformRequestBody throws a clear error on non-string body` (BODY-1)
    - `transformRequestBody clones body for retry safety` (BODY-2)
    - `request with Request object body and empty init.body uses the Request's body` (BODY-3)
    - `tool definitions with original "mcp_*" names are NOT double-prefixed` (preserves existing test semantics)
    - `body with ReadableStream is rejected with actionable error message`

  **Must NOT do**:
  - Implement the fix
  - Break existing `index.test.ts` tests about tool name prefixing

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure body transform unit tests
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: T25
  - **Blocked By**: T0, T6

  **References**:

  **Pattern References**:
  - `index.test.ts:1078-1123` — existing tool prefix tests that must stay passing
  - `src/request/body.ts:119-142` — current logic

  **WHY**:
  - Drift between this test and the existing tool-name tests would indicate the fix broke something
  - Double-prefix defense is the ONLY way to prevent history poisoning for users with prior orphan errors

  **Acceptance Criteria**:
  - [ ] File exists with 10 `it` blocks
  - [ ] Tests FAIL for TOOL-2, BODY-1, BODY-2, BODY-3 cases (those are the bugs); pass for the "clean history" happy path
  - [ ] Existing `index.test.ts` tool-name tests unchanged

  **QA Scenarios**:

  ```
  Scenario: RED phase — body history tests partially fail
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/request/body.history.test.ts 2>&1 | tee .sisyphus/evidence/task-16-red.txt
      2. grep -c "FAIL" .sisyphus/evidence/task-16-red.txt
      3. Expect: 4-6 failures (the bug cases); 4-6 passes (the happy paths)
      4. npx vitest run index.test.ts -t "tool" 2>&1 | tee .sisyphus/evidence/task-16-regression.txt
      5. Expect: all existing tool tests still pass
    Evidence: .sisyphus/evidence/task-16-red.txt, task-16-regression.txt
  ```

  **Evidence to Capture**:
  - [ ] task-16-red.txt
  - [ ] task-16-regression.txt

  **Commit**: YES (TDD RED — `--no-verify`)
  - Message: `test(body): add failing tests for tool name drift and double-prefix defense\n\n[standard TDD RED rationale]\nPaired GREEN task: T25`
  - Files: `src/request/body.history.test.ts`
  - Pre-commit: BYPASSED (`--no-verify`, TDD RED)

---

## Wave 2 Checkpoint (after T8-T16)

Run: `npx vitest run` — expect the suite count to INCREASE by ~100 new tests (9 files × ~10-15 tests each), and expect ~90-100 of them to FAIL (the RED phase). Expect the existing 663 tests to still pass unchanged. Capture output to `.sisyphus/evidence/wave-2-checkpoint.txt`.

**Exit criteria**:

- Wave 2 tasks T8-T16 all complete
- New failing tests: 90-100
- Existing tests: 663 passing (no regressions)
- `npx tsc --noEmit`: no new errors vs T0 baseline
- `npm run build`: unchanged

---

- [ ] 17. GREEN: `src/circuit-breaker.ts` — per-client circuit breaker primitive

  **What to do**:
  - Create `src/circuit-breaker.ts`
  - Export `CircuitBreaker` class with:
    - Constructor: `new CircuitBreaker({ failureThreshold: number; cooldownMs: number; halfOpenMaxAttempts?: number })`
    - `recordSuccess(): void` — resets failures in CLOSED; closes in HALF_OPEN
    - `recordFailure(): void` — increments; opens on threshold
    - `canProceed(): boolean` — true if CLOSED or HALF_OPEN (probe allowed)
    - `state(): 'CLOSED' | 'OPEN' | 'HALF_OPEN'` — current state
    - `stop(): void` — clear any internal timers
  - Use `setTimeout` for cooldown → HALF_OPEN transition; cancelable via `stop()`
  - NO module-level state; every caller creates their own instance
  - Export `CircuitBreakerOptions` interface

  **Must NOT do**:
  - Add any global/singleton breaker
  - Share state between instances
  - Leak timers

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: State machine correctness under concurrent access
  - **Skills**: `["backend"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T18)
  - **Blocks**: T20
  - **Blocked By**: T8

  **References**:

  **Pattern References**:
  - `src/rotation.ts:HealthScoreTracker` — existing class with similar state management shape
  - Classic circuit breaker: CLOSED → (failures ≥ threshold) → OPEN → (cooldown) → HALF_OPEN → (success) → CLOSED | (failure) → OPEN

  **WHY**: Encapsulates per-request failure policy without global counter; T8 tests pin the exact contract.

  **Acceptance Criteria**:
  - [ ] File exists
  - [ ] `npx vitest run src/circuit-breaker.test.ts` — ALL 9 tests PASS (from T8 RED)
  - [ ] `npx tsc --noEmit` — no new errors
  - [ ] No module-level mutable state (verified via `rg "^let |^var " src/circuit-breaker.ts` → 0 results)

  **QA Scenarios**:

  ```
  Scenario: Circuit breaker T8 tests go GREEN
    Tool: Bash (vitest)
    Preconditions: T8 complete, tests currently failing
    Steps:
      1. npx vitest run src/circuit-breaker.test.ts 2>&1 | tee .sisyphus/evidence/task-17-green.txt
      2. grep "9 passed" .sisyphus/evidence/task-17-green.txt
      3. rg "^let |^var " src/circuit-breaker.ts 2>&1 | tee .sisyphus/evidence/task-17-no-globals.txt
      4. Expect: no module-level mutable state
    Expected Result: 9/9 tests pass; no globals
    Failure Indicators: Test failure, any `let`/`var` outside functions/classes
    Evidence: .sisyphus/evidence/task-17-green.txt, task-17-no-globals.txt
  ```

  **Evidence to Capture**: task-17-green.txt, task-17-no-globals.txt

  **Commit**: YES
  - Message: `feat(circuit-breaker): implement per-client circuit breaker primitive`
  - Files: `src/circuit-breaker.ts`
  - Pre-commit: `npx vitest run src/circuit-breaker.test.ts && npx tsc --noEmit`

- [ ] 18. GREEN: `src/parent-pid-watcher.ts` — cross-platform parent death detection

  **What to do**:
  - Create `src/parent-pid-watcher.ts`
  - Export `ParentPidWatcher` class with:
    - Constructor: `new ParentPidWatcher({ parentPid: number; pollIntervalMs?: number; onParentGone: () => void })`
    - `start(): void` — begins polling via `setInterval`
    - `stop(): void` — clears interval
  - Polling logic: `try { process.kill(parentPid, 0) } catch (e) { if (e.code === 'ESRCH') onParentGone(); }`
  - Treat `EPERM` as "parent still alive" (not gone; just different uid)
  - Default `pollIntervalMs` = 5000
  - Reject invalid parentPid (0, -1, NaN) with a clear error
  - Export factory helper `watchParentAndExit(parentPid, code = 0)` that calls `process.exit(code)` when parent is gone (convenience for `bun-proxy.ts` subprocess)

  **Must NOT do**:
  - Use `prctl(PR_SET_PDEATHSIG)` (Linux-only, not in Node)
  - Call `process.exit` from the class itself (only from the factory helper)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Cross-platform process semantics
  - **Skills**: `["tooling"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: T19
  - **Blocked By**: T9

  **References**:

  **Pattern References**:
  - POSIX `kill(pid, 0)` semantics; Node `process.kill` docs
  - `src/refresh-lock.ts` — similar defensive EACCES/ESRCH handling

  **WHY**: Node does not expose `prctl(PR_SET_PDEATHSIG)`, so subprocess must actively poll. T9 tests pin the contract.

  **Acceptance Criteria**:
  - [ ] File exists
  - [ ] `npx vitest run src/parent-pid-watcher.test.ts` — ALL 9 tests pass (from T9)
  - [ ] `watchParentAndExit` factory exported for subprocess use
  - [ ] No module-level state

  **QA Scenarios**:

  ```
  Scenario: Parent PID watcher T9 tests go GREEN
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/parent-pid-watcher.test.ts 2>&1 | tee .sisyphus/evidence/task-18-green.txt
      2. Expect 9/9 pass
    Evidence: .sisyphus/evidence/task-18-green.txt
  ```

  **Evidence to Capture**: task-18-green.txt

  **Commit**: YES
  - Message: `feat(parent-pid-watcher): implement cross-platform parent death detection`
  - Files: `src/parent-pid-watcher.ts`
  - Pre-commit: `npx vitest run src/parent-pid-watcher.test.ts`

- [ ] 19. GREEN: `src/bun-proxy.ts` rewrite — per-request lifecycle + parent watcher + buffered stdout

  **What to do**:
  - Rewrite `src/bun-proxy.ts` (full replacement of the subprocess entry point):
    - Parse `--parent-pid=<n>` from `process.argv` and start `ParentPidWatcher` on startup; exit(0) when parent is gone
    - Start `Bun.serve({ port: 0, fetch: async (req) => { ... } })` (kernel-assigned port)
    - Emit `BUN_PROXY_PORT=<port>\n` to `process.stdout` once (after server is listening); use `process.stdout.write` via a line-buffer to guarantee full-line delivery
    - In the `fetch` handler:
      - Read the `x-proxy-url` header to determine upstream URL; reject with 400 if missing or not allowlisted (`api.anthropic.com` + `platform.claude.com`)
      - Clone headers, strip `x-proxy-url` and `host`
      - Forward the request body with `req.arrayBuffer()` (existing pattern — document the trade-off in a code comment)
      - Tie the upstream fetch `AbortSignal` to the incoming request signal (`AbortSignal.any([req.signal, AbortSignal.timeout(600_000)])`) — BPSP-2 fix
      - Stream the response body back unchanged
    - NO module-level mutable state inside the fetch handler (verified via ast-grep check)
    - Graceful shutdown on SIGTERM/SIGINT (close server, exit 0)
    - Log errors to stderr with a buffered line writer (never sync-blocking)
  - Update `scripts/build.ts` if needed to keep `dist/bun-proxy.mjs` in sync with the rewritten source (check first; likely no change)

  **Must NOT do**:
  - Add any module-level mutable state outside server bootstrap
  - Add queue/mutex/rate-limit logic in the subprocess
  - Forward requests to arbitrary URLs (allowlist enforcement)
  - Use `synchronous stdout writes` (use `process.stdout.write` with proper flush)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Cross-cutting subprocess redesign
  - **Skills**: `["backend", "tooling"]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T17, T18, T20, T21, T22)
  - **Blocks**: T20, T28, T41
  - **Blocked By**: T12, T18

  **References**:

  **Pattern References**:
  - `src/bun-proxy.ts` (current) — baseline; identify what to keep vs replace
  - Bun docs: `Bun.serve({ port: 0 })` + `req.signal` wiring
  - `src/__tests__/bun-proxy.parallel.test.ts` — contract from T12

  **API References**:
  - `Bun.serve` options
  - `AbortSignal.any` (Node 20+)

  **Type References**:
  - Bun global types (ambient)

  **WHY**: Addresses BPSP-1/2/3 (body lifecycle + cancellation), BP-12 (buffered banner), and user's AC-PAR1-5 (N=50 parallel).

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/__tests__/bun-proxy.parallel.test.ts` — ALL 10 tests pass (from T12)
  - [ ] `rg "^(let|const)\s+(?!PORT|serve|server|allowlist)" src/bun-proxy.ts` — no module-level mutable state
  - [ ] `ast-grep` verifies no `await` before upstream fetch that could serialize
  - [ ] Build artifact `dist/bun-proxy.mjs` produced and valid
  - [ ] Manual smoke: start with `--parent-pid=$$`, kill parent, proxy exits within 10s

  **QA Scenarios**:

  ```
  Scenario: Bun proxy T12 parallel tests go GREEN
    Tool: Bash (vitest + smoke)
    Steps:
      1. npx vitest run src/__tests__/bun-proxy.parallel.test.ts 2>&1 | tee .sisyphus/evidence/task-19-green.txt
      2. Expect: 10/10 pass
      3. rg "^(let|const)\s+" src/bun-proxy.ts | grep -vE "(PORT|serve|server|allowlist|PARENT_PID)" > .sisyphus/evidence/task-19-no-globals.txt
      4. Expect: empty file (no module-level mutable state)
      5. npm run build && ls dist/bun-proxy.mjs
    Expected Result: 10/10, no globals, dist produced
    Evidence: task-19-green.txt, task-19-no-globals.txt

  Scenario: Parent death triggers subprocess exit
    Tool: Bash (interactive_bash via tmux)
    Steps:
      1. Write a parent-kill-test.sh that spawns bun dist/bun-proxy.mjs --parent-pid=$$ in background
      2. Wait for BUN_PROXY_PORT banner
      3. Kill the parent shell via SIGKILL
      4. Poll for child exit via `kill -0 $child_pid` (expect ESRCH within 10s)
    Expected Result: Child exits within 10s
    Evidence: .sisyphus/evidence/task-19-parent-death.txt
  ```

  **Evidence to Capture**: task-19-green.txt, task-19-no-globals.txt, task-19-parent-death.txt

  **Commit**: YES
  - Message: `refactor(bun-proxy): rewrite subprocess for per-request lifecycle and parent-PID watcher`
  - Files: `src/bun-proxy.ts`, potentially `scripts/build.ts` (only if required)
  - Pre-commit: `npx vitest run src/__tests__/bun-proxy.parallel.test.ts && npm run build`

- [ ] 20. GREEN: `src/bun-fetch.ts` rewrite — per-instance manager, no global state, no restart-kill

  **What to do**:
  - Rewrite `src/bun-fetch.ts` entirely:
    - Remove module-level state: `proxyPort`, `proxyProcess`, `starting`, `healthCheckFails`, `MAX_HEALTH_FAILS`, `exitHandlerRegistered`, `_hasBun` (keep `_hasBun` — it's a pure cache for `which bun` and safe as global)
    - Export a `createBunFetch({ debug?: boolean; onProxyStatus?: (s: ProxyStatus) => void }): BunFetchInstance` factory
    - `BunFetchInstance` interface: `{ fetch(input, init): Promise<Response>; shutdown(): Promise<void>; getStatus(): ProxyStatus }`
    - Each instance owns its own `proxyProcess` (child handle), `proxyPort`, `circuitBreaker`, `startingPromise`
    - Spawn via `spawn(bun, [proxyScriptPath, '--parent-pid', String(process.pid)], { stdio: ['ignore', 'pipe', 'pipe'] })` — **NOT detached**, **NOT unref-ed** so child dies with parent via process group
    - Parse banner from a line-buffered stdout reader (use `readline.createInterface` on `child.stdout`)
    - Per-request flow:
      1. `canProceed = instance.circuitBreaker.canProceed()`; if false, fall back to native fetch with warning log
      2. Call `child`-backed fetch
      3. On success: `recordSuccess`; return
      4. On failure: `recordFailure`; if breaker now OPEN, log + fall back to native fetch for THIS request only; return
    - NEVER call `stopBunProxy` from the catch path
    - `shutdown()` sends SIGTERM then SIGKILL after a grace period
    - Exit handler scoped to the instance's child via closure; verifies `this.proxyProcess === exitedChild` before clearing
  - Update `src/index.ts` to call `createBunFetch()` inside the plugin factory closure (one instance per plugin load)
  - Provide a `VITEST=1` short-circuit inside `createBunFetch` that returns a pass-through to `globalThis.fetch` (preserves existing test mock path)

  **Must NOT do**:
  - Keep ANY of: `let proxyPort`, `let proxyProcess`, `let starting`, `let healthCheckFails`, `let exitHandlerRegistered`
  - Kill proxy from within a fetch catch block
  - Unref the child
  - Use `detached: true`
  - Install `process.on('uncaughtException' | 'unhandledRejection' | 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'beforeExit')` (that's T21)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Cross-cutting refactor with strict invariants
  - **Skills**: `["backend", "tooling"]`

  **Parallelization**:
  - **Can Run In Parallel**: NO (T21 is atomic with this)
  - **Parallel Group**: Wave 3 — sequential with T21
  - **Blocks**: T22, T26, T41
  - **Blocked By**: T11, T15, T17, T19

  **References**:

  **Pattern References**:
  - `src/bun-fetch.ts` (current) — identify what must move to closure
  - `src/refresh-helpers.ts:createRefreshHelpers` — existing factory-returns-closure pattern; mirror this

  **API References**:
  - `node:child_process.spawn`
  - `node:readline.createInterface` for line-buffered stdout
  - `CircuitBreaker` (T17)
  - `ParentPidWatcher` (T18) — for the PROXY side (already handled in T19)

  **WHY**: Fixes BP-1 through BP-12, host safety HOST-1/2/3 via T21 atomic pair.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/bun-fetch.test.ts` — ALL 15 tests pass (from T11)
  - [ ] `npx vitest run src/__tests__/index.parallel.test.ts` — ALL 10 tests pass (from T15)
  - [ ] `rg "healthCheckFails|MAX_HEALTH_FAILS" src/` — 0 matches
  - [ ] `rg "48372|FIXED_PORT" src/` — 0 matches
  - [ ] `rg "opencode-bun-proxy\.pid|PID_FILE" src/` — 0 matches
  - [ ] `rg "^let (proxyPort|proxyProcess|starting|exitHandlerRegistered)" src/bun-fetch.ts` — 0 matches
  - [ ] **Full suite: no NEW failures vs T0 baseline.** Any existing test that newly fails BECAUSE of T20's changes MUST be updated within the SAME commit (atomic-commit principle). The bulk cross-API test updates are captured in T40, but same-file adjacent updates stay atomic here. If a test breaks in a file outside `src/bun-fetch.ts`/`src/index.ts`/`src/__tests__/debug-gating.test.ts`, defer to T40.

  **QA Scenarios**:

  ```
  Scenario: Bun fetch T11 + T15 tests go GREEN
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/bun-fetch.test.ts 2>&1 | tee .sisyphus/evidence/task-20-green-bun-fetch.txt
      2. npx vitest run src/__tests__/index.parallel.test.ts 2>&1 | tee .sisyphus/evidence/task-20-green-index-parallel.txt
      3. Run all guardrail greps; expect 0 matches
      4. npx vitest run 2>&1 | tee .sisyphus/evidence/task-20-full-suite.txt
      5. Expect: all tests pass (existing + new)
    Expected Result: All assertions hold
    Evidence: task-20-*.txt
  ```

  **Evidence to Capture**: task-20-green-bun-fetch.txt, task-20-green-index-parallel.txt, task-20-full-suite.txt, task-20-guardrail-greps.txt

  **Commit**: (atomic with T21 — one commit, both tasks)
  - Message: `refactor(bun-fetch): per-instance proxy manager with no restart-kill and no global handlers`
  - Files: `src/bun-fetch.ts`, `src/index.ts` (plugin factory integration), `src/__tests__/debug-gating.test.ts`
  - Pre-commit: `npx vitest run && npx tsc --noEmit && rg "healthCheckFails|MAX_HEALTH_FAILS|48372|FIXED_PORT|opencode-bun-proxy\.pid|PID_FILE" src/ ; rg 'process\.on\s*\(\s*["'"'"']uncaughtException|process\.on\s*\(\s*["'"'"']unhandledRejection' src/ ; [ $? -ne 0 ] || (echo "guardrail violation" && false)`

- [ ] 21. GREEN: remove global process handlers + update `debug-gating.test.ts` (ATOMIC with T20)

  **What to do**:
  - In the SAME commit as T20 (atomic pair):
    - Verify `src/bun-fetch.ts` after the T20 rewrite contains NONE of the following: `process.on("uncaughtException"`, `process.on("unhandledRejection"`, `process.on("SIGINT"`, `process.on("SIGTERM"`, `process.on("SIGHUP"`, `process.on("beforeExit"`, any `process.exit(` call
    - Remove the `registerExitHandler()` function and all its call sites if any remain after T20 (the current implementation uses this at `bun-fetch.ts:24-68`)
    - Update `src/__tests__/debug-gating.test.ts` at the assertions around lines 33-39:
      - Change `expect(source).toContain("uncaughtException")` → `expect(source).not.toContain("uncaughtException")`
      - Change `expect(source).toContain("unhandledRejection")` → `expect(source).not.toContain("unhandledRejection")`
      - Add new assertion: `expect(source).not.toMatch(/process\.on\s*\(\s*["']SIGINT["']\s*,/)` (and same for SIGTERM, SIGHUP, beforeExit)
      - Add new assertion: `expect(source).not.toMatch(/process\.exit\s*\(/)` to catch any lingering `process.exit` call
      - Preserve every OTHER assertion in `debug-gating.test.ts` unchanged (the file has other grep-style assertions about debug gating of console logging; leave those alone)
    - Update the test file header comment to document: "As of T21, these assertions enforce that bun-fetch.ts NEVER installs global process handlers or calls process.exit. If you need cleanup at shutdown, scope it to the plugin instance via `createBunFetch({ ... }).shutdown()`."
    - Run the full suite to confirm no downstream tests depend on the removed handlers
  - Both T20 and T21 changes land in ONE commit (the commit message is owned by T20; T21 contributes the `debug-gating.test.ts` changes)

  **Must NOT do**:
  - Leave any `process.on("uncaughtException")` or `process.on("unhandledRejection")` handler anywhere in `src/` (test files are allowed to reference these strings only inside `toContain`/`not.toContain`/`toMatch` expectations)
  - Split this into a separate commit from T20 (would leave the suite red between commits)
  - Delete `debug-gating.test.ts` (just update the assertions)
  - Leave any stale assertion that still expects the old handler strings
  - Remove any debug-gating assertion that is unrelated to the `uncaughtException`/`unhandledRejection`/`SIGINT`/`SIGTERM`/`SIGHUP`/`beforeExit`/`process.exit` patterns

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Must be atomic with T20; breaking `debug-gating.test.ts` cascades to the full suite
  - **Skills**: `["testing"]`
    - `testing`: understanding of vitest assertion flipping + grep-style test patterns
  - **Skills Evaluated but Omitted**:
    - `backend`: not needed — this is pure test+source grep/invert work, not architectural

  **Parallelization**:
  - **Can Run In Parallel**: NO (atomic pair with T20 — the same commit)
  - **Parallel Group**: Wave 3 — sequential with T20
  - **Blocks**: T22, T41
  - **Blocked By**: T20 (must land the bun-fetch rewrite first in the same commit)

  **References**:

  **Pattern References**:
  - `src/__tests__/debug-gating.test.ts:33-39` — existing assertions that must be flipped
  - Metis gap: "debug-gating.test.ts MUST be updated atomically"
  - `src/bun-fetch.ts` — source file where handler strings are currently present

  **Test References**:
  - `src/__tests__/debug-gating.test.ts` — the ONLY file that needs flipping; any other `process.on` reference in `src/` after T20+T21 is a bug

  **External References**:
  - Vitest `not.toContain` / `not.toMatch` API: https://vitest.dev/api/expect.html

  **WHY each reference matters**:
  - The existing test was added in a previous `quality-refactor` plan (Task 12) and is a source-code grep that ASSERTS the presence of the handlers. Since T20 removes them, the assertion must flip in the same commit or the suite turns red between commits (violating the "atomic commits" guardrail and the "existing tests must keep passing" constraint).
  - Metis explicitly identified this as a critical atomicity requirement; ignoring it would cascade a broken test across every subsequent wave.

  **Acceptance Criteria**:
  - [ ] `rg 'process\.on\s*\(\s*["'"'"']uncaughtException' src/` — 0 matches
  - [ ] `rg 'process\.on\s*\(\s*["'"'"']unhandledRejection' src/` — 0 matches
  - [ ] `rg 'process\.on\s*\(\s*["'"'"']SIGINT|SIGTERM|SIGHUP|beforeExit' src/bun-fetch.ts` — 0 matches
  - [ ] `rg 'process\.exit\s*\(' src/ --type ts` — 0 matches in non-test files (plugin src only; test files may reference via assertion strings)
  - [ ] `npx vitest run src/__tests__/debug-gating.test.ts` — passes with the inverted assertions
  - [ ] `npx vitest run` — full suite passes (no downstream test depended on the handlers)
  - [ ] `git log --oneline -1` — confirms the T20+T21 atomic commit exists with the T20 commit message

  **QA Scenarios**:

  ```
  Scenario: Global handlers removed and debug-gating test passes atomically
    Tool: Bash
    Preconditions: T20 implementation in progress in the same working copy; changes staged together
    Steps:
      1. rg 'process\.on\s*\(\s*["'"'"']uncaughtException' src/ 2>&1 | tee .sisyphus/evidence/task-21-guardrail-uncaught.txt
      2. [ ! -s .sisyphus/evidence/task-21-guardrail-uncaught.txt ] || (echo "FAIL: found uncaughtException handler" && exit 1)
      3. rg 'process\.on\s*\(\s*["'"'"']unhandledRejection' src/ 2>&1 | tee .sisyphus/evidence/task-21-guardrail-unhandled.txt
      4. [ ! -s .sisyphus/evidence/task-21-guardrail-unhandled.txt ] || (echo "FAIL: found unhandledRejection handler" && exit 1)
      5. rg 'process\.on\s*\(\s*["'"'"'](SIGINT|SIGTERM|SIGHUP|beforeExit)' src/bun-fetch.ts 2>&1 | tee .sisyphus/evidence/task-21-guardrail-signals.txt
      6. [ ! -s .sisyphus/evidence/task-21-guardrail-signals.txt ] || (echo "FAIL: found signal handler" && exit 1)
      7. rg 'process\.exit\s*\(' src/ --type ts --glob '!**/*.test.ts' 2>&1 | tee .sisyphus/evidence/task-21-guardrail-exit.txt
      8. [ ! -s .sisyphus/evidence/task-21-guardrail-exit.txt ] || (echo "FAIL: found process.exit in non-test src" && exit 1)
      9. npx vitest run src/__tests__/debug-gating.test.ts 2>&1 | tee .sisyphus/evidence/task-21-debug-gating.txt
      10. grep -E "(Test Files.*passed|tests passed)" .sisyphus/evidence/task-21-debug-gating.txt
      11. npx vitest run 2>&1 | tee .sisyphus/evidence/task-21-full-suite.txt
    Expected Result: All 4 guardrail-grep files are empty (no matches); debug-gating test passes; full suite passes
    Failure Indicators: Any guardrail-grep file is non-empty; debug-gating test fails; full suite regresses vs baseline
    Evidence: .sisyphus/evidence/task-21-guardrail-uncaught.txt, task-21-guardrail-unhandled.txt, task-21-guardrail-signals.txt, task-21-guardrail-exit.txt, task-21-debug-gating.txt, task-21-full-suite.txt

  Scenario: Negative — simulate a regression where a handler sneaks back in
    Tool: Bash
    Preconditions: T20+T21 committed
    Steps:
      1. Create a temporary local test fixture that writes `process.on("uncaughtException", () => {})` to a scratch file (DO NOT modify src/)
      2. Run `rg 'process\.on\s*\(\s*["'"'"']uncaughtException' src/` against the REAL src/ — expect: empty (negative confirmation the real src is clean)
      3. Delete the scratch file
    Expected Result: Real src/ is clean; scratch fixture path was never in src/
    Evidence: .sisyphus/evidence/task-21-negative.txt
  ```

  **Evidence to Capture**:
  - [ ] task-21-guardrail-uncaught.txt
  - [ ] task-21-guardrail-unhandled.txt
  - [ ] task-21-guardrail-signals.txt
  - [ ] task-21-guardrail-exit.txt
  - [ ] task-21-debug-gating.txt
  - [ ] task-21-full-suite.txt
  - [ ] task-21-negative.txt

  **Commit**: (atomic with T20 — SAME commit, not a separate one)
  - Message: owned by T20: `refactor(bun-fetch): per-instance proxy manager with no restart-kill and no global handlers`
  - Files contributed by T21: `src/__tests__/debug-gating.test.ts`
  - Files contributed by T20: `src/bun-fetch.ts`, `src/index.ts`
  - Combined pre-commit (owned by T20): `npx vitest run && npx tsc --noEmit && rg "healthCheckFails|MAX_HEALTH_FAILS|48372|FIXED_PORT|opencode-bun-proxy\.pid|PID_FILE" src/ ; rg 'process\.on\s*\(\s*["'"'"']uncaughtException|process\.on\s*\(\s*["'"'"']unhandledRejection' src/ ; [ $? -ne 0 ] || (echo "guardrail violation" && false)`

- [ ] 22. GREEN: harden native fetch fallback for graceful degradation

  **What to do**:
  - In `src/bun-fetch.ts` (after T20), implement a robust native fetch fallback:
    - When `_hasBun === false` or spawn fails permanently: return `globalThis.fetch(input, init)` directly
    - When the circuit breaker is OPEN: same — fall back to native for this request only
    - Document in the response header or a debug log that fingerprint mimicry is disabled for the fallback path
    - Ensure `requestInit` is passed through unchanged (no body mutation)
    - Add a telemetry hook (via the `onProxyStatus` callback from T20) to notify the plugin when fallback is engaged
  - Add a test in `src/bun-fetch.test.ts` verifying the fallback path (this test should already exist from T11; this task makes it GREEN if not already)

  **Must NOT do**:
  - Silently swallow the fallback (must log or emit status)
  - Attempt to restart the proxy from the fallback path
  - Apply any mimicry to the native fetch path (would produce a wrong fingerprint)

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `[]`

  **Parallelization**: YES, Wave 3
  **Blocks**: T41
  **Blocked By**: T20

  **References**:
  - `src/bun-fetch.ts:335-337` (current) — "final fallback: native fetch" comment that lies; fix it
  - Draft Add'l A finding from bg_1cbf6411

  **WHY**: Windows users + users without Bun must still get functional (if less-mimicked) behavior.

  **Acceptance Criteria**:
  - [ ] Fallback test(s) in `src/bun-fetch.test.ts` pass
  - [ ] Manually verified: set `_hasBun = false`, fire a request, observe native fetch path taken and response returned
  - [ ] `onProxyStatus` callback receives `{ status: 'fallback', reason: ... }` when fallback engages

  **QA Scenarios**:

  ```
  Scenario: Fallback engages when Bun unavailable
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/bun-fetch.test.ts -t "fallback" 2>&1 | tee .sisyphus/evidence/task-22-green.txt
    Expected Result: All fallback tests pass
    Evidence: task-22-green.txt
  ```

  **Evidence to Capture**: task-22-green.txt

  **Commit**: YES
  - Message: `fix(bun-fetch): harden native fetch fallback for graceful degradation`
  - Files: `src/bun-fetch.ts`
  - Pre-commit: `npx vitest run src/bun-fetch.test.ts`

---

## Wave 3 Checkpoint (after T17-T22)

Run: `npx vitest run` + `npx tsc --noEmit` + `npm run build` + all guardrail greps. Expected state: Wave 2 RED tests for circuit-breaker, parent-pid-watcher, bun-fetch, bun-proxy parallel, and index parallel are now GREEN. Guardrail greps return 0 matches. Build succeeds.

**Exit criteria**:

- T17-T22 complete
- T8, T9, T11, T12, T15 (Wave 2 RED tests for these domains) now GREEN
- All guardrail greps: 0 matches
- Full suite: **no net-new failures vs T0 baseline.** Tests that newly break and are NOT adjacent to the task's own files are acceptable at this checkpoint ONLY if they are tracked for T40's bulk sweep; the T40 task is the reconciliation point before the Wave 6 checkpoint. If in doubt, update the affected test in the nearest task's commit.
- Build: succeeds
- `debug-gating.test.ts`: passes with inverted assertions

---

- [ ] 23. GREEN: `src/response/streaming.ts` rewrite — event-framing + message_stop terminal + cancel propagation

  **What to do**:
  - Rewrite `transformResponse` in `src/response/streaming.ts`:
    - Unify the parser buffer and rewriter buffer into ONE buffer (`sseBuffer`) with ONE normalization (`\r\n` → `\n`)
    - Frame by COMPLETE SSE event blocks (`\n\n`), NOT lines. Never flush a partial event block.
    - For each complete event block:
      1. Parse the JSON payload (join multi-`data:` lines with `\n` per SSE spec)
      2. Apply `stripMcpPrefixFromParsedEvent` to the parsed object
      3. Track usage via `extractUsageFromSSEEvent`
      4. Detect mid-stream errors via `getMidStreamAccountError`
      5. Re-serialize the event as `event: <type>\ndata: <json>\n\n` and enqueue to downstream
    - Track state: `hasSeenMessageStop`, `hasSeenError`
    - On `done` (EOF): if neither `hasSeenMessageStop` nor `hasSeenError`, surface an error to the consumer via `controller.error(new Error('stream truncated without message_stop'))`
    - Implement `cancel()` on the output `ReadableStream` that calls `reader.cancel()` on the source (propagates abort to upstream)
    - Call `decoder.decode()` (no args) on `done` to flush trailing UTF-8 state (SSE-15)
    - Gate the whole wrapper behind `isEventStreamResponse(response)` check in the caller; non-SSE responses get a separate path (handled by T24)
  - DO NOT touch `src/response/mcp.ts` in this task (T24 handles the non-SSE case)

  **Must NOT do**:
  - Keep `sseRewriteBuffer` as a separate buffer
  - Use `lastIndexOf("\n")` framing
  - Silently swallow malformed events (log to debug if enabled)
  - Flush incomplete final event as valid

  **Recommended Agent Profile**: `deep` + `["testing", "backend"]`

  **Parallelization**: YES, Wave 4
  **Blocks**: T26, T27, T41
  **Blocked By**: T13

  **References**:
  - `src/response/streaming.ts` (current) — baseline
  - Draft SSE findings SSE-1, SSE-3, SSE-4, SSE-5, SSE-7, SSE-9, SSE-10, SSE-14, SSE-15, STREAM-COMPLETENESS
  - SSE spec: https://html.spec.whatwg.org/multipage/server-sent-events.html

  **WHY**: Direct root cause fix for the tool_use orphan error. T13 tests pin the contract.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/response/streaming.test.ts` — ALL 14 tests pass (from T13)
  - [ ] `npx vitest run index.test.ts -t "stream"` — existing streaming tests still pass
  - [ ] No `sseRewriteBuffer` in the rewritten file
  - [ ] `controller.error` called when EOF arrives without terminal event
  - [ ] `cancel()` propagates to underlying reader (verified by mock)

  **QA Scenarios**:

  ```
  Scenario: Streaming T13 tests go GREEN without breaking index.test.ts
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/response/streaming.test.ts 2>&1 | tee .sisyphus/evidence/task-23-green.txt
      2. Expect: 14/14 pass
      3. npx vitest run index.test.ts 2>&1 | tee .sisyphus/evidence/task-23-regression.txt
      4. Expect: same baseline pass count (no regressions)
    Evidence: task-23-green.txt, task-23-regression.txt
  ```

  **Evidence to Capture**: task-23-green.txt, task-23-regression.txt

  **Commit**: YES
  - Message: `refactor(streaming): event-framing SSE wrapper with message_stop terminal validation`
  - Files: `src/response/streaming.ts` + any co-located test updates in `index.test.ts` streaming tests that break from the API change (atomic commit)
  - Pre-commit: `npx vitest run src/response/streaming.test.ts && npx vitest run index.test.ts -t "stream"` (targeted suites; full suite runs at the Wave 4 checkpoint)

- [ ] 24. GREEN: `src/response/mcp.ts` — non-SSE JSON path for tool name stripping

  **What to do**:
  - Extend `src/response/mcp.ts`:
    - Add `stripMcpPrefixFromJsonBody(body: string): string` that parses a JSON body, walks the `content` array if present, strips `mcp_` prefix from any `tool_use.name` field, and re-serializes
    - Handles nested shapes: top-level `content[]`, nested `messages[].content[]` (for future-proofing)
    - Safe for non-tool_use responses: returns body unchanged if no prefixed tool_use blocks found
  - Extend `src/response/index.ts` to export the new function
  - In `src/index.ts` (or wherever `transformResponse` is called): for non-SSE responses, apply `stripMcpPrefixFromJsonBody` to the buffered body before returning to OpenCode. Use a lightweight helper that reads `response.text()`, transforms, and reconstructs a new `Response` with the same status/headers/content-type

  **Must NOT do**:
  - Apply the SSE transform to non-SSE bodies (that's SSE-14, the bug we're fixing)
  - Buffer SSE responses (those should stream via T23's wrapper)

  **Recommended Agent Profile**: `deep` + `[]`

  **Parallelization**: YES, Wave 4
  **Blocks**: T41
  **Blocked By**: T13 (the test file covers non-SSE case via SSE-14)

  **References**:
  - `src/response/mcp.ts:60-70` (current) — existing `content[]` walker
  - Draft SSE-14 finding

  **WHY**: Prevents history poisoning for users on non-streaming endpoints or intermediaries that buffer.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/response/streaming.test.ts -t "SSE-14"` — passes (non-SSE JSON test from T13)
  - [ ] New `stripMcpPrefixFromJsonBody` exported and covered by a unit test
  - [ ] No regression in existing mcp.ts tests

  **QA Scenarios**:

  ```
  Scenario: Non-SSE JSON path strips prefix correctly
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/response/streaming.test.ts -t "non-SSE" 2>&1 | tee .sisyphus/evidence/task-24-green.txt
    Expected Result: Test passes
    Evidence: task-24-green.txt
  ```

  **Evidence to Capture**: task-24-green.txt

  **Commit**: YES
  - Message: `fix(mcp): add non-SSE JSON path for tool name de-prefixing`
  - Files: `src/response/mcp.ts`, `src/response/index.ts`, `src/index.ts` (caller wiring)
  - Pre-commit: `npx vitest run src/response/`

- [ ] 25. GREEN: `src/request/body.ts` — runtime init.body invariant + double-prefix defense + body clone

  **What to do**:
  - Update `src/request/body.ts`:
    - Add a runtime type check at the entry of `transformRequestBody`: if body is not a string and not `undefined`/`null`, throw a clear `TypeError` with a message like `"opencode-anthropic-auth: expected string body, got <typeof>. This plugin does not support stream bodies. Please file a bug with the OpenCode version."`
    - Export a `cloneBodyForRetry(body: string): string` — for clarity; strings are already immutable but the function documents the intent
    - Fix the double-prefix defense in the tool*use mapping: if `block.name` already starts with `mcp*`AND the original tool registry does NOT contain a tool literally named`mcp\_\*`, log a warning and DO NOT re-prefix. Use a simple heuristic: if the `tools`array in the same parsed body contains a tool with the already-prefixed name matching`block.name`, skip re-prefixing
    - More conservative approach: introduce a `TOOL_PREFIX_SENTINEL` check — if `block.name === "mcp_" + originalName` for any original name in the tools array, preserve as-is
  - In `src/index.ts` fetch interceptor, update the retry loop to call `cloneBodyForRetry(originalBody)` before each attempt (clone-before-use pattern). For strings this is a no-op rename; the semantic documentation is the value
  - For `Request` object input with empty `init.body`: at the interceptor entry (`index.ts:239-243`), if `requestInit.body` is undefined AND `requestInput` is a `Request` with a body, read the body via `await requestInput.clone().text()` and set `requestInit.body` to the string (BODY-3 fix)

  **Must NOT do**:
  - Silently skip transformation for non-string bodies (must throw)
  - Over-eager double-prefix detection that breaks the existing test at `index.test.ts:1078-1123` where original tool names are `mcp_*`
  - Consume the original `requestInput.body` without cloning (would break retries)

  **Recommended Agent Profile**: `deep` + `["testing"]`

  **Parallelization**: YES, Wave 4
  **Blocks**: T26, T41
  **Blocked By**: T16

  **References**:
  - `src/request/body.ts:119-142` (current) — unconditional prefix
  - `index.test.ts:1078-1123` — test where original tool name IS `mcp_*` (must keep passing)
  - Draft findings TOOL-1, TOOL-2, BODY-1, BODY-2, BODY-3

  **WHY**: Prevents the `mcp_mcp_...` drift when history is already poisoned; prevents silent mimicry bypass on non-string bodies; enables safe retries.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/request/body.history.test.ts` — ALL 10 tests pass (from T16)
  - [ ] `npx vitest run index.test.ts -t "tool"` — existing tool tests still pass
  - [ ] `transformRequestBody(undefined)` returns `undefined` (noop)
  - [ ] `transformRequestBody(new ReadableStream())` throws `TypeError`
  - [ ] `transformRequestBody` handles history with `name: "mcp_read_file"` + tools `[{name: "read_file"}]` without double-prefix

  **QA Scenarios**:

  ```
  Scenario: Body T16 tests go GREEN
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/request/body.history.test.ts 2>&1 | tee .sisyphus/evidence/task-25-green.txt
      2. Expect: 10/10 pass
      3. npx vitest run index.test.ts -t "tool" 2>&1 | tee .sisyphus/evidence/task-25-regression.txt
      4. Expect: existing tool tests still pass
    Evidence: task-25-*.txt
  ```

  **Evidence to Capture**: task-25-green.txt, task-25-regression.txt

  **Commit**: YES
  - Message: `fix(body): runtime init.body invariant and double-prefix defense`
  - Files: `src/request/body.ts`, `src/index.ts` (interceptor body handling)
  - Pre-commit: `npx vitest run src/request/ && npx vitest run index.test.ts -t "tool"`

- [ ] 26. GREEN: `src/index.ts` fetch interceptor — per-request state + body clone + wire new modules

  **What to do**:
  - Update `src/index.ts` fetch interceptor:
    - Create a per-request context object at the top of the interceptor: `{ attempt: 0, cloneBody: string, circuitBreaker: never /* owned by bunFetch instance */ }`
    - Move any remaining module-level state to closure or request-scoped
    - Wire `createBunFetch()` from T20 into the plugin closure (one call at factory time)
    - In the retry loop, use `cloneBodyForRetry(originalBody)` to guarantee the body is safe to reuse
    - Ensure `requestInit.body` is resolved BEFORE the loop (handles BODY-3 via T25)
    - Keep all existing behavior: file-ID pinning, system prompt injection, header building, metadata building — these are OUT OF SCOPE per Metis tripwires

  **Must NOT do**:
  - Touch `src/system-prompt/*`, `src/headers/*`, `src/request/url.ts`, `src/request/metadata.ts`
  - Change public API of the plugin
  - Add new config keys

  **Recommended Agent Profile**: `deep` + `["backend"]`

  **Parallelization**: NO (depends on T20, T23, T25; Wave 4 tail)
  **Blocks**: T41
  **Blocked By**: T20, T23, T25

  **References**:
  - `src/index.ts:239-578` (current) — fetch interceptor body
  - Wave 3 `createBunFetch` factory
  - Wave 4 body helpers

  **WHY**: Final integration point that ties Wave 3 + Wave 4 together.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/__tests__/index.parallel.test.ts` — passes (from T15)
  - [ ] `npx vitest run index.test.ts` — 663 existing tests still pass
  - [ ] Interceptor uses `createBunFetch()` from a closure, not module-level
  - [ ] No `stopBunProxy` calls in `index.ts`

  **QA Scenarios**:

  ```
  Scenario: Fetch interceptor integrates per-instance bun-fetch + body clone
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/__tests__/index.parallel.test.ts 2>&1 | tee .sisyphus/evidence/task-26-green.txt
      2. npx vitest run index.test.ts 2>&1 | tee .sisyphus/evidence/task-26-regression.txt
    Expected Result: Both pass
    Evidence: task-26-*.txt
  ```

  **Evidence to Capture**: task-26-green.txt, task-26-regression.txt

  **Commit**: YES
  - Message: `refactor(index): body clone-before-use and per-request interceptor state`
  - Files: `src/index.ts` + co-located updates in `index.test.ts` for any interceptor-signature tests that newly break (atomic commit; bulk sweep still in T40)
  - Pre-commit: `npx vitest run src/__tests__/index.parallel.test.ts && npx vitest run index.test.ts -t "interceptor"` (targeted suites; full suite at Wave 4 checkpoint)

- [ ] 27. GREEN: stream-completeness error propagation

  **What to do**:
  - Verify T23 `controller.error` path is reachable and properly surfaces to the consumer
  - Add targeted test(s) in `src/response/streaming.test.ts` (extending T13) that:
    - Confirm the error is an instance of a dedicated `StreamTruncatedError` class with a clear message
    - Confirm the error contains context about which event type was in-flight when truncation occurred (e.g., `content_block_start(tool_use)`)
  - Update `src/index.ts` interceptor to catch `StreamTruncatedError` from the wrapped response stream and log it with `debugLog` (do NOT convert to an account failure — it's a stream-level issue, not an auth issue)

  **Must NOT do**:
  - Convert truncation to an account rotation trigger (different root cause)
  - Swallow the error silently

  **Recommended Agent Profile**: `deep` + `[]`

  **Parallelization**: YES, Wave 4
  **Blocks**: T41
  **Blocked By**: T23

  **References**:
  - Draft STREAM-COMPLETENESS finding
  - T23 implementation

  **WHY**: Surfaces stream truncation as a first-class error instead of silent data corruption.

  **Acceptance Criteria**:
  - [ ] `StreamTruncatedError` class exported from `src/response/streaming.ts`
  - [ ] Tests in `streaming.test.ts` assert the error class + message
  - [ ] `index.ts` logs (does not crash) on truncation

  **QA Scenarios**:

  ```
  Scenario: Truncation surfaces as StreamTruncatedError
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/response/streaming.test.ts -t "truncated" 2>&1 | tee .sisyphus/evidence/task-27-green.txt
    Expected Result: Error class assertion passes
    Evidence: task-27-green.txt
  ```

  **Evidence to Capture**: task-27-green.txt

  **Commit**: YES
  - Message: `feat(streaming): propagate stream-completeness errors to consumer`
  - Files: `src/response/streaming.ts`, `src/index.ts`
  - Pre-commit: `npx vitest run src/response/`

- [ ] 28. GREEN: upstream abort signal tied to client disconnect (BPSP-2)

  **What to do**:
  - In `src/bun-proxy.ts` (already touched in T19, extend):
    - Ensure the upstream `fetch(upstreamUrl, { ..., signal: AbortSignal.any([req.signal, AbortSignal.timeout(600_000)]) })` is in place
    - If the incoming request `signal` aborts (client disconnected), the upstream fetch cancels
    - Add a test in `src/__tests__/bun-proxy.parallel.test.ts` that verifies: canceling the incoming Request's AbortController causes the upstream fetch mock to receive an aborted signal
  - In `src/bun-fetch.ts`, ensure the client-side `fetch` to the local proxy also propagates the caller's `init.signal` so the chain is end-to-end

  **Must NOT do**:
  - Add arbitrary timeouts shorter than the user's original signal
  - Replace the 600s overall timeout (that's the ceiling)

  **Recommended Agent Profile**: `deep` + `["backend"]`

  **Parallelization**: YES, Wave 4
  **Blocks**: T41
  **Blocked By**: T19, T23

  **References**:
  - `src/bun-proxy.ts:60-64` (current) — only has the 600s timeout
  - Draft BPSP-2 finding
  - `AbortSignal.any` MDN docs

  **WHY**: Prevents upstream resource leaks when clients give up early.

  **Acceptance Criteria**:
  - [ ] New test in `bun-proxy.parallel.test.ts` asserts upstream signal is aborted when client disconnects
  - [ ] `rg "AbortSignal\.any" src/bun-proxy.ts` — 1+ match
  - [ ] Manual smoke: client aborts after 2s, upstream fetch mock records abort within 1s

  **QA Scenarios**:

  ```
  Scenario: Upstream abort follows client disconnect
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/__tests__/bun-proxy.parallel.test.ts -t "client disconnect" 2>&1 | tee .sisyphus/evidence/task-28-green.txt
    Expected Result: Test passes
    Evidence: task-28-green.txt
  ```

  **Evidence to Capture**: task-28-green.txt

  **Commit**: YES
  - Message: `fix(bun-proxy): tie upstream abort signal to client disconnect`
  - Files: `src/bun-proxy.ts`, `src/bun-fetch.ts`
  - Pre-commit: `npx vitest run src/__tests__/bun-proxy.parallel.test.ts`

---

## Wave 4 Checkpoint (after T23-T28)

Run: `npx vitest run` + `npx tsc --noEmit` + `npm run build`. Expected state: Wave 2 RED tests for streaming, body.history, and index.parallel (SSE-5 scenarios) are now GREEN. Build succeeds.

**Exit criteria**:

- T23-T28 complete
- T13, T16 fully GREEN; T15 (parallel integration) also confirming
- `src/response/streaming.ts` uses event-framing (verified by rg "lastIndexOf" returning 0 in that file)
- `StreamTruncatedError` reachable via test
- Full suite: **no net-new failures vs Wave 3 checkpoint.** Existing `index.test.ts` tool-use/stream tests are updated atomically inside T23/T25/T26 commits as needed; anything that requires cross-wave coordination defers to T40.
- Build succeeds

---

- [x] 29. GREEN: `src/account-identity.ts` — stable identity abstraction

  **What to do**:
  - Create `src/account-identity.ts`
  - Export:
    - `type AccountIdentity = | { kind: "oauth"; email: string } | { kind: "cc"; source: "cc-keychain" | "cc-file"; label: string } | { kind: "legacy"; refreshToken: string }`
    - `resolveIdentity(account: ManagedAccount | AccountMetadata): AccountIdentity` — picks oauth if source="oauth" && email exists, cc if source in ("cc-keychain","cc-file") && label exists, legacy otherwise
    - `resolveIdentityFromCCCredential(cred: CCCredential): AccountIdentity` — always `cc` kind using `cred.source` + `cred.label`
    - `resolveIdentityFromOAuthExchange(result: { email?: string; refresh: string }): AccountIdentity` — oauth if email, legacy if not
    - `identitiesMatch(a: AccountIdentity, b: AccountIdentity): boolean` — true iff same kind AND same stable key fields
    - `findByIdentity<T extends ManagedAccount | AccountMetadata>(accounts: T[], id: AccountIdentity): T | null` — linear scan
    - `serializeIdentity(id: AccountIdentity): string` — for debug logging (never include secrets)
  - Update `ManagedAccount` and `AccountMetadata` interfaces to include an optional `identity?: AccountIdentity` field (additive, non-breaking)
  - Update `ManagedAccount` to include optional `label?: string` for CC accounts (needed for identity resolution across restarts)

  **Must NOT do**:
  - Collapse OAuth and CC accounts with the same email
  - Use the refresh token as a primary identity field
  - Break existing tests that construct accounts without the `identity` field

  **Recommended Agent Profile**: `deep` + `["backend"]`

  **Parallelization**: YES, Wave 5
  **Blocks**: T30, T33, T34
  **Blocked By**: T10

  **References**:
  - Draft "DEEP AGENT FINDINGS: Account Dedup" → "Stable identity strategy"
  - `src/accounts.ts:ManagedAccount`, `AccountMetadata`

  **WHY**: Central abstraction that every dedup call site uses.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/account-identity.test.ts` — ALL 12 tests pass (from T10)
  - [ ] `identity` and `label` fields are OPTIONAL on `ManagedAccount`/`AccountMetadata`
  - [ ] `npx tsc --noEmit` — no new errors
  - [ ] Existing tests that don't set `identity` still compile and run

  **QA Scenarios**:

  ```
  Scenario: Account identity T10 tests go GREEN
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/account-identity.test.ts 2>&1 | tee .sisyphus/evidence/task-29-green.txt
      2. Expect: 12/12 pass
    Evidence: task-29-green.txt
  ```

  **Evidence to Capture**: task-29-green.txt

  **Commit**: YES
  - Message: `feat(account-identity): AccountIdentity abstraction with email/label/legacy resolution`
  - Files: `src/account-identity.ts`, `src/accounts.ts` (interface additions), `src/storage.ts` (interface additions)
  - Pre-commit: `npx vitest run src/account-identity.test.ts && npx tsc --noEmit`

- [x] 30. GREEN: `src/accounts.ts` — identity-first addAccount + preserve source in sync

  **What to do**:
  - Update `src/accounts.ts`:
    - `addAccount(params: { refreshToken, access, expires, email?, identity?, source?, label? })` — take an optional explicit identity OR resolve from other fields. Dedupe order: (1) identity match via `findByIdentity`, (2) legacy refresh-token match for backward-compat
    - `load()` CC auto-detect loop — use `resolveIdentityFromCCCredential` and `findByIdentity`. Enforce `MAX_ACCOUNTS` here too (DEDUP-MAX-BYPASS)
    - `syncActiveIndexFromDisk` — preserve the `source` field when rebuilding `#accounts` (currently drops it). Preserve `identity` and `label` too. IMPORTANT: instead of creating new objects, RECONCILE in place when possible — iterate disk records, find matching in-memory account by `id` or identity, update fields in place; add new ones; mark removed ones disabled (REFRESH-STALE-REFS fix)
    - Do NOT rebuild `HealthScoreTracker`/`TokenBucketTracker` on auth-field-only changes (REFRESH-TRACKER-THRASH). Only rebuild on structural changes (add/remove accounts)
    - `authFallback` dedup (line 104-118) — use identity matching
  - Update `ManagedAccount` initialization to include `identity` and `label` fields

  **Must NOT do**:
  - Break existing tests that rely on the current `addAccount` signature (keep both overloads if needed)
  - Introduce a structural breaking change to `ManagedAccount` (additive only)
  - Touch `HealthScoreTracker` or `TokenBucketTracker` core logic (just skip rebuilding)

  **Recommended Agent Profile**: `deep` + `["backend"]`

  **Parallelization**: Partial — must finish before T33, T34
  **Blocks**: T33, T34, T41
  **Blocked By**: T14, T29

  **References**:
  - `src/accounts.ts` (current) — baseline
  - Draft DEDUP-D, DEDUP-C, DEDUP-SYNC-SOURCE, DEDUP-MAX-BYPASS, DEDUP-AUTH-FALLBACK, REFRESH-STALE-REFS, REFRESH-TRACKER-THRASH

  **WHY**: Centralizes the dedup logic so all callers benefit; eliminates zombie accounts by construction.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/accounts.dedup.test.ts` — majority of tests pass (T14 RED tests for DEDUP-C/D/SYNC-SOURCE/MAX-BYPASS/AUTH-FALLBACK/REFRESH-STALE-REFS now GREEN)
  - [ ] `npx vitest run src/accounts.test.ts` — existing tests still pass (may need minor updates if signatures changed; keep additive)
  - [ ] `syncActiveIndexFromDisk` preserves source (verify via test)
  - [ ] In-flight account object refs remain valid after sync (verify via test)

  **QA Scenarios**:

  ```
  Scenario: Account dedup T14 tests partially go GREEN
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/accounts.dedup.test.ts 2>&1 | tee .sisyphus/evidence/task-30-green.txt
      2. Expect: ≥8/13 pass (remaining tests depend on T31-T34)
      3. npx vitest run src/accounts.test.ts 2>&1 | tee .sisyphus/evidence/task-30-regression.txt
      4. Expect: existing tests pass
    Evidence: task-30-*.txt
  ```

  **Evidence to Capture**: task-30-green.txt, task-30-regression.txt

  **Commit**: YES
  - Message: `refactor(accounts): identity-first addAccount and preserve source in syncActiveIndexFromDisk`
  - Files: `src/accounts.ts`
  - Pre-commit: `npx vitest run src/accounts`

- [x] 31. GREEN: `src/accounts.ts` + `src/storage.ts` — saveToDisk unions disk-only accounts

  **What to do**:
  - Update `AccountManager.saveToDisk`:
    - Before writing, LOAD disk, union any accounts that exist on disk but NOT in-memory by stable identity
    - For disk-only accounts, preserve their fields as-is (don't lose them)
    - For in-memory accounts also on disk, merge: prefer in-memory for non-auth fields, prefer fresher auth from disk if `tokenUpdatedAt` is newer
    - Write the unioned list
  - Update `src/storage.ts:saveAccounts` similarly if applicable (merge behavior already partially exists; extend it)
  - Ensure `saveAccounts`/`saveToDisk` are atomic: tempfile + rename (already is)

  **Must NOT do**:
  - Require a cross-process lock (too heavy; union + freshness timestamp is the lightweight solution)
  - Lose non-auth fields (enabled, rateLimitResetTimes, consecutiveFailures, stats) from either side

  **Recommended Agent Profile**: `deep` + `["backend"]`

  **Parallelization**:
  - **Can Run In Parallel**: NO — T31 touches `src/accounts.ts` AND `src/storage.ts`; T30 also touches `src/accounts.ts`; SEQUENTIAL to avoid merge conflicts
  - **Parallel Group**: Wave 5 — sequential after T30
  - **Blocks**: T41
  - **Blocked By**: T14, T29, **T30** (same-file dependency)

  **References**:
  - `src/accounts.ts:496-615` (current saveToDisk)
  - `src/storage.ts:223-290` (current saveAccounts)
  - Draft DEDUP-SAVE-UNION, REFRESH-SAVE-RACE

  **WHY**: Prevents silent data loss when two OpenCode instances write concurrently.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/accounts.dedup.test.ts -t "disk-only"` — passes (T14 RED)
  - [ ] `npx vitest run src/storage.test.ts` — existing tests pass + new union tests pass
  - [ ] Existing merge-on-save tests still pass

  **QA Scenarios**:

  ```
  Scenario: saveToDisk unions disk-only accounts
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/accounts.dedup.test.ts -t "disk-only" 2>&1 | tee .sisyphus/evidence/task-31-green.txt
    Evidence: task-31-green.txt
  ```

  **Evidence to Capture**: task-31-green.txt

  **Commit**: YES
  - Message: `fix(accounts): saveToDisk unions disk-only accounts to prevent silent drops`
  - Files: `src/accounts.ts`, `src/storage.ts`
  - Pre-commit: `npx vitest run src/accounts src/storage`

- [x] 32. GREEN: `src/storage.ts` — preserve source on load + tolerate unknown version

  **What to do**:
  - Update `loadAccounts()`:
    - Preserve `source` field when mapping disk records to in-memory (current bug: missing default, which Metis flagged: `source: acc.source || "oauth"` silently misclassifies missing-source records)
    - Treat missing `source` as `undefined`, not `"oauth"`; let consumers decide
    - On unknown version (`data.version !== CURRENT_VERSION`): LOG a warning, return a best-effort migration (read what fields exist, default missing fields, DO NOT return `null`)
    - Do NOT bump `CURRENT_VERSION` — stay at `1` with additive fields
  - Ensure `AccountStorage` type allows optional `identity` and `label` fields on accounts

  **Must NOT do**:
  - Bump `CURRENT_VERSION`
  - Return `null` on version mismatch (that wipes state)

  **Recommended Agent Profile**: `deep` + `["backend"]`

  **Parallelization**: YES, Wave 5
  **Blocks**: T41
  **Blocked By**: T14

  **References**:
  - `src/storage.ts:179-182` (unknown version handling)
  - Metis gap: "Storage version bump is catastrophic"
  - Draft DEDUP-NO-MIGRATION

  **WHY**: Enables safe upgrade paths and prevents silent misclassification.

  **Acceptance Criteria**:
  - [ ] `CURRENT_VERSION === 1` (unchanged)
  - [ ] `npx vitest run src/storage.test.ts` — existing tests pass; new tolerance test passes
  - [ ] `rg "CURRENT_VERSION\s*=\s*[2-9]" src/storage.ts` — 0 matches
  - [ ] `loadAccounts` with unknown version does NOT return null (returns best-effort data)

  **QA Scenarios**:

  ```
  Scenario: Storage tolerates unknown version and preserves source
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/storage.test.ts 2>&1 | tee .sisyphus/evidence/task-32-green.txt
      2. rg "CURRENT_VERSION\s*=\s*1" src/storage.ts
    Evidence: task-32-green.txt
  ```

  **Evidence to Capture**: task-32-green.txt

  **Commit**: YES
  - Message: `fix(storage): preserve source field on load and tolerate unknown version additively`
  - Files: `src/storage.ts`
  - Pre-commit: `npx vitest run src/storage`

- [x] 33. GREEN: `src/index.ts` — DEDUP-A (CC auto-detect authorize) + DEDUP-B (OAuth authorize)

  **What to do**:
  - Update `src/index.ts` "Claude Code Credentials (auto-detected)" authorize handler (~lines 587-631):
    - Replace `some(acc => acc.refreshToken === ccCred.refreshToken)` with `findByIdentity(accounts, resolveIdentityFromCCCredential(ccCred))`
    - If found: update tokens in place (no duplicate)
    - If not found: `addAccount({ ...ccCred fields, identity: resolveIdentityFromCCCredential(ccCred) })`
  - Update "Claude Pro/Max (multi-account)" authorize handler (~lines 633-697):
    - Before `addAccount(...)`, check `findByIdentity(accounts, resolveIdentityFromOAuthExchange(credentials))`
    - If found with oauth identity (email match): update tokens in place
    - If not found or legacy identity: `addAccount({ ..., identity: resolveIdentityFromOAuthExchange(credentials) })`
  - Add per-flow tests confirming no duplicates created on re-auth

  **Must NOT do**:
  - Collapse CC and OAuth with same email (keep separate)
  - Touch `src/oauth.ts`

  **Recommended Agent Profile**: `deep` + `[]`

  **Parallelization**: YES, Wave 5
  **Blocks**: T41
  **Blocked By**: T29, T30

  **References**:
  - `src/index.ts:587-697`
  - Draft DEDUP-A, DEDUP-B

  **WHY**: Main user-reported bug; the authorize handlers are the entry points for duplicate creation.

  **Acceptance Criteria**:
  - [ ] `npx vitest run src/accounts.dedup.test.ts -t "Flow A"` + `-t "Flow B"` — both pass
  - [ ] Re-auth with rotated CC credential does NOT create a duplicate (verified by test)
  - [ ] Re-auth with new OAuth session for same email does NOT create a duplicate

  **QA Scenarios**:

  ```
  Scenario: Authorize flows dedupe by identity
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/accounts.dedup.test.ts -t "Flow" 2>&1 | tee .sisyphus/evidence/task-33-green.txt
      2. npx vitest run index.test.ts -t "auth" 2>&1 | tee .sisyphus/evidence/task-33-regression.txt
    Evidence: task-33-*.txt
  ```

  **Evidence to Capture**: task-33-green.txt, task-33-regression.txt

  **Commit**: YES
  - Message: `fix(index): deduplicate CC and OAuth authorize flows by stable identity`
  - Files: `src/index.ts`
  - Pre-commit: `npx vitest run`

- [ ] 34. GREEN: `src/cli.ts:cmdLogin` — DEDUP-CLI fix

  **What to do**:
  - Update `cmdLogin` in `src/cli.ts` (~line 395-447):
    - Replace refresh-token-only dedup with `findByIdentity(accounts, resolveIdentityFromOAuthExchange(credentials))`
    - If found: update in place (same pattern as `cmdReauth` at `cli.ts:612-632` which already does the right thing)
    - If not found: `addAccount({ ..., identity })`
  - Do NOT touch `cmdReauth` (already correct)
  - Add CLI test confirming repeated login for same email updates rather than duplicates

  **Must NOT do**:
  - Touch any other CLI command
  - Modify `cmdReauth`

  **Recommended Agent Profile**: `deep` + `[]`

  **Parallelization**: YES, Wave 5
  **Blocks**: T41
  **Blocked By**: T29, T30

  **References**:
  - `src/cli.ts:395-447` (cmdLogin)
  - `src/cli.ts:612-632` (cmdReauth — correct pattern to follow)
  - Draft DEDUP-CLI

  **WHY**: CLI-side parity with plugin-side authorize dedup.

  **Acceptance Criteria**:
  - [ ] `npx vitest run cli.test.ts -t "login"` — passes (existing + new dedup test)
  - [ ] `cmdReauth` still passes unchanged

  **QA Scenarios**:

  ```
  Scenario: cmdLogin deduplicates by identity
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run cli.test.ts -t "login" 2>&1 | tee .sisyphus/evidence/task-34-green.txt
    Evidence: task-34-green.txt
  ```

  **Evidence to Capture**: task-34-green.txt

  **Commit**: YES
  - Message: `fix(cli): deduplicate cmdLogin by stable identity, reuse cmdReauth pattern`
  - Files: `src/cli.ts`
  - Pre-commit: `npx vitest run cli.test.ts`

- [x] 35. GREEN: `src/refresh-lock.ts` + tests — widen staleMs and timeoutMs constants

  **What to do**:
  - Update `src/refresh-lock.ts` constants:
    - `DEFAULT_LOCK_TIMEOUT_MS = 15_000` (was 2_000)
    - `DEFAULT_STALE_LOCK_MS = 90_000` (was 20_000) — exceeds max observed CC refresh (60s) + margin
  - Update `src/token-refresh.ts` explicit options at line 194-198: use the new defaults (can remove explicit values to fall through to defaults, or update inline)
  - Update `src/refresh-lock.test.ts` — existing tests use old stale values; update to new constants
  - Add regression test: "stale reaper does NOT steal a lock held for 60s" (simulates CC refresh duration)
  - Preserve the "save before release lock" invariant (already correct at `token-refresh.ts:275-281`)
  - Preserve owner/inode verification (already correct)

  **Must NOT do**:
  - Reduce the timeout below the refresh duration
  - Add new locking layers

  **Recommended Agent Profile**: `deep` + `[]`

  **Parallelization**: YES, Wave 5
  **Blocks**: T41
  **Blocked By**: T14

  **References**:
  - `src/refresh-lock.ts:6-8`
  - `src/token-refresh.ts:159-162` (60s CC timeout)
  - Draft REFRESH-STALE-LOCK, REFRESH-LOCK-TIMEOUT

  **WHY**: Prevents rotation thrashing and live-lock theft.

  **Acceptance Criteria**:
  - [ ] `DEFAULT_LOCK_TIMEOUT_MS === 15_000`, `DEFAULT_STALE_LOCK_MS === 90_000`
  - [ ] `npx vitest run src/refresh-lock.test.ts` — passes with updated constants
  - [ ] New regression test passes

  **QA Scenarios**:

  ```
  Scenario: Lock constants widened; stale reaper respects live 60s holder
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/refresh-lock.test.ts 2>&1 | tee .sisyphus/evidence/task-35-green.txt
    Evidence: task-35-green.txt
  ```

  **Evidence to Capture**: task-35-green.txt

  **Commit**: YES
  - Message: `fix(refresh-lock): widen staleMs and timeoutMs to exceed CC refresh duration`
  - Files: `src/refresh-lock.ts`, `src/refresh-lock.test.ts`, `src/token-refresh.ts`
  - Pre-commit: `npx vitest run src/refresh-lock.test.ts`

- [ ] 36. GREEN: `src/refresh-helpers.ts` + `src/token-refresh.ts` — idle→foreground re-check + in-place updates

  **What to do**:
  - Update `src/refresh-helpers.ts:refreshAccountTokenSingleFlight`:
    - After awaiting a failing idle promise (line 56-65), RE-CHECK `refreshInFlight.get(key)` before creating a new entry. If another foreground caller already created an entry, await that instead. Prevents REFRESH-IDLE-REENTRY.
  - Update `src/token-refresh.ts:refreshAccountToken` return path:
    - Already updates `account.access`, `account.expires`, `account.refreshToken` in place (correct)
    - Ensure the update is visible to any concurrent caller via the single-flight map
  - Update `applyDiskAuthIfFresher` (`token-refresh.ts:56-75`):
    - Fix REFRESH-EXPIRED-FALLBACK: only adopt disk auth with `allowExpiredFallback: true` if the disk auth is ACTUALLY newer OR the disk `refreshToken` differs. Do NOT bump `tokenUpdatedAt` if adopting older fields
  - Add regression tests to `src/token-refresh.test.ts` covering:
    - Idle→foreground reentry after rejection (foreground gets the same failure, does NOT create a new entry)
    - `applyDiskAuthIfFresher` does not regress the timestamp

  **Must NOT do**:
  - Alter the "save before release lock" invariant
  - Change the single-flight map key from `account.id`

  **Recommended Agent Profile**: `deep` + `["backend"]`

  **Parallelization**: YES, Wave 5
  **Blocks**: T41
  **Blocked By**: T14, T35

  **References**:
  - `src/refresh-helpers.ts:49-92`
  - `src/token-refresh.ts:56-75, 188-302`
  - Draft REFRESH-IDLE-REENTRY, REFRESH-EXPIRED-FALLBACK

  **WHY**: Prevents duplicate parallel refreshes after idle failures and time-travel regression.

  **Acceptance Criteria**:
  - [ ] New tests in `src/token-refresh.test.ts` for both scenarios pass
  - [ ] Existing `src/token-refresh.test.ts` tests still pass
  - [ ] `npx vitest run src/refresh-helpers*.test.ts src/token-refresh.test.ts` — all pass

  **QA Scenarios**:

  ```
  Scenario: Refresh idle→foreground reentry fixed
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run src/token-refresh.test.ts src/__tests__/decomposition-smoke.test.ts 2>&1 | tee .sisyphus/evidence/task-36-green.txt
    Evidence: task-36-green.txt
  ```

  **Evidence to Capture**: task-36-green.txt

  **Commit**: YES
  - Message: `fix(refresh-helpers): idle-to-foreground single-flight re-check after rejection`
  - Files: `src/refresh-helpers.ts`, `src/token-refresh.ts`, `src/token-refresh.test.ts`
  - Pre-commit: `npx vitest run src/token-refresh.test.ts src/refresh-helpers*.test.ts`

---

## Wave 5 Checkpoint (after T29-T36)

Run: `npx vitest run` + `npx tsc --noEmit` + `npm run build`. Expected: T10, T14 RED tests are now FULLY GREEN; all dedup scenarios + refresh concurrency scenarios pass.

**Exit criteria**:

- T29-T36 complete
- T10, T14 fully GREEN
- New account dedup + refresh concurrency tests pass
- Existing `src/accounts.test.ts`, `src/token-refresh.test.ts`, `src/refresh-lock.test.ts` are updated inline where Wave 5 tasks break them (atomic commits) OR deferred to T40's bulk sweep
- Full suite: **no net-new failures vs Wave 4 checkpoint.** T40 is the reconciliation point where any remaining cross-wave test updates land before the full-suite green-light at the Wave 6 checkpoint.
- Build succeeds
- `CURRENT_VERSION === 1` preserved

---

- [ ] 37. Update docs — README, AGENTS, mimese

  **What to do**:
  - **PRE-STEP 1 — canonical agents file rename (handle macOS case-insensitive filesystem):**
    The user has requested the canonical tracked path be `AGENTS.md` (uppercase). On macOS HFS+/APFS, plain `git mv agents.md AGENTS.md` is a no-op because the filesystem treats the names identically. Use the two-step rename:
    ```bash
    # Check current git-tracked name
    git ls-files | grep -i agents
    # If output is "agents.md" (lowercase), do the two-step rename:
    git mv agents.md agents-RENAME-TEMP.md
    git mv agents-RENAME-TEMP.md AGENTS.md
    # Verify:
    git ls-files | grep -i agents
    # Expected new output: "AGENTS.md" (uppercase)
    ```
    If `git ls-files` ALREADY shows `AGENTS.md` (the rename is already landed), skip the two-step. This pre-step is idempotent.
    Stage the rename alongside the doc edits below; the whole T37 lands in ONE commit.
  - **PRE-STEP 2 — verify current state:**
    ```bash
    git ls-files | grep -i agents  # expected (after rename): AGENTS.md
    git cat-file -p HEAD:AGENTS.md | head -1 2>/dev/null || echo "not yet committed, expected until T37 commits"
    ```
  - Update `README.md`:
    - Add a "Per-instance proxy lifecycle" section explaining: each OpenCode instance owns its own proxy; proxy dies with parent; ephemeral port allocation; graceful fallback to native fetch
    - If README has no "Known limitations" section, CREATE it. Add: Windows native fetch fallback (no mimicry); CC refresh blocking for up to 60s (known latent issue, out of scope)
    - Update CLI command references if changed (should be unchanged)
  - Update `AGENTS.md` (uppercase — canonical tracked path after T37's pre-step rename):
    - Add a "Concurrency guarantees" section: single proxy handles N concurrent requests; circuit breaker is per-request not global; no restart-kill; stable identity dedup
    - Update the "Change policy" section with the new invariants
  - Update `docs/mimese-http-header-system-prompt.md`:
    - Add a note that the proxy lifecycle has changed to per-instance
    - Confirm that fingerprint mimicry is unchanged (still uses Bun TLS)
  - Do NOT edit `CLAUDE.md` or other AI-agent-only docs

  **Must NOT do**:
  - Rewrite large sections; prefer additive changes
  - Document out-of-scope work
  - Add new config knobs that don't exist

  **Recommended Agent Profile**: `writing` + `[]`

  **Parallelization**: YES, Wave 6
  **Blocks**: T41
  **Blocked By**: Waves 1-5 complete

  **References**:
  - `README.md` current structure
  - `AGENTS.md` current structure
  - `docs/mimese-http-header-system-prompt.md`

  **WHY**: Keeps docs in sync with behavior for future contributors and users.

  **Acceptance Criteria**:
  - [ ] README has the new section
  - [ ] AGENTS has the new section
  - [ ] mimese doc notes the proxy lifecycle change
  - [ ] `npm run format:check` passes

  **QA Scenarios**:

  ```
  Scenario: Canonical path rename + docs updated and formatted
    Tool: Bash
    Steps:
      1. git ls-files | grep -i agents | tee .sisyphus/evidence/task-37-canonical-path-before.txt
         # captures the pre-rename state (may show agents.md lowercase)
      2. # Conditional rename: only if still lowercase
         if git ls-files | grep -qx "agents.md"; then
           git mv agents.md agents-RENAME-TEMP.md
           git mv agents-RENAME-TEMP.md AGENTS.md
         fi
      3. git ls-files | grep -i agents | tee .sisyphus/evidence/task-37-canonical-path-after.txt
         # MUST show "AGENTS.md" (uppercase)
      4. grep -q "^AGENTS.md$" .sisyphus/evidence/task-37-canonical-path-after.txt || (echo "FAIL: rename did not land" && exit 1)
      5. grep -A3 "Per-instance proxy lifecycle" README.md | tee .sisyphus/evidence/task-37-readme-heading.txt
      6. grep -A3 "Concurrency guarantees" AGENTS.md | tee .sisyphus/evidence/task-37-agents-heading.txt
      7. npm run format:check 2>&1 | tee .sisyphus/evidence/task-37-format.txt
    Expected Result: canonical path is AGENTS.md (uppercase) after T37; both headings exist; format passes
    Failure Indicators: rename didn't land; headings missing; format fails
    Evidence: task-37-canonical-path-before.txt, task-37-canonical-path-after.txt, task-37-readme-heading.txt, task-37-agents-heading.txt, task-37-format.txt
  ```

  **Evidence to Capture**:
  - [ ] task-37-canonical-path-before.txt (pre-rename git state)
  - [ ] task-37-canonical-path-after.txt (post-rename git state)
  - [ ] task-37-readme-heading.txt (README heading present)
  - [ ] task-37-agents-heading.txt (AGENTS.md heading present)
  - [ ] task-37-format.txt (format check)

  **Commit**: YES
  - Message: `docs: rename agents.md to AGENTS.md and update README + mimese docs for per-instance proxy lifecycle`
  - Files: `README.md`, `AGENTS.md` (uppercase — canonical path after T37's pre-step rename), `docs/mimese-http-header-system-prompt.md`
  - Pre-commit: `npm run format:check`

> **Wave 6 serialization note**: T37, T38, T39 all touch `README.md` and/or `CHANGELOG.md`. They MUST run sequentially (not in parallel) to avoid merge conflicts. Order: T37 → T38 → T39 → T40 → T41. Only T40 and T41 run after all doc edits land.

- [ ] 38. Update CHANGELOG with v0.1.0 entry

  **What to do**:
  - Update `CHANGELOG.md` (or create if missing):
    - Add a v0.1.0 entry with sections: `Fixed`, `Changed`, `Added`, `Removed`
    - Fixed: the three reported bugs (tool_use orphan, Unable to connect, duplicate account) + the 55+ inventoried bugs grouped by domain
    - Changed: proxy lifecycle (per-instance), refresh lock constants, SSE framing, account dedup strategy
    - Added: `account-identity.ts`, `circuit-breaker.ts`, `parent-pid-watcher.ts`, 10 new test files
    - Removed: global `healthCheckFails`, fixed port 48372, global PID file, `process.on("uncaughtException"|"unhandledRejection"|...)` handlers
  - Bump `package.json` version to `0.1.0` (the release task; minor version bump signals the architectural change)

  **Must NOT do**:
  - Bump major version (0.x.y semantic — minor bump is correct)
  - Include internal bug IDs in the user-facing changelog; translate to user-understandable phrasing

  **Recommended Agent Profile**: `writing` + `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO — T38 touches `CHANGELOG.md` + `package.json`; T39 also documents usage in README/CHANGELOG; SEQUENTIAL
  - **Parallel Group**: Wave 6 — sequential after T37
  - **Blocks**: T39, T41
  - **Blocked By**: Waves 1-5 complete, **T37** (T37 edits README first)

  **References**:
  - `package.json` — current version 0.0.45
  - Keep-a-changelog format: https://keepachangelog.com/en/1.1.0/

  **WHY**: Users and contributors need to see what changed and why.

  **Acceptance Criteria**:
  - [ ] `CHANGELOG.md` has v0.1.0 entry with 4 sections
  - [ ] `package.json:version === "0.1.0"`
  - [ ] Changelog entries are user-facing, not internal jargon

  **QA Scenarios**:

  ```
  Scenario: Changelog and version bump present
    Tool: Bash
    Steps:
      1. grep "0.1.0" CHANGELOG.md
      2. jq -r .version package.json
    Expected Result: Both present
    Evidence: .sisyphus/evidence/task-38-changelog.txt
  ```

  **Evidence to Capture**: task-38-changelog.txt

  **Commit**: YES
  - Message: `docs(changelog): v0.1.0 entry for parallel-request and account-dedup fix`
  - Files: `CHANGELOG.md`, `package.json`
  - Pre-commit: `npm run format:check`

- [ ] 39. Manual QA scripts: `scripts/qa-parallel.sh` + `scripts/rotation-test.js` + `scripts/mock-upstream.js`

  **What to do**:
  - Create `scripts/mock-upstream.js` — a self-contained Node HTTP server that simulates Anthropic SSE responses:
    - Listens on `127.0.0.1:0` (kernel-assigned port) and prints the port on stdout as `MOCK_UPSTREAM_PORT=<n>`
    - Returns `content-type: text/event-stream` with a well-formed SSE sequence: `message_start` → `content_block_start(tool_use, id=toolu_<id>)` → `content_block_delta` × 2 → `content_block_stop` → `message_delta` → `message_stop`
    - Each request gets a unique `toolu_<id>` derived from a monotonic counter so distinct requests produce distinct responses
    - Accepts a `GRACEFUL_SHUTDOWN_MS` env var to auto-shutdown after idle period (default 60s)
  - Create `scripts/qa-parallel.sh`:
    - `set -euo pipefail`
    - Resolve mock upstream port: `MOCK_PORT=$(node scripts/mock-upstream.js & ... wait for MOCK_UPSTREAM_PORT= banner)`
    - Spawn `node dist/bun-proxy.mjs --parent-pid=$$` in the background, read `BUN_PROXY_PORT=` from its stdout
    - Fire N=50 concurrent curl requests with `xargs -P 50`, each with distinct JSON body
    - Capture responses; assert: 50 `message_stop` markers present, 0 `Unable to connect` substrings, 0 `tool_use ids were found without tool_result` substrings
    - Kill the proxy, kill the mock upstream, wait for both to exit
    - Print a summary line: `PASS | requests=50 | orphans=0 | connect_errors=0 | parent_death_ok=Y`
    - Exit code 0 on PASS, 1 on any failure
  - Create `scripts/rotation-test.js` — a self-contained Node script that verifies account dedup across 10 rotations:
    - Accepts `ANTHROPIC_ACCOUNTS_FILE` env var (path to isolated accounts.json)
    - Starts an inline mock OAuth token endpoint on `127.0.0.1:0` that returns a NEW `refresh_token` and `access_token` on every call (uses a monotonic counter)
    - Writes a fake accounts file with 2 initial OAuth accounts (distinct emails: `a@test.local`, `b@test.local`)
    - Imports the built plugin from `./dist/opencode-anthropic-auth-plugin.js` and exercises `AccountManager.load` + the identity-first refresh flow 10 times per account
    - After 10 rotations, reloads the accounts file from disk and prints `ACCOUNT_COUNT=<n>` (expected: 2)
    - Exits 0 if count is 2, exits 1 otherwise
  - Make `scripts/qa-parallel.sh` executable (`chmod +x`)
  - Add a SHORT usage note to README ("Manual parallel QA: `bash scripts/qa-parallel.sh`") — one sentence, appended to whatever section makes sense (likely "Known limitations" or a new "Manual QA" subsection)
  - Add a SHORT mention in CHANGELOG (one line under "Added": `scripts/qa-parallel.sh` and `scripts/rotation-test.js` for manual QA verification)

  **Must NOT do**:
  - Hit the real Anthropic API
  - Use fixed ports that might conflict (always use port 0 for kernel assignment)
  - Require manual user interaction
  - Re-do the full documentation edits that T37/T38 already made (just append the script-specific notes)
  - Leave placeholder comments like `<inline oauth server>` — all commands must be fully specified and runnable

  **Recommended Agent Profile**: `deep` + `["tooling"]`

  **Parallelization**:
  - **Can Run In Parallel**: NO — T39 appends to README.md AND CHANGELOG.md which T37/T38 just edited; SEQUENTIAL after T38
  - **Parallel Group**: Wave 6 — sequential after T38
  - **Blocks**: T41
  - **Blocked By**: Waves 1-5 complete, `dist/bun-proxy.mjs` build artifact exists, **T37** (README), **T38** (CHANGELOG)

  **References**:
  - Existing `scripts/` directory pattern
  - `curl` + `xargs -P` parallel invocation

  **WHY**: Provides an end-to-end manual reproduction that validates the fix outside of unit tests.

  **Acceptance Criteria**:
  - [ ] `scripts/qa-parallel.sh` exists and is executable (`test -x`)
  - [ ] `scripts/rotation-test.js` exists (Node script, executable via `node scripts/rotation-test.js`)
  - [ ] `scripts/mock-upstream.js` exists
  - [ ] None of the three files contain placeholder markers (`...`, `<inline ...>`, `TODO`) — all commands fully specified
  - [ ] Running `bash scripts/qa-parallel.sh` against a built `dist/` produces a PASS summary and exit code 0
  - [ ] Running `ANTHROPIC_ACCOUNTS_FILE=/tmp/rotation-test.json node scripts/rotation-test.js` prints `ACCOUNT_COUNT=2` and exits 0
  - [ ] Both scripts complete in < 2 minutes each
  - [ ] No residual subprocesses after completion (`ps aux | grep -E "bun-proxy|mock-upstream"` is empty)

  **QA Scenarios**:

  ```
  Scenario: All three scripts exist and pass smoke tests
    Tool: Bash (interactive_bash via tmux)
    Preconditions: T0-T38 complete; dist/ built via Wave 3-5 tasks
    Steps:
      1. test -x scripts/qa-parallel.sh || (echo "FAIL: not executable" && exit 1)
      2. test -f scripts/rotation-test.js || (echo "FAIL: rotation-test.js missing" && exit 1)
      3. test -f scripts/mock-upstream.js || (echo "FAIL: mock-upstream.js missing" && exit 1)
      4. grep -L "\\.\\.\\.\\|<inline\\|TODO" scripts/qa-parallel.sh scripts/rotation-test.js scripts/mock-upstream.js
         # Expect: empty (all three files are placeholder-free)
      5. npm run build 2>&1 | tail -20 > .sisyphus/evidence/task-39-build.txt
      6. bash scripts/qa-parallel.sh 2>&1 | tee .sisyphus/evidence/task-39-qa-parallel.txt
      7. grep -q "^PASS" .sisyphus/evidence/task-39-qa-parallel.txt || (echo "FAIL: qa-parallel did not PASS" && exit 1)
      8. ANTHROPIC_ACCOUNTS_FILE=/tmp/rotation-test-$(date +%s).json node scripts/rotation-test.js 2>&1 | tee .sisyphus/evidence/task-39-rotation-test.txt
      9. grep -q "^ACCOUNT_COUNT=2$" .sisyphus/evidence/task-39-rotation-test.txt || (echo "FAIL: rotation test found duplicates" && exit 1)
      10. ps aux | grep -v grep | grep -E "bun-proxy|mock-upstream" | tee .sisyphus/evidence/task-39-residual.txt
      11. [ ! -s .sisyphus/evidence/task-39-residual.txt ] || (echo "FAIL: residual subprocesses" && exit 1)
    Expected Result: All 3 scripts present; qa-parallel prints PASS; rotation-test prints ACCOUNT_COUNT=2; no residuals
    Failure Indicators: Any step exits non-zero
    Evidence: task-39-build.txt, task-39-qa-parallel.txt, task-39-rotation-test.txt, task-39-residual.txt
  ```

  **Evidence to Capture**:
  - [ ] task-39-build.txt
  - [ ] task-39-qa-parallel.txt
  - [ ] task-39-rotation-test.txt
  - [ ] task-39-residual.txt

  **Commit**: YES
  - Message: `test(qa): scripts/qa-parallel.sh + rotation-test.js + mock-upstream.js for manual verification`
  - Files: `scripts/qa-parallel.sh`, `scripts/rotation-test.js`, `scripts/mock-upstream.js`, `README.md` (append usage note), `CHANGELOG.md` (append line)
  - Pre-commit: `chmod +x scripts/qa-parallel.sh && bash scripts/qa-parallel.sh && ANTHROPIC_ACCOUNTS_FILE=/tmp/rotation-test-$(date +%s).json node scripts/rotation-test.js`

- [ ] 40. Bulk sweep: update cross-wave existing tests for new APIs (FULL SUITE GATE)

  **What to do**:
  - This is the FULL-SUITE reconciliation point. Run `npx vitest run` and capture all currently-failing tests that are NOT part of the Wave 2 RED→GREEN transitions (those should all be GREEN by now)
  - Audit `index.test.ts`, `src/accounts.test.ts`, `src/token-refresh.test.ts`, `src/refresh-lock.test.ts`, `cli.test.ts`, `src/storage.test.ts`, `src/account-state.test.ts` for any residual failures caused by cross-wave API changes not already handled in individual task commits
  - For each failing assertion, decide: UPDATE (if the new behavior is correct and the test was encoding the old wrong behavior) or FIX (if the new code broke it). Record the decision in the commit message
  - For tests that used now-removed APIs (e.g., module-level `bun-fetch` state):
    - Update to use the new `createBunFetch` factory
    - Update to use the new `AccountIdentity` abstraction
    - Update to use the new lock constants (`staleMs ≥ 90000`, `timeoutMs ≥ 15000`)
    - Update to use stable identity matching instead of refresh-token matching
  - NEVER delete a test to make the suite pass; always fix or update with justification in the commit message
  - After the sweep, `npx vitest run` MUST be GREEN end-to-end (this is the first task that enforces full-suite green)

  **Must NOT do**:
  - Delete tests without justification
  - Skip tests with `.skip` without a tracking issue
  - Regress existing test coverage

  **Recommended Agent Profile**: `deep` + `["testing"]`

  **Parallelization**: YES, Wave 6
  **Blocks**: T41
  **Blocked By**: Waves 1-5 complete

  **References**:
  - Each test file in the baseline

  **WHY**: Wave 3-5 introduce breaking internal APIs; existing tests must adapt.

  **Acceptance Criteria**:
  - [ ] Full suite passes: `npx vitest run`
  - [ ] No tests `.skip`-ped
  - [ ] Commit message documents every test update with rationale

  **QA Scenarios**:

  ```
  Scenario: All existing tests updated and passing
    Tool: Bash (vitest)
    Steps:
      1. npx vitest run 2>&1 | tee .sisyphus/evidence/task-40-full-suite.txt
      2. grep -c "\.skip" src/ -r --include="*.test.ts" | grep -v ":0$" → expect empty (no new skips)
    Expected Result: All pass; no new skips
    Evidence: task-40-full-suite.txt
  ```

  **Evidence to Capture**: task-40-full-suite.txt

  **Commit**: YES
  - Message: `test: update existing tests for identity-first APIs and new lock constants`
  - Files: whatever test files need updating
  - Pre-commit: `npx vitest run`

- [ ] 41. Regression suite — final checkpoint before Final Verification Wave

  **What to do**:
  - Run the full regression suite and capture all evidence:
    - `npx vitest run` — all tests pass
    - `npx tsc --noEmit` — no new errors vs T0 baseline
    - `npm run lint` — passes (or matches baseline)
    - `npm run format:check` — passes
    - `npm run build` — produces dist artifacts
    - All guardrail greps return 0 matches (see Verification Strategy)
    - `bash scripts/qa-parallel.sh` — PASS
  - Produce `.sisyphus/evidence/wave-6-final-regression.md` summarizing:
    - Baseline vs current: tests, tsc errors, lint warnings
    - All 41 task evidence files present
    - Guardrail greps: 0 matches confirmed
    - Build artifacts present

  **Must NOT do**:
  - Claim completion without evidence
  - Skip any check

  **Recommended Agent Profile**: `unspecified-high` + `["testing"]`

  **Parallelization**: NO (final serialization point before Final Verification Wave)
  **Blocks**: F1-F4
  **Blocked By**: T0-T40 all complete

  **References**:
  - `task-0-baseline.md`
  - All prior evidence files

  **WHY**: One clean pass before escalating to the review agents.

  **Acceptance Criteria**:
  - [ ] All regression commands pass
  - [ ] Evidence file `.sisyphus/evidence/wave-6-final-regression.md` exists with PASS summary
  - [ ] All 41 task evidence files present in `.sisyphus/evidence/`

  **QA Scenarios**:

  ```
  Scenario: Final regression is clean
    Tool: Bash
    Steps:
      1. npx vitest run 2>&1 | tee .sisyphus/evidence/task-41-vitest.txt
      2. npx tsc --noEmit 2>&1 | tee .sisyphus/evidence/task-41-tsc.txt
      3. npm run lint 2>&1 | tee .sisyphus/evidence/task-41-lint.txt
      4. npm run format:check 2>&1 | tee .sisyphus/evidence/task-41-format.txt
      5. npm run build 2>&1 | tee .sisyphus/evidence/task-41-build.txt
      6. { rg "healthCheckFails|MAX_HEALTH_FAILS" src/ || true; rg "48372|FIXED_PORT" src/ || true; rg "opencode-bun-proxy\.pid|PID_FILE" src/ || true; rg 'process\.on\s*\(\s*["'"'"']uncaughtException' src/ || true; rg 'process\.on\s*\(\s*["'"'"']unhandledRejection' src/ || true; rg 'process\.on\s*\(\s*["'"'"']SIGINT' src/ || true; rg 'process\.exit' src/ --type ts || true; rg "CURRENT_VERSION\s*=\s*1" src/storage.ts; } 2>&1 | tee .sisyphus/evidence/task-41-guardrails.txt
         # First 7 rg commands expect 0 matches (exit 1 from rg, suppressed with ||true). Last rg must match exactly 1 line. Inspect the evidence file manually to confirm.
      7. bash scripts/qa-parallel.sh 2>&1 | tee .sisyphus/evidence/task-41-qa-parallel.txt
      8. ls .sisyphus/evidence/ | wc -l → expect ≥ 70 evidence files (roughly 2 per task × 41 tasks + extras)
    Expected Result: All commands pass; evidence files present
    Failure Indicators: Any command fails; missing evidence
    Evidence: task-41-*.txt + wave-6-final-regression.md
  ```

  **Evidence to Capture**: task-41-vitest.txt, task-41-tsc.txt, task-41-lint.txt, task-41-format.txt, task-41-build.txt, task-41-guardrails.txt, task-41-qa-parallel.txt, wave-6-final-regression.md

  **Commit**: YES
  - Message: `chore: final regression verification pass`
  - Files: evidence files only (if not yet committed); otherwise empty commit with `--allow-empty` and justification
  - Pre-commit: `npx vitest run && npx tsc --noEmit && npm run build`

---

## Wave 6 Checkpoint (after T37-T41)

All 41 implementation tasks complete. Full regression suite GREEN. Evidence captured. Ready for Final Verification Wave (F1-F4).

**Exit criteria**:

- T0-T41 complete
- All guardrail greps: 0 matches
- Full suite: passing (baseline tests + ~100 new tests from Wave 2 RED now GREEN)
- Build: succeeds with all dist artifacts
- Manual QA script: PASS
- Evidence: `.sisyphus/evidence/` contains files for every task

---

## Final Verification Wave (MANDATORY — after T41)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback → fix → re-run → present again → wait for okay.

- [ ] F1. Plan compliance audit

  **What to do**:
  - Read `.sisyphus/plans/parallel-and-auth-fix.md` end-to-end in this order: TL;DR → Context → Work Objectives → Verification Strategy → Execution Strategy → TODOs T0-T41 → Final Verification Wave → Commit Strategy → Success Criteria
  - For EACH item under "Must Have": locate the implementation that satisfies it and produce evidence:
    - Single per-instance Bun proxy → `rg "createBunFetch" src/bun-fetch.ts` shows factory; `rg "let proxyPort" src/bun-fetch.ts` returns 0 matches
    - Kernel-assigned ephemeral port → `rg "port:\\s*0" src/bun-proxy.ts` shows Bun.serve config
    - Buffered line-reader stdout banner → read `src/bun-fetch.ts`, confirm `readline.createInterface` is used against child.stdout
    - Parent-PID death detection → `rg "ParentPidWatcher|parent-pid-watcher" src/bun-proxy.ts` matches; `src/parent-pid-watcher.ts` exists
    - Zero restart-kill in catch blocks → `rg "stopBunProxy" src/bun-fetch.ts` returns 0 matches inside catch handlers
    - Per-request circuit breaker → `src/circuit-breaker.ts` exists; used per-instance in `bun-fetch.ts`
    - Single proxy handles N=50 parallel → `npx vitest run src/__tests__/bun-proxy.parallel.test.ts -t "50 concurrent"` passes
    - SSE wrapper rejects truncated streams → `npx vitest run src/response/streaming.test.ts -t "truncated"` passes
    - SSE wrapper uses event-block framing → `rg "lastIndexOf\\(\"\\\\n\"\\)" src/response/streaming.ts` returns 0 matches
    - Parser and rewriter share one buffer → `rg "sseRewriteBuffer" src/response/streaming.ts` returns 0 matches
    - Non-SSE JSON responses de-prefixed → `rg "stripMcpPrefixFromJsonBody" src/response/mcp.ts` matches
    - Outbound double-prefix defense → `npx vitest run src/request/body.history.test.ts -t "double-prefix"` passes
    - Runtime init.body type invariant → `rg "TypeError" src/request/body.ts` matches
    - Body clone-before-use → `rg "cloneBodyForRetry" src/request/body.ts` matches
    - AccountIdentity abstraction → `src/account-identity.ts` exists with required exports
    - Identity-first `addAccount` + `load` CC auto-detect + Flow A/B authorize + `cmdLogin` → `rg "findByIdentity" src/accounts.ts src/index.ts src/cli.ts` shows ≥4 call sites
    - `syncActiveIndexFromDisk` preserves `source` + object identity → `npx vitest run src/accounts.dedup.test.ts -t "syncActiveIndexFromDisk"` passes
    - `saveAccounts` unions disk-only → `npx vitest run src/accounts.dedup.test.ts -t "disk-only"` passes
    - CC auto-detect MAX_ACCOUNTS cap → `npx vitest run src/accounts.dedup.test.ts -t "MAX_ACCOUNTS"` passes
    - Refresh lock `staleMs ≥ 90000`, `timeoutMs ≥ 15000` → `rg "DEFAULT_STALE_LOCK_MS\\s*=\\s*9[0-9]{4}" src/refresh-lock.ts` matches; same for timeout
    - Idle→foreground single-flight re-check → `npx vitest run src/token-refresh.test.ts -t "idle"` passes
    - "Save before release lock" invariant preserved → manual read of `src/token-refresh.ts:refreshAccountToken` confirms save-then-release order
    - Storage version stays at `1` → `rg "CURRENT_VERSION\\s*=\\s*1" src/storage.ts` matches; `rg "CURRENT_VERSION\\s*=\\s*[2-9]" src/storage.ts` returns 0 matches
    - Debug-gating test updated atomically → `git log -p src/__tests__/debug-gating.test.ts` shows the flip in the SAME commit as `src/bun-fetch.ts` changes
    - Graceful native fetch fallback → `npx vitest run src/bun-fetch.test.ts -t "fallback"` passes
    - Zero plugin-installed global `process.exit()` handlers → `rg 'process\\.exit' src/ --type ts --glob '!**/*.test.ts'` returns 0 matches
    - 6 test helpers created → `ls src/__tests__/helpers/*.ts` shows 6 files (plus 6 smoke tests)
    - TDD: every fix has a failing test written BEFORE → `git log --oneline` shows T8-T16 commits precede T17-T36 commits
  - Verify commit count: `git log --oneline <baseline-sha>..HEAD | wc -l` — expect **41** commits for T0-T41 at the time F1 runs (F1 runs BEFORE its own F1 evidence commit lands; F2, F3, F4 evidence commits come after F1 finishes). If counting after all F\* commits: expect **45** total. F1's own verdict output explicitly distinguishes "41 implementation commits" from "45 including final-qa commits".
  - For EACH item under "Must NOT Have": confirm the pattern is absent via grep (use the guardrail commands from the Verification Strategy section)
  - Verify `.sisyphus/evidence/` contains files for every task (T0 through T41 = 42 tasks × ≥1 evidence file each = 42+ files)
  - Verify `git log --oneline` shows 41 commits (one per task after T0) or justifiable atomic pairs (T20+T21 is ONE commit by design)
  - Compare "Concrete Deliverables" section against actual filesystem: every listed file exists

  **Must NOT do**:
  - Run any build/test commands other than the verification greps listed above (quality checks are F2's job)
  - Approve with any Must-Have or Must-Not-Have unsatisfied
  - Accept "partial" compliance — the verdict is APPROVE or REJECT
  - Modify any files during the audit

  **Recommended Agent Profile**:
  - **Category**: invoked via `subagent_type="oracle"` (not a category)
  - **Skills**: `["workflows"]`
    - `workflows`: understanding of plan compliance audit methodology

  **Parallelization**:
  - **Can Run In Parallel**: YES (with F2, F3, F4)
  - **Parallel Group**: Final Verification Wave
  - **Blocks**: user explicit okay (the final handoff)
  - **Blocked By**: T0-T41 all complete

  **References**:

  **Pattern References**:
  - `.sisyphus/plans/parallel-and-auth-fix.md` — the full plan (this file)
  - Verification Strategy → Checkpoint Commands — the canonical guardrail grep set

  **WHY**:
  - Plan compliance is the most literal check: every promise becomes an assertion. Oracle runs this because it needs to reason about intent alignment, not just test outputs.

  **Acceptance Criteria**:
  - [ ] Every Must Have item has an evidence line (command + expected result)
  - [ ] Every Must NOT Have item has a guardrail-grep result (expected: 0 matches)
  - [ ] Every task T0-T41 has at least one evidence file under `.sisyphus/evidence/`
  - [ ] Output follows exactly: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [42/42] | Evidence Files [≥42] | VERDICT: APPROVE | REJECT`
  - [ ] If REJECT, the output enumerates every unsatisfied item with a specific pointer (file:line or command that returned unexpected output)

  **QA Scenarios**:

  ```
  Scenario: Plan compliance audit completes with explicit verdict
    Tool: oracle subagent
    Preconditions: T0-T41 complete; evidence files present
    Steps:
      1. Invoke `task(subagent_type="oracle", load_skills=["workflows"], prompt="Read .sisyphus/plans/parallel-and-auth-fix.md end-to-end and run the F1 compliance audit per the task definition. Return the exact output format specified.", run_in_background=false)`
      2. Capture the verdict line
      3. Save oracle output to `.sisyphus/evidence/final-qa/f1-plan-compliance.md`
      4. If verdict is REJECT, STOP and report back to Prometheus
    Expected Result: Oracle returns `VERDICT: APPROVE` with all counts satisfied
    Failure Indicators: Any `VERDICT: REJECT`, missing counts, or oracle unable to locate evidence files
    Evidence: .sisyphus/evidence/final-qa/f1-plan-compliance.md
  ```

  **Evidence to Capture**:
  - [ ] `.sisyphus/evidence/final-qa/f1-plan-compliance.md` (oracle output)

  **Commit**: YES (evidence-only commit, `--no-verify` because evidence files are not code and do not need to pass npm test)
  - Message: `chore(final-qa): F1 plan compliance audit evidence`
  - Files: `.sisyphus/evidence/final-qa/f1-plan-compliance.md`
  - Pre-commit: BYPASSED via `--no-verify` (evidence-only, not a source change)

- [ ] F2. Code quality review

  **What to do**:
  - Run the full quality pipeline and capture outputs:
    - `npx tsc --noEmit` → `.sisyphus/evidence/final-qa/f2-tsc.txt` (compare against T0 baseline)
    - `npm run lint` → `.sisyphus/evidence/final-qa/f2-lint.txt` (compare against T0 baseline)
    - `npm run format:check` → `.sisyphus/evidence/final-qa/f2-format.txt` (compare against T0 baseline)
    - `npx vitest run` → `.sisyphus/evidence/final-qa/f2-vitest.txt` (all tests pass; test count increased by ~100 vs baseline)
    - `npm run build` → `.sisyphus/evidence/final-qa/f2-build.txt` (all dist artifacts produced)
  - Run AI-slop / code-smell checks across every changed file (use `git diff <baseline-sha> HEAD --stat` to get the list):
    - `rg "as\\s+any" <changed-files>` — flag each match for manual review
    - `rg "@ts-ignore|@ts-expect-error" <changed-files>` — flag each match
    - `rg "catch\\s*\\(\\s*\\w*\\s*\\)\\s*\\{\\s*\\}" <changed-files>` — empty catches
    - `rg "console\\.(log|info|warn|error)" src/ --glob '!**/*.test.ts' --glob '!**/cli*.ts'` — console calls outside debug-gated paths
    - `rg "^\\s*//\\s*(TODO|FIXME|XXX|HACK):" <changed-files>` — leftover todos
    - `rg "^\\s*//.*(disabled|commented out|temporary)" <changed-files>` — commented-out code
    - Manual read of each changed file for: excessive/obvious-only comments, over-abstraction (single-use interfaces/factories), generic names (`data`, `result`, `item`, `temp`, `handler` without scope), inconsistent naming, duplicated logic
  - Verify atomic commit structure: `git log --oneline <baseline-sha>..HEAD` — expect exactly **41 implementation commits** for T0-T41 at the time F2 runs (F1/F2/F3/F4 each add ONE evidence commit after their task completes, bringing the final total to 45). Tasks T0-T41 form the implementation set; F1-F4 form the verification set. F2 verifies the 41 implementation commits.
  - Verify commit message format matches the Commit Strategy section exactly (41 implementation entries + 4 F\* evidence entries for a 45-row total)
  - Verify that Wave 2 RED commits (T8-T16, 9 commits) use `--no-verify` per the plan's Pre-commit Hook Interaction policy. Check commit bodies for the "Pre-commit bypass justification: TDD RED phase" line. Any Wave 2 RED commit missing this rationale is a violation.
  - Verify that F1-F4 evidence commits use `--no-verify` with `chore(final-qa):` prefix. These are allowed bypasses for evidence-only commits.
  - Produce `.sisyphus/evidence/final-qa/f2-summary.md` with the required output format

  **Must NOT do**:
  - Fix code smells inline during review (file them as findings; fixes are Prometheus's job if the review rejects)
  - Approve if any guardrail grep returns non-zero
  - Modify any files

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["workflows", "testing"]`
    - `workflows`: review protocol + code review methodology
    - `testing`: understanding of vitest output and regression interpretation

  **Parallelization**:
  - **Can Run In Parallel**: YES (with F1, F3, F4)
  - **Parallel Group**: Final Verification Wave
  - **Blocks**: user explicit okay
  - **Blocked By**: T0-T41 all complete

  **References**:

  **Pattern References**:
  - `.github/workflows/ci.yml` — canonical CI command sequence
  - Verification Strategy → Checkpoint Commands
  - T0 baseline evidence for regression comparison

  **WHY**:
  - F2 catches regressions and quality drift that F1 (compliance) cannot see. These are orthogonal lenses: F1 asks "did you build what you promised", F2 asks "is what you built clean".

  **Acceptance Criteria**:
  - [ ] `tsc --noEmit`: no new errors vs T0 baseline
  - [ ] `npm run lint`: matches or improves on T0 baseline
  - [ ] `npm run format:check`: passes
  - [ ] `npx vitest run`: all tests pass, count ≥ T0 baseline + ~100 new tests
  - [ ] `npm run build`: all dist artifacts present
  - [ ] Zero `as any` / `@ts-ignore` in source files touched by this plan (test files may be exempt with justification)
  - [ ] Zero empty catch blocks in source files touched by this plan
  - [ ] Zero commented-out code in source files touched by this plan
  - [ ] Atomic commit structure verified: exactly **41** implementation commits (T0-T41 with T20+T21 atomic pair) at the time F2 runs; the full set grows to 45 after F1-F4 evidence commits land
  - [ ] Wave 2 RED commits (T8-T16, 9 commits) use `--no-verify` with the TDD RED justification text in the body
  - [ ] 32 implementation commits passed `.husky/pre-commit` without bypass
  - [ ] F1-F4 evidence commits (4 total, added AFTER F2 runs) use `--no-verify` with `chore(final-qa):` prefix (verified by a follow-up audit or by F4 itself which runs last)
  - [ ] Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Format [PASS/FAIL] | Tests [N pass/N fail] | TSC [N errors] | Files [N clean/N issues] | Commits [N] | VERDICT: APPROVE | REJECT`

  **QA Scenarios**:

  ```
  Scenario: Code quality review completes with explicit verdict
    Tool: Bash + agent review
    Preconditions: T0-T41 complete; baseline evidence from T0 available
    Steps:
      1. Run each command listed above and capture output
      2. Compare vitest / tsc / lint counts against T0 baseline
      3. Run the AI-slop greps over the changed file set
      4. Read each changed source file for smells
      5. Verify commit structure via `git log --oneline`
      6. Write `.sisyphus/evidence/final-qa/f2-summary.md` with the verdict output
    Expected Result: VERDICT: APPROVE
    Failure Indicators: Any check fails, any slop detected, atomic commit structure wrong
    Evidence: f2-tsc.txt, f2-lint.txt, f2-format.txt, f2-vitest.txt, f2-build.txt, f2-summary.md
  ```

  **Evidence to Capture**:
  - [ ] `.sisyphus/evidence/final-qa/f2-tsc.txt`
  - [ ] `.sisyphus/evidence/final-qa/f2-lint.txt`
  - [ ] `.sisyphus/evidence/final-qa/f2-format.txt`
  - [ ] `.sisyphus/evidence/final-qa/f2-vitest.txt`
  - [ ] `.sisyphus/evidence/final-qa/f2-build.txt`
  - [ ] `.sisyphus/evidence/final-qa/f2-summary.md`

  **Commit**: YES (evidence-only, `--no-verify`)
  - Message: `chore(final-qa): F2 code quality review evidence`
  - Files: `.sisyphus/evidence/final-qa/f2-*.txt`, `.sisyphus/evidence/final-qa/f2-summary.md`
  - Pre-commit: BYPASSED via `--no-verify` (evidence-only)

- [ ] F3. Real manual QA (read-only re-verification + isolated sandbox runs)

  **What to do**:
  - **IMPORTANT — F3 runs in parallel with F1/F2/F4 against the SAME clean HEAD. F3 MUST NOT modify any SOURCE file in the main worktree.** All mutating QA runs execute inside a fresh throwaway git worktree. F3 DOES write evidence artifacts — those live under `.sisyphus/evidence/final-qa/` in the main worktree as untracked files (added by a dedicated F3 commit at the end of the task). The plan DOES track `.sisyphus/evidence/` in git (per T0), so F3's new files are new untracked content; F3's commit adds them.
  - Start from clean HEAD (T41 commit).
  - **Phase 1 — Evidence audit (read-only)**: For each task T0-T41, verify the evidence files listed in the task's "Evidence to Capture" block exist under `.sisyphus/evidence/` and are non-empty.
    - `for N in $(seq 0 41); do ls .sisyphus/evidence/task-$N-*.txt >/dev/null 2>&1 || echo "MISSING task-$N evidence"; done | tee /tmp/f3-phase1-audit.txt`
    - `[ ! -s /tmp/f3-phase1-audit.txt ]` — expect empty
  - **Phase 2 — Isolated sandbox setup**:
    1. `SANDBOX=/tmp/f3-sandbox-$(date +%s)`
    2. `git worktree add "$SANDBOX" HEAD` (isolated copy; changes here DO NOT affect the main worktree)
    3. `(cd "$SANDBOX" && npm install --prefer-offline --no-audit)` — install deps in sandbox (node_modules is gitignored; sandbox needs its own)
    4. `(cd "$SANDBOX" && npm run build)` — **build `dist/` inside the sandbox** because `dist/` is gitignored and will not come with the worktree. This produces the sandbox's own `dist/bun-proxy.mjs`, `dist/opencode-anthropic-auth-plugin.js`, etc.
    5. Verify build succeeded: `[ -f "$SANDBOX/dist/bun-proxy.mjs" ]`
  - **Phase 3 — `qa-parallel.sh` stability runs (inside sandbox)**:
    1. `(cd "$SANDBOX" && bash scripts/qa-parallel.sh) 2>&1 > /tmp/f3-qa-parallel-1.txt`
    2. `(cd "$SANDBOX" && bash scripts/qa-parallel.sh) 2>&1 > /tmp/f3-qa-parallel-2.txt`
    3. `(cd "$SANDBOX" && bash scripts/qa-parallel.sh) 2>&1 > /tmp/f3-qa-parallel-3.txt`
    4. Grep each output for the PASS marker; fail if any run misses PASS
  - **Phase 4 — N=50 curl harness (inside sandbox, INLINE commands — no external script required)**:
    ```bash
    # Start inline mock upstream server
    MOCK_PORT=$(node -e 'const s=require("http").createServer((req,res)=>{res.writeHead(200,{"content-type":"text/event-stream"});res.end("event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");}).listen(0,()=>{console.log(s.address().port);});')
    # Start sandbox proxy
    (cd "$SANDBOX" && node dist/bun-proxy.mjs --parent-pid=$$ > /tmp/f3-proxy.log 2>&1) &
    PROXY_PID=$!
    sleep 1
    PROXY_PORT=$(grep -oP 'BUN_PROXY_PORT=\K[0-9]+' /tmp/f3-proxy.log || echo "")
    [ -n "$PROXY_PORT" ] || (echo "FAIL: proxy port not captured" && exit 1)
    # Fire 50 concurrent curl requests
    seq 50 | xargs -I{} -P 50 sh -c "curl -sS -X POST http://127.0.0.1:$PROXY_PORT/ -H 'x-proxy-url: http://127.0.0.1:$MOCK_PORT/v1/messages' -d '{\"id\":{}}' | head -c 200" > /tmp/f3-n50-output.txt
    # Assert 50 responses, 0 errors, 0 orphan tool_use mentions
    grep -c "message_start" /tmp/f3-n50-output.txt  # expect 50
    grep -c "Unable to connect" /tmp/f3-n50-output.txt  # expect 0
    grep -c "tool_use ids were found without tool_result" /tmp/f3-n50-output.txt  # expect 0
    # Cleanup
    kill "$PROXY_PID" 2>/dev/null; wait 2>/dev/null
    ```
  - **Phase 5 — 10-rotation dedup scenario (inside sandbox, INLINE with isolated ACCOUNTS_FILE)**:
    ```bash
    export ANTHROPIC_ACCOUNTS_FILE="$SANDBOX/fake-accounts.json"
    # Write a fake accounts file with 2 initial accounts (inline node)
    node -e 'require("fs").writeFileSync(process.env.ANTHROPIC_ACCOUNTS_FILE, JSON.stringify({version:1,accounts:[{id:"a1",refreshToken:"r1",source:"oauth",email:"a@x.com",...},{id:"a2",refreshToken:"r2",source:"oauth",email:"b@x.com",...}],activeIndex:0}));'
    # Start mock OAuth endpoint that returns rotated tokens
    OAUTH_PORT=$(node -e '<inline mock oauth server that returns a new refresh_token each call>')
    # Run the plugin's AccountManager with 10 refresh cycles (direct Node, not full OpenCode)
    (cd "$SANDBOX" && node -e '
      process.env.ANTHROPIC_OAUTH_TOKEN_URL = "http://127.0.0.1:'$OAUTH_PORT'/token";
      const { AccountManager } = require("./dist/opencode-anthropic-auth-plugin.js");
      (async () => {
        const mgr = await AccountManager.load({});
        for (let i = 0; i < 10; i++) {
          await refreshAccountTokenSingleFlight(mgr.getAccounts()[0], "foreground");
          await refreshAccountTokenSingleFlight(mgr.getAccounts()[1], "foreground");
        }
        await mgr.saveToDisk();
        const final = JSON.parse(require("fs").readFileSync(process.env.ANTHROPIC_ACCOUNTS_FILE, "utf-8"));
        console.log("ACCOUNT_COUNT=" + final.accounts.length);
      })();
    ') > /tmp/f3-rotation.txt 2>&1
    grep "ACCOUNT_COUNT=2" /tmp/f3-rotation.txt  # expect: 2 accounts, not 22
    ```
    Note: the exact inline Node invocation may need adjustment based on the actual plugin's exported API after Wave 5; the reviewer should adapt as needed while preserving the semantic assertion (N=2 accounts in, N=2 accounts out after 10 rotations).
  - **Phase 6 — Sandbox cleanup**:
    1. `kill` any residual subprocesses started in phases 3-5
    2. `git worktree remove "$SANDBOX" --force`
    3. `rm -rf "$SANDBOX"` (worktree remove may leave residual dirs)
  - **Phase 7 — Evidence capture**:
    1. Copy `/tmp/f3-*` files into `.sisyphus/evidence/final-qa/` with `cp /tmp/f3-*.txt .sisyphus/evidence/final-qa/`
    2. Write `.sisyphus/evidence/final-qa/f3-manual-qa-summary.md` with the verdict output
    3. `ps aux | grep -v grep | grep bun-proxy` — expect empty
    4. `git status --porcelain -- 'src/' 'index.test.ts' 'cli.test.ts' '.husky/' 'scripts/' 'package.json' 'tsconfig.json' '.github/'` — **expect empty** (F3 must not mutate source or config files in the main worktree; new untracked files under `.sisyphus/evidence/final-qa/` are EXPECTED and ALLOWED)
  - **Phase 8 — F3 commit** (new — F3 now produces a commit to land its evidence artifacts cleanly):
    1. `git add .sisyphus/evidence/final-qa/f3-*.txt .sisyphus/evidence/final-qa/f3-manual-qa-summary.md .sisyphus/evidence/final-qa/qa-parallel-run-*.txt .sisyphus/evidence/final-qa/n50-parallel.txt .sisyphus/evidence/final-qa/10-rotation.txt`
    2. `git commit --no-verify -m "chore(final-qa): F3 manual QA evidence"` (uses `--no-verify` because this is an evidence-only commit and does not need to pass npm test)

  **Must NOT do**:
  - Re-run ANY task QA scenario that writes to `src/` or mutates the plugin code in the main worktree
  - Mutate `~/.config/opencode/` or any real user config
  - Use real Anthropic API
  - Leave sandbox worktrees behind (always `git worktree remove` + `rm -rf` in cleanup)
  - Fix bugs inline if found (report them as findings)
  - Depend on `dist/` being present in the sandbox worktree — it is gitignored and MUST be rebuilt inside the sandbox
  - Depend on any script that does not exist in the tracked codebase (all inline commands above are self-contained)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `["testing", "workflows"]`
    - `testing`: test execution + evidence capture
    - `workflows`: end-to-end QA protocol

  **Parallelization**:
  - **Can Run In Parallel**: YES (with F1, F2, F4)
  - **Parallel Group**: Final Verification Wave
  - **Blocks**: user explicit okay
  - **Blocked By**: T0-T41 complete + `scripts/qa-parallel.sh` exists (from T39)

  **References**:

  **Pattern References**:
  - `scripts/qa-parallel.sh` — created in T39
  - Every task's QA Scenarios block — the exact re-run steps

  **WHY**:
  - F2 runs automated tests; F3 re-runs every human-executable step to confirm the fix holds outside unit tests. Parallel fan-out is the explicit user-reported failure mode — it MUST be reproducible and now passing.

  **Acceptance Criteria**:
  - [ ] Phase 1 evidence audit: every task T0-T41 has at least one non-empty evidence file under `.sisyphus/evidence/`
  - [ ] Phase 2 sandbox worktree created, deps installed, `dist/bun-proxy.mjs` built successfully inside the sandbox
  - [ ] Phase 3: `scripts/qa-parallel.sh` PASSES 3/3 consecutive runs inside the sandbox
  - [ ] Phase 4: N=50 concurrent curl requests in sandbox show 50 `message_start` matches, 0 `Unable to connect`, 0 `tool_use ids were found without tool_result`
  - [ ] Phase 5: 10-rotation dedup scenario reports `ACCOUNT_COUNT=2` (no duplicates)
  - [ ] Phase 6: sandbox worktree removed; `/tmp/f3-sandbox-*` path no longer exists
  - [ ] Phase 7: `.sisyphus/evidence/final-qa/f3-*` files populated; `ps aux | grep bun-proxy` empty; `git status --porcelain -- src/ index.test.ts cli.test.ts .husky/ scripts/ package.json tsconfig.json .github/` is empty (F3 touched NO source/config files)
  - [ ] Phase 8: F3 evidence commit landed with message `chore(final-qa): F3 manual QA evidence` (commit count now 41 + 4 = 45 total after all F\* evidence commits)
  - [ ] Output: `Phase 1 Evidence [42/42 present] | Phase 2 Sandbox [OK] | Phase 3 qa-parallel [3/3 PASS] | Phase 4 N=50 [PASS/FAIL] | Phase 5 Rotation [PASS/FAIL] | Phase 6 Sandbox Cleaned [CLEAN] | Phase 7 Main Source Clean [CLEAN] | Phase 8 Evidence Commit [OK] | VERDICT: APPROVE | REJECT`

  **QA Scenarios**:

  ```
  Scenario: F3 runs read-only on main + mutating runs in isolated sandbox with full setup
    Tool: Bash + interactive_bash (tmux)
    Preconditions:
      - T41 complete (T0-T41 all committed)
      - scripts/qa-parallel.sh + scripts/rotation-test.js + scripts/mock-upstream.js exist from T39
      - .sisyphus/evidence/ populated from T0-T41
      - mkdir -p .sisyphus/evidence/final-qa/
    Steps:
      # ---- Phase 1: read-only evidence audit against main worktree ----
      1. mkdir -p .sisyphus/evidence/final-qa
      2. for N in $(seq 0 41); do ls .sisyphus/evidence/task-$N-*.txt >/dev/null 2>&1 || echo "MISSING task-$N evidence"; done | tee .sisyphus/evidence/final-qa/f3-phase1-audit.txt
      3. [ ! -s .sisyphus/evidence/final-qa/f3-phase1-audit.txt ] || (echo "FAIL: missing evidence" && exit 1)

      # ---- Phase 2: sandbox creation with full setup (install deps + build dist) ----
      4. SANDBOX="/tmp/f3-sandbox-$(date +%s)"
      5. git worktree add "$SANDBOX" HEAD
      6. (cd "$SANDBOX" && npm install --prefer-offline --no-audit) 2>&1 | tee .sisyphus/evidence/final-qa/f3-phase2-install.txt
         # install sandbox deps (node_modules is gitignored, must be installed fresh)
      7. (cd "$SANDBOX" && npm run build) 2>&1 | tee .sisyphus/evidence/final-qa/f3-phase2-build.txt
         # build sandbox dist/ (dist/ is gitignored, must be built fresh)
      8. [ -f "$SANDBOX/dist/bun-proxy.mjs" ] || (echo "FAIL: sandbox dist build did not produce bun-proxy.mjs" && exit 1)
      9. [ -f "$SANDBOX/dist/opencode-anthropic-auth-plugin.js" ] || (echo "FAIL: sandbox dist build did not produce plugin.js" && exit 1)

      # ---- Phase 3: qa-parallel.sh stability runs (3 consecutive) ----
      10. (cd "$SANDBOX" && bash scripts/qa-parallel.sh) 2>&1 | tee .sisyphus/evidence/final-qa/qa-parallel-run-1.txt
      11. grep -q "^PASS" .sisyphus/evidence/final-qa/qa-parallel-run-1.txt || (echo "FAIL: qa-parallel run 1 not PASS" && exit 1)
      12. (cd "$SANDBOX" && bash scripts/qa-parallel.sh) 2>&1 | tee .sisyphus/evidence/final-qa/qa-parallel-run-2.txt
      13. grep -q "^PASS" .sisyphus/evidence/final-qa/qa-parallel-run-2.txt || (echo "FAIL: qa-parallel run 2 not PASS" && exit 1)
      14. (cd "$SANDBOX" && bash scripts/qa-parallel.sh) 2>&1 | tee .sisyphus/evidence/final-qa/qa-parallel-run-3.txt
      15. grep -q "^PASS" .sisyphus/evidence/final-qa/qa-parallel-run-3.txt || (echo "FAIL: qa-parallel run 3 not PASS" && exit 1)

      # ---- Phase 4: Direct N=50 curl fan-out (uses scripts/mock-upstream.js and dist/bun-proxy.mjs from the sandbox) ----
      16. (cd "$SANDBOX" && node scripts/mock-upstream.js) > /tmp/f3-mock-upstream.log 2>&1 &
      17. MOCK_PID=$!
      18. sleep 0.5
      19. MOCK_PORT=$(grep -oE 'MOCK_UPSTREAM_PORT=[0-9]+' /tmp/f3-mock-upstream.log | head -1 | cut -d= -f2)
      20. [ -n "$MOCK_PORT" ] || (echo "FAIL: mock upstream did not print port" && exit 1)
      21. (cd "$SANDBOX" && node dist/bun-proxy.mjs --parent-pid=$$) > /tmp/f3-proxy.log 2>&1 &
      22. PROXY_PID=$!
      23. sleep 1
      24. PROXY_PORT=$(grep -oE 'BUN_PROXY_PORT=[0-9]+' /tmp/f3-proxy.log | head -1 | cut -d= -f2)
      25. [ -n "$PROXY_PORT" ] || (kill $MOCK_PID $PROXY_PID; echo "FAIL: proxy port not captured" && exit 1)
      26. seq 50 | xargs -I{} -P 50 sh -c "curl -sS -X POST http://127.0.0.1:$PROXY_PORT/ -H 'x-proxy-url: http://127.0.0.1:$MOCK_PORT/v1/messages' -d '{\"id\":{}}'" > /tmp/f3-n50-output.txt
      27. MESSAGE_STOPS=$(grep -c "message_stop" /tmp/f3-n50-output.txt)
      28. CONNECT_ERRORS=$(grep -c "Unable to connect" /tmp/f3-n50-output.txt)
      29. ORPHANS=$(grep -c "tool_use ids were found without tool_result" /tmp/f3-n50-output.txt)
      30. echo "message_stops=$MESSAGE_STOPS connect_errors=$CONNECT_ERRORS orphans=$ORPHANS" > .sisyphus/evidence/final-qa/n50-parallel.txt
      31. kill $PROXY_PID $MOCK_PID 2>/dev/null; wait 2>/dev/null
      32. [ "$MESSAGE_STOPS" -eq 50 ] || (echo "FAIL: expected 50 message_stop got $MESSAGE_STOPS" && exit 1)
      33. [ "$CONNECT_ERRORS" -eq 0 ] || (echo "FAIL: got $CONNECT_ERRORS connect errors" && exit 1)
      34. [ "$ORPHANS" -eq 0 ] || (echo "FAIL: got $ORPHANS tool_use orphans" && exit 1)

      # ---- Phase 5: 10-rotation dedup scenario using scripts/rotation-test.js with isolated ACCOUNTS_FILE ----
      35. ROTATION_ACCOUNTS="$SANDBOX/fake-accounts.json"
      36. (cd "$SANDBOX" && ANTHROPIC_ACCOUNTS_FILE="$ROTATION_ACCOUNTS" node scripts/rotation-test.js) 2>&1 | tee .sisyphus/evidence/final-qa/10-rotation.txt
      37. grep -q "^ACCOUNT_COUNT=2$" .sisyphus/evidence/final-qa/10-rotation.txt || (echo "FAIL: rotation test found duplicates" && exit 1)

      # ---- Phase 6: sandbox cleanup ----
      38. git worktree remove "$SANDBOX" --force
      39. rm -rf "$SANDBOX" 2>/dev/null || true

      # ---- Phase 7: residual subprocess check + main worktree source-clean check ----
      40. ps aux | grep -v grep | grep -E "bun-proxy|mock-upstream" | tee .sisyphus/evidence/final-qa/f3-residual.txt
      41. [ ! -s .sisyphus/evidence/final-qa/f3-residual.txt ] || (echo "FAIL: residual subprocesses" && exit 1)
      42. git status --porcelain -- 'src/' 'index.test.ts' 'cli.test.ts' '.husky/' 'scripts/' 'package.json' 'tsconfig.json' '.github/' | tee .sisyphus/evidence/final-qa/f3-main-source-clean.txt
      43. [ ! -s .sisyphus/evidence/final-qa/f3-main-source-clean.txt ] || (echo "FAIL: F3 mutated source files in main worktree" && exit 1)

      # ---- Phase 8: evidence commit ----
      44. git add .sisyphus/evidence/final-qa/f3-phase1-audit.txt .sisyphus/evidence/final-qa/f3-phase2-install.txt .sisyphus/evidence/final-qa/f3-phase2-build.txt .sisyphus/evidence/final-qa/qa-parallel-run-1.txt .sisyphus/evidence/final-qa/qa-parallel-run-2.txt .sisyphus/evidence/final-qa/qa-parallel-run-3.txt .sisyphus/evidence/final-qa/n50-parallel.txt .sisyphus/evidence/final-qa/10-rotation.txt .sisyphus/evidence/final-qa/f3-residual.txt .sisyphus/evidence/final-qa/f3-main-source-clean.txt
      45. # Write the summary
      46. cat > .sisyphus/evidence/final-qa/f3-manual-qa-summary.md <<EOF
          # F3 Manual QA Summary
          Phase 1 Evidence: 42/42 present
          Phase 2 Sandbox: install + build OK
          Phase 3 qa-parallel: 3/3 PASS
          Phase 4 N=50: 50 message_stop / 0 connect_errors / 0 orphans
          Phase 5 Rotation: ACCOUNT_COUNT=2 (no dedup failure)
          Phase 6 Sandbox: cleaned up
          Phase 7 Main Source: CLEAN (no source file mutations)
          VERDICT: APPROVE
          EOF
      47. git add .sisyphus/evidence/final-qa/f3-manual-qa-summary.md
      48. git commit --no-verify -m "chore(final-qa): F3 manual QA evidence"
    Expected Result: VERDICT: APPROVE; main worktree source-clean; evidence committed
    Failure Indicators: Any of steps 3-47 exits non-zero; mock-upstream/proxy port missing; rotation finds duplicates; source files mutated
    Evidence: f3-manual-qa-summary.md + all phase output files listed above
  ```

  **Evidence to Capture**:
  - [ ] `.sisyphus/evidence/final-qa/f3-phase1-audit.txt`
  - [ ] `.sisyphus/evidence/final-qa/qa-parallel-run-{1,2,3}.txt`
  - [ ] `.sisyphus/evidence/final-qa/n50-parallel.txt`
  - [ ] `.sisyphus/evidence/final-qa/10-rotation.txt`
  - [ ] `.sisyphus/evidence/final-qa/f3-residual.txt`
  - [ ] `.sisyphus/evidence/final-qa/f3-main-clean.txt`
  - [ ] `.sisyphus/evidence/final-qa/f3-manual-qa-summary.md`

  **Commit**: YES — see Phase 8 above. F3 produces a single evidence commit at the end of Phase 8 using `git commit --no-verify` with message `chore(final-qa): F3 manual QA evidence`.

- [ ] F4. Scope fidelity check

  **What to do**:
  - For each task T0-T41:
    - Read the task's "What to do" + "Must NOT do" + "Files" (from Commit) sections
    - Run `git show <task-commit-sha> --stat` to see the actual files touched
    - Compare 1:1: every file listed in the commit MUST be in the task's "Files"; every file in the task's "Files" MUST appear in the commit (unless justified)
    - For each file, read the diff via `git show <commit-sha> <file>` — verify the changes match the "What to do" and do NOT include anything forbidden by "Must NOT do"
  - Cross-task contamination detection:
    - Build a map: `{ task_id: Set<file_path> }` from the commits
    - Build the INVERSE map: `{ file_path: Set<task_id> }` — allow multiple tasks per file ONLY if each task's "Files" list in the plan explicitly names that file
    - **Expected multi-task files** (planned overlaps, NOT contamination):
      - `src/index.ts`: T20 (interceptor + createBunFetch wiring), T24 (caller wiring for mcp non-SSE), T25 (BODY-3 body merge), T26 (body clone + per-request state), T27 (StreamTruncatedError handling), T33 (DEDUP-A/B authorize flows) — all planned
      - `src/accounts.ts`: T29 (identity field additions), T30 (addAccount + sync), T31 (saveToDisk union) — all planned
      - `src/bun-fetch.ts`: T20 (main rewrite), T22 (fallback hardening), T28 (upstream abort client-side wiring) — all planned
      - `src/bun-proxy.ts`: T19 (main rewrite), T28 (upstream abort signal) — all planned
      - `src/response/streaming.ts`: T23 (main rewrite), T27 (StreamTruncatedError export) — all planned
      - `src/response/mcp.ts`: T24 (non-SSE JSON path) — single task
      - `src/storage.ts`: T31 (union support), T32 (preserve source + tolerate version) — planned
      - `src/token-refresh.ts`: T35 (lock constants), T36 (in-place updates + applyDiskAuthIfFresher fix) — planned
      - `index.test.ts`: T23, T25, T26, T40 may all need updates; T40 is the bulk sweep
      - `src/__tests__/debug-gating.test.ts`: T21 (single update, atomic with T20 commit)
    - Flag as contamination ONLY files that appear in more than one task's "Files" list WITHOUT being on the expected-overlaps list above, OR files modified by a commit but not named in any task's "Files" list (unaccounted)
  - Metis scope tripwire check:
    - `git diff <baseline-sha> HEAD -- src/oauth.ts` — expect changes ONLY at DEDUP call sites (lines involving `addAccount` or `findByIdentity`); reject if any other lines changed
    - `git diff <baseline-sha> HEAD -- src/system-prompt/` — expect no changes
    - `git diff <baseline-sha> HEAD -- src/headers/` — expect no changes
    - `git diff <baseline-sha> HEAD -- src/request/url.ts src/request/metadata.ts` — expect no changes
    - `git diff <baseline-sha> HEAD -- src/rotation.ts` — expect no changes
    - `git diff <baseline-sha> HEAD -- src/files*` — expect no changes
    - `git diff <baseline-sha> HEAD -- src/commands/` — expect changes ONLY if T34 cmdLogin pattern was applied via commands/ (but cmdLogin lives in cli.ts, so expect no commands/ changes)
    - `git diff <baseline-sha> HEAD -- src/models.ts src/env.ts` — expect no changes (env.ts may have VITEST short-circuit additions — allow those)
  - Unaccounted change detection:
    - `git diff <baseline-sha> HEAD --stat` → list all changed files
    - Subtract the union of all task "Files" lists → should be empty set
    - Flag any leftover file that's not claimed by any task
  - Write `.sisyphus/evidence/final-qa/f4-scope-fidelity.md` with the table and verdict

  **Must NOT do**:
  - Run tests (F2 does that)
  - Fix anything inline
  - Accept "missing but reasonable" changes — if it's not in the plan, it's a scope violation

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `["workflows"]`
    - `workflows`: scope-compliance auditing

  **Parallelization**:
  - **Can Run In Parallel**: YES (with F1, F2, F3)
  - **Parallel Group**: Final Verification Wave
  - **Blocks**: user explicit okay
  - **Blocked By**: T0-T41 complete

  **References**:

  **Pattern References**:
  - Plan "Must NOT Have (Guardrails)" → "Scope discipline (Metis tripwires)" section — the canonical forbidden-change list
  - Each task's "Files" list (inside Commit block)

  **WHY**:
  - Scope creep is the silent failure mode that undermines the plan's precision. F4 is the adversarial check: "did any change sneak in that wasn't asked for, OR is any promised change missing?"

  **Acceptance Criteria**:
  - [ ] Every task's commit matches its "Files" list exactly (no missing, no extra)
  - [ ] Every Metis tripwire grep passes (0 unexpected changes in forbidden paths)
  - [ ] No file is touched by a task that does NOT list it in its "Files" list (all multi-task file edits are on the expected-overlaps list)
  - [ ] Unaccounted changes: 0 files (every changed file is claimed by at least one task's "Files" list)
  - [ ] Output: `Tasks [42/42 compliant] | Planned Overlaps [N allowed] | Unexpected Overlaps [0] | Metis Tripwires [CLEAN/N] | Unaccounted [CLEAN/N] | VERDICT: APPROVE | REJECT`

  **QA Scenarios**:

  ```
  Scenario: Scope fidelity verified commit-by-commit
    Tool: Bash + git
    Preconditions: T0-T41 complete; git log clean
    Steps:
      1. baseline=$(cat .sisyphus/evidence/task-0-baseline-sha.txt)
      2. git log --oneline $baseline..HEAD > .sisyphus/evidence/final-qa/f4-commits.txt
      3. For each commit: git show <sha> --stat > .sisyphus/evidence/final-qa/f4-stat-<n>.txt
      4. Run the Metis tripwire diffs listed above; save each to .sisyphus/evidence/final-qa/f4-tripwire-<name>.txt
      5. Build the task→files map in .sisyphus/evidence/final-qa/f4-task-files-map.md
      6. Write .sisyphus/evidence/final-qa/f4-scope-fidelity.md with the verdict
    Expected Result: VERDICT: APPROVE
    Evidence: f4-scope-fidelity.md + all helper files
  ```

  **Evidence to Capture**:
  - [ ] `.sisyphus/evidence/final-qa/f4-commits.txt`
  - [ ] `.sisyphus/evidence/final-qa/f4-stat-*.txt`
  - [ ] `.sisyphus/evidence/final-qa/f4-tripwire-*.txt`
  - [ ] `.sisyphus/evidence/final-qa/f4-task-files-map.md`
  - [ ] `.sisyphus/evidence/final-qa/f4-scope-fidelity.md`

  **Commit**: YES (evidence-only, `--no-verify`)
  - Message: `chore(final-qa): F4 scope fidelity check evidence`
  - Files: `.sisyphus/evidence/final-qa/f4-*.txt`, `.sisyphus/evidence/final-qa/f4-*.md`
  - Pre-commit: BYPASSED via `--no-verify` (evidence-only)

---

## Commit Strategy

**Total commits: exactly 45.** 41 implementation commits (T0-T41, with T20+T21 as ONE atomic pair → 42-1 = 41) + 4 Final Verification Wave evidence commits (F1, F2, F3, F4 each produce one evidence commit at the end of their respective tasks).

Commit message format: conventional commits `type(scope): description`.

Pre-commit hook policy:

- **32 implementation commits pass `.husky/pre-commit` (`npm test` + `npx lint-staged`) cleanly**: T0, T1-T7, T17-T41 minus the T20+T21 merge = 32 commits
- **9 implementation commits use `--no-verify` for TDD RED**: T8-T16, with the standardized TDD RED rationale in the body (see Verification Strategy → Pre-commit Hook Interaction)
- **4 Final Verification Wave commits use `--no-verify` for evidence-only**: F1, F2, F3, F4 land `.sisyphus/evidence/final-qa/` artifacts that are not code. These are allowed to bypass because evidence files do not need to pass `npm test`.
- **Total `--no-verify` commits: 13** (9 TDD RED + 4 evidence). **Total clean hook runs: 32.**

### Canonical commit map (41 entries)

| #   | Task                                   | Commit message                                                                                 | Hook             |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------- |
| 1   | T0                                     | `chore(plan): capture baseline state before parallel-and-auth-fix plan`                        | PASS             |
| 2   | T1                                     | `test(infra): add plugin-fetch-harness helper for integration tests`                           | PASS             |
| 3   | T2                                     | `test(infra): add sse helper with encoder and byte-stream chunker`                             | PASS             |
| 4   | T3                                     | `test(infra): add deferred helper for controllable promise races`                              | PASS             |
| 5   | T4                                     | `test(infra): add in-memory-storage helper for accounts dedup tests`                           | PASS             |
| 6   | T5                                     | `test(infra): add mock-bun-proxy helper with injectable subprocess`                            | PASS             |
| 7   | T6                                     | `test(infra): add conversation-history helper for malformed message scenarios`                 | PASS             |
| 8   | T7                                     | `test(infra): Wave 1 close-out — verify vitest helper discovery`                               | PASS             |
| 9   | T8                                     | `test(circuit-breaker): add failing tests for per-client circuit breaker`                      | BYPASS (TDD RED) |
| 10  | T9                                     | `test(parent-pid-watcher): add failing tests for cross-platform parent death detection`        | BYPASS (TDD RED) |
| 11  | T10                                    | `test(account-identity): add failing tests for identity resolution and matching`               | BYPASS (TDD RED) |
| 12  | T11                                    | `test(bun-fetch): add failing tests for per-instance proxy manager lifecycle`                  | BYPASS (TDD RED) |
| 13  | T12                                    | `test(bun-proxy): add failing parallel request tests (N=50, cancellation isolation)`           | BYPASS (TDD RED) |
| 14  | T13                                    | `test(streaming): add failing tests for SSE edge cases and message_stop semantics`             | BYPASS (TDD RED) |
| 15  | T14                                    | `test(accounts): add failing tests for identity-first dedup across rotations`                  | BYPASS (TDD RED) |
| 16  | T15                                    | `test(index): add failing tests for concurrent fetch interceptor fan-out`                      | BYPASS (TDD RED) |
| 17  | T16                                    | `test(body): add failing tests for tool name drift and double-prefix defense`                  | BYPASS (TDD RED) |
| 18  | T17                                    | `feat(circuit-breaker): implement per-client circuit breaker primitive`                        | PASS             |
| 19  | T18                                    | `feat(parent-pid-watcher): implement cross-platform parent death detection`                    | PASS             |
| 20  | T19                                    | `refactor(bun-proxy): rewrite subprocess for per-request lifecycle and parent-PID watcher`     | PASS             |
| 21  | **T20+T21 (atomic pair → ONE commit)** | `refactor(bun-fetch): per-instance proxy manager with no restart-kill and no global handlers`  | PASS             |
| 22  | T22                                    | `fix(bun-fetch): harden native fetch fallback for graceful degradation`                        | PASS             |
| 23  | T23                                    | `refactor(streaming): event-framing SSE wrapper with message_stop terminal validation`         | PASS             |
| 24  | T24                                    | `fix(mcp): add non-SSE JSON path for tool name de-prefixing`                                   | PASS             |
| 25  | T25                                    | `fix(body): runtime init.body invariant and double-prefix defense`                             | PASS             |
| 26  | T26                                    | `refactor(index): body clone-before-use and per-request interceptor state`                     | PASS             |
| 27  | T27                                    | `feat(streaming): propagate stream-completeness errors to consumer`                            | PASS             |
| 28  | T28                                    | `fix(bun-proxy): tie upstream abort signal to client disconnect`                               | PASS             |
| 29  | T29                                    | `feat(account-identity): AccountIdentity abstraction with email/label/legacy resolution`       | PASS             |
| 30  | T30                                    | `refactor(accounts): identity-first addAccount and preserve source in syncActiveIndexFromDisk` | PASS             |
| 31  | T31                                    | `fix(accounts): saveToDisk unions disk-only accounts to prevent silent drops`                  | PASS             |
| 32  | T32                                    | `fix(storage): preserve source field on load and tolerate unknown version additively`          | PASS             |
| 33  | T33                                    | `fix(index): deduplicate CC and OAuth authorize flows by stable identity`                      | PASS             |
| 34  | T34                                    | `fix(cli): deduplicate cmdLogin by stable identity, reuse cmdReauth pattern`                   | PASS             |
| 35  | T35                                    | `fix(refresh-lock): widen staleMs and timeoutMs to exceed CC refresh duration`                 | PASS             |
| 36  | T36                                    | `fix(refresh-helpers): idle-to-foreground single-flight re-check after rejection`              | PASS             |
| 37  | T37                                    | `docs: update README, agents.md, and mimese docs for per-instance proxy lifecycle`             | PASS             |
| 38  | T38                                    | `docs(changelog): v0.1.0 entry for parallel-request and account-dedup fix`                     | PASS             |
| 39  | T39                                    | `test(qa): scripts/qa-parallel.sh for manual parallel fan-out verification`                    | PASS             |
| 40  | T40                                    | `test: update existing tests for identity-first APIs and new lock constants`                   | PASS             |
| 41  | T41                                    | `chore: final regression verification pass`                                                    | PASS             |

**Implementation commits: 41.** **TDD RED bypasses: 9 (T8-T16).** **Clean implementation hook runs: 32.**

Plus 4 Final Verification Wave evidence commits (F1-F4), each `--no-verify`:

| #   | Task | Commit message                                       | Hook                   |
| --- | ---- | ---------------------------------------------------- | ---------------------- |
| 42  | F1   | `chore(final-qa): F1 plan compliance audit evidence` | BYPASS (evidence-only) |
| 43  | F2   | `chore(final-qa): F2 code quality review evidence`   | BYPASS (evidence-only) |
| 44  | F3   | `chore(final-qa): F3 manual QA evidence`             | BYPASS (evidence-only) |
| 45  | F4   | `chore(final-qa): F4 scope fidelity check evidence`  | BYPASS (evidence-only) |

**Grand total: 45 commits.** **Bypassed: 13 (9 TDD RED + 4 evidence).** **Clean hook runs: 32.**

F1's commit-count check and F2's atomic-structure check reference this table as the ground truth. Any deviation (extra commits, missing commits, wrong bypass pattern) is a REJECT signal.

---

## Success Criteria

### Verification Commands

```bash
# Baseline
npx vitest run                                               # expect: all pass (count > 663)
npx tsc --noEmit                                             # expect: 0 errors
npm run lint                                                 # expect: 0 errors
npm run format:check                                         # expect: 0 errors
npm run build                                                # expect: 0 errors + dist/ artifacts present

# Guardrail greps
rg "healthCheckFails|MAX_HEALTH_FAILS" src/                  # expect: 0 matches
rg "48372|FIXED_PORT" src/                                   # expect: 0 matches
rg "opencode-bun-proxy\.pid|PID_FILE" src/                   # expect: 0 matches
rg 'process\.on\s*\(\s*["'"'"']uncaughtException' src/       # expect: 0 matches
rg 'process\.on\s*\(\s*["'"'"']unhandledRejection' src/      # expect: 0 matches
rg 'process\.on\s*\(\s*["'"'"']SIGINT' src/                  # expect: 0 matches (plugin must not install)
rg 'process\.exit' src/ --type ts                            # expect: 0 matches in plugin src
rg "CURRENT_VERSION\s*=\s*1" src/storage.ts                  # expect: 1 match (stays at 1)

# Parallel fan-out verification
npx vitest run src/__tests__/bun-proxy.parallel.test.ts -t "single proxy handles 50 concurrent requests"
npx vitest run src/__tests__/index.parallel.test.ts -t "10 concurrent calls with 1 induced failure does not trip others"
bash scripts/qa-parallel.sh                                   # expect: 0 orphan errors, 0 connect errors

# Account dedup verification
npx vitest run src/accounts.dedup.test.ts -t "10 CC rotation cycles produce zero duplicates"
npx vitest run src/accounts.test.ts -t "syncActiveIndexFromDisk preserves source field"
npx vitest run src/storage.test.ts -t "saveAccounts preserves disk-only accounts"

# Refresh concurrency verification
npx vitest run src/refresh-lock.test.ts -t "staleMs exceeds CC refresh duration"
npx vitest run src/token-refresh.test.ts -t "foreground after idle rejection re-checks single-flight"
```

### Final Checklist

- [ ] All "Must Have" items present (verified by F1 oracle audit)
- [ ] All "Must NOT Have" items absent (verified by grep guardrails + F4 scope check)
- [ ] All 41 tasks complete with evidence files in `.sisyphus/evidence/`
- [ ] All 6 wave checkpoints passed (vitest + tsc + lint + format + build green)
- [ ] F1-F4 final verification wave: all 4 APPROVE
- [ ] User explicit okay received after presenting F1-F4 results
