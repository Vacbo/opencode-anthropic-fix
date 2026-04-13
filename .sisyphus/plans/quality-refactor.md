# Quality Refactor Plan — opencode-anthropic-fix

## TL;DR

> **Quick Summary**: Stabilize the current baseline, then perform a surgical maintainability refactor of the repo’s highest-risk hotspot files without changing public behavior.
>
> **Deliverables**:
>
> - Baseline diagnostics, test, build, and lint state recorded
> - Pre-existing type/test failures documented and reduced where they block safe refactoring
> - `src/cli.ts` decomposed into focused command/support modules
> - `src/index.ts` orchestration path flattened via helper extraction
> - `src/accounts.ts` persistence/reconciliation responsibilities separated
> - `src/commands/router.ts` reduced to routing plus thin command coordination
> - Boundary typing improved where `any`/`Record<string, any>` are avoidable
> - Tests added or expanded for newly extracted or behavior-critical modules
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 4 implementation waves plus final verification wave
> **Critical Path**: Baseline stabilization → CLI decomposition → index orchestration extraction → account manager decomposition → router thinning → verification

---

## Context

### Original Request

Convert the project-wide review into a refactor plan with exceptional quality.

### Interview Summary

**Key Discussions**:

- User allowed full-project scope if needed.
- User wants a plan now, not implementation.
- The safest interpretation is a surgical hotspot-first refactor, not a repo-wide rewrite.

**Research Findings**:

- The repo is disciplined overall, with a healthy modular runtime structure.
- The main maintainability pain is concentrated in a few oversized files rather than everywhere.
- Strong existing patterns should be preserved, especially in request/response/header/system-prompt modules.
- Baseline LSP diagnostics already show pre-existing test/type issues, so stabilization must come first.

### Metis Review

**Identified Gaps** (addressed in this plan):

- Added strict no-breaking-public-API and no-feature-work guardrails.
- Added explicit out-of-scope boundaries to prevent “fix everything” sprawl.
- Added acceptance criteria for backward compatibility, performance neutrality, and security-sensitive touched paths.
- Added explicit treatment of pre-existing failures as baseline conditions that must be documented before refactoring.
- Added sequencing gates so structural refactors happen only after the baseline is stable enough.

---

## Work Objectives

### Core Objective

Improve maintainability and refactorability of the repository by stabilizing existing issues and decomposing the largest, most coupled files while preserving runtime behavior and existing external interfaces.

### Concrete Deliverables

- Recorded baseline for tests, type diagnostics, lint, and build
- Hotspot refactor of `src/cli.ts`
- Hotspot refactor of `src/index.ts`
- Hotspot refactor of `src/accounts.ts`
- Router/business-logic split in `src/commands/router.ts`
- Reduced avoidable boundary type escapes
- Expanded tests around changed behavior and extracted modules

### Definition of Done

- [ ] `npm test` exits successfully or shows no regressions beyond explicitly documented pre-existing failures
- [ ] `npx tsc --noEmit` shows the same or fewer errors than the captured baseline
- [ ] `npm run lint` shows the same or fewer issues than baseline, with zero new warnings/errors in changed files
- [ ] `npm run build` exits 0 and expected dist artifacts exist
- [ ] No public CLI command signatures or documented plugin behavior are unintentionally changed
- [ ] Changed modules have direct tests or expanded regression coverage

### Must Have

- Baseline-first execution
- Hotspot-first refactoring order
- No public API/CLI breakage
- No new features
- Manual QA on actual CLI/plugin-facing behavior touched by the refactor

### Must NOT Have (Guardrails)

- Do NOT do a blind whole-project rewrite
- Do NOT redesign account rotation, OAuth semantics, or plugin architecture unless strictly required to preserve current behavior during extraction
- Do NOT change exported command names, plugin hooks, or config file schema
- Do NOT bundle unrelated cleanup into the hotspot tasks
- Do NOT “fix” every historic lint/type issue across untouched files
- Do NOT replace working module boundaries in `headers/`, `request/`, `response/`, or `system-prompt/` with a new architecture
- Do NOT add features, UX improvements, or new configuration options

### Out of Scope

- New product behavior
- Public API redesign
- Config schema migration
- Switching test frameworks or build tooling
- Reworking core algorithms such as account selection strategy unless needed for behavior-preserving extraction

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — verification must be agent-executed and evidence-backed.

### Test Decision

- **Infrastructure exists**: YES (`vitest`, TypeScript, ESLint, build script)
- **Automated tests**: Tests-after, with baseline capture first
- **Framework**: Vitest + TypeScript diagnostics + ESLint
- **Baseline policy**: Capture and document pre-existing failures before changes; no false claims of “all green” if baseline is already failing

### QA Policy

Every task must include direct QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **CLI changes**: Run actual CLI commands and capture output
- **Plugin/runtime changes**: Run targeted tests and build, plus inspect behavior-driving outputs
- **Type-safety changes**: Run `npx tsc --noEmit` and compare against baseline
- **Lint changes**: Run `npm run lint` or file-scoped lint if needed

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Baseline stabilization and safety gates):
├── Task 1: Capture baseline diagnostics/test/build/lint state           [quick]
├── Task 2: Classify and document pre-existing failures                  [unspecified-high]
├── Task 3: Fix or isolate refactor-blocking test/type issues            [deep]
└── Task 4: Add/expand safety tests around hotspot behavior              [unspecified-high]

Wave 2 (CLI-focused decomposition):
├── Task 5: Extract CLI formatting/rendering utilities                   [quick]
├── Task 6: Extract CLI auth/account command handlers                    [deep]
├── Task 7: Extract CLI usage/config/manage command handlers             [deep]
└── Task 8: Thin CLI dispatch and replace avoidable account any-types    [unspecified-high]

Wave 3 (Runtime hotspot decomposition):
├── Task 9: Extract index.ts request-attempt/orchestration helpers       [deep]
├── Task 10: Extract account persistence/reconciliation helpers          [deep]
├── Task 11: Reduce router.ts business logic into focused helper module  [unspecified-high]
└── Task 12: Remove avoidable boundary type escapes in touched paths     [quick]

Wave 4 (Tightening and regression net):
├── Task 13: Add/expand tests for extracted modules                      [unspecified-high]
├── Task 14: Run hotspot-focused cleanup for duplication/dead seams      [quick]
└── Task 15: Documentation touch-ups for any externally visible nuances  [writing]

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit                                       [oracle]
├── Task F2: Code quality review                                         [unspecified-high]
├── Task F3: Real manual QA                                              [unspecified-high]
└── Task F4: Scope fidelity check                                        [deep]
-> Present results -> Get explicit user okay

Critical Path: T1 -> T2 -> T3 -> T4 -> T6-8 -> T9-12 -> T13 -> F1-F4 -> user okay
Parallel Speedup: ~55% faster than fully sequential execution
Max Concurrent: 4
```

### Dependency Matrix

| Task | Depends On | Blocks | Notes |
|------|------------|--------|-------|
| 1 | — | 2-15 | Baseline capture first |
| 2 | 1 | 3-4 | Documents failure policy |
| 3 | 2 | 5-15 | Must stabilize blockers before structural refactor |
| 4 | 2 | 5-15 | Safety tests can run alongside T3 where independent |
| 5 | 3,4 | 6-8 | CLI utility extraction |
| 6 | 5 | 8 | CLI auth/account split |
| 7 | 5 | 8 | CLI usage/config/manage split |
| 8 | 6,7 | 9-15 | Thin CLI entry and type cleanup |
| 9 | 3,4,8 | 13-15 | index.ts extraction |
| 10 | 3,4,8 | 13-15 | accounts.ts decomposition |
| 11 | 3,4,8 | 13-15 | router decomposition |
| 12 | 9-11 | 13-15 | Boundary typing cleanup in touched paths only |
| 13 | 9-12 | 14-15, F1-F4 | Regression net |
| 14 | 9-13 | F1-F4 | Duplication/dead seams after extraction |
| 15 | 13-14 | F1-F4 | Docs only if needed |
| F1-F4 | 13-15 | — | Final evidence-backed review |

### Agent Dispatch Summary

- **Wave 1**: 4 tasks — `quick`, `unspecified-high`, `deep`, `unspecified-high`
- **Wave 2**: 4 tasks — `quick`, `deep`, `deep`, `unspecified-high`
- **Wave 3**: 4 tasks — `deep`, `deep`, `unspecified-high`, `quick`
- **Wave 4**: 3 tasks — `unspecified-high`, `quick`, `writing`
- **FINAL**: 4 tasks — `oracle`, `unspecified-high`, `unspecified-high`, `deep`

---

## TODOs

- [x] 1. Capture baseline diagnostics, tests, lint, and build state

  **What to do**:
  - Run `npm test`
  - Run `npx tsc --noEmit`
  - Run `npm run lint`
  - Run `npm run build`
  - Save exact pass/fail output as baseline evidence

  **Must NOT do**:
  - Do NOT start refactoring during baseline capture
  - Do NOT normalize away pre-existing failures

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: pure verification and evidence capture
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `testing`: not needed for raw baseline capture

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 2-15
  - **Blocked By**: None

  **References**:
  - `package.json` — canonical build/test/lint commands
  - `tsconfig.json` — current type-checking baseline
  - `vitest.config.ts` — test file coverage pattern

  **Acceptance Criteria**:
  - [ ] Baseline outputs saved
  - [ ] Pre-existing failures clearly identified

  **QA Scenarios**:

  ```
  Scenario: Capture baseline command outputs
    Tool: Bash
    Preconditions: Clean working tree
    Steps:
      1. Run `npm test 2>&1`
      2. Run `npx tsc --noEmit 2>&1`
      3. Run `npm run lint 2>&1`
      4. Run `npm run build 2>&1`
    Expected Result: Full outputs captured with exit codes and failure counts
    Failure Indicators: Missing command output, truncated evidence, undocumented failing command
    Evidence: .sisyphus/evidence/task-1-baseline.txt

  Scenario: Verify build artifacts when build succeeds
    Tool: Bash
    Preconditions: `npm run build` exits 0
    Steps:
      1. List `dist/`
      2. Record produced artifacts
    Expected Result: Dist artifacts documented
    Failure Indicators: Build succeeds but no artifacts or unexpected output shape
    Evidence: .sisyphus/evidence/task-1-dist.txt
  ```

  **Commit**: NO

- [x] 2. Classify and document pre-existing failures

  **What to do**:
  - Categorize baseline failures into refactor-blocking vs non-blocking
  - Trace each failure to file/module owner
  - Define whether each failure must be fixed before hotspot refactoring

  **Must NOT do**:
  - Do NOT assume every baseline failure is a bug to “fix” immediately

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: requires cross-file reasoning over baseline failures
  - **Skills**: [`quality-standard`]
    - `quality-standard`: classify blocking quality issues precisely
  - **Skills Evaluated but Omitted**:
    - `testing`: useful later, but this task is triage first

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 3-15
  - **Blocked By**: Task 1

  **References**:
  - `src/backoff.test.ts` — current baseline diagnostics include type mismatch
  - `src/rotation.test.ts` — current baseline diagnostics include nullable and union issues
  - `src/circuit-breaker.test.ts` — current baseline diagnostics include discriminated-union misuse
  - `src/parent-pid-watcher.test.ts` — current baseline diagnostics include unused `@ts-expect-error`

  **Acceptance Criteria**:
  - [ ] Every baseline failure labeled blocking or non-blocking
  - [ ] Stabilization order documented

  **QA Scenarios**:

  ```
  Scenario: Failure triage document is evidence-backed
    Tool: Bash
    Preconditions: Baseline evidence exists
    Steps:
      1. Read baseline output
      2. Map each failure to a source file
      3. Produce a blocking/non-blocking classification note
    Expected Result: No baseline failure remains unclassified
    Failure Indicators: Vague “some tests fail” summary or missing file mapping
    Evidence: .sisyphus/evidence/task-2-failure-triage.md

  Scenario: Blocking set is minimal and justified
    Tool: Bash
    Preconditions: Triage complete
    Steps:
      1. Review each blocking classification
      2. Confirm it materially affects safe refactoring of hotspots
    Expected Result: Only true refactor blockers are marked blocking
    Failure Indicators: Over-broad blocker list or missing rationale
    Evidence: .sisyphus/evidence/task-2-blockers.md
  ```

  **Commit**: NO

- [x] 3. Fix or isolate refactor-blocking test/type issues

  **What to do**:
  - Resolve only the baseline failures that would make safe refactoring or verification unreliable
  - Prefer minimal fixes that preserve existing intended behavior
  - If a failure should remain, isolate and document it explicitly

  **Must NOT do**:
  - Do NOT use this as a license for a broad test cleanup
  - Do NOT delete tests to get green output

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: requires careful behavior-preserving fixes across baseline failures
  - **Skills**: [`quality-standard`, `testing`]
    - `quality-standard`: preserve correctness and avoid bad quick fixes
    - `testing`: maintain test discipline while repairing baseline blockers
  - **Skills Evaluated but Omitted**:
    - `refactor`: later structural work, not baseline stabilization

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 4 if independent)
  - **Blocks**: Tasks 5-15
  - **Blocked By**: Task 2

  **References**:
  - `src/backoff.test.ts`
  - `src/rotation.test.ts`
  - `src/circuit-breaker.test.ts`
  - `src/parent-pid-watcher.test.ts`

  **Acceptance Criteria**:
  - [ ] Refactor-blocking failures fixed or explicitly isolated
  - [ ] No new failures introduced

  **QA Scenarios**:

  ```
  Scenario: Blocking failures no longer block safe refactor work
    Tool: Bash
    Preconditions: Candidate fixes applied
    Steps:
      1. Run `npx tsc --noEmit 2>&1`
      2. Run targeted failing tests with `vitest run <file>`
      3. Compare output against baseline triage
    Expected Result: Blocking failures are gone or explicitly quarantined
    Failure Indicators: New errors in unrelated files or unchanged blockers with no justification
    Evidence: .sisyphus/evidence/task-3-blocker-fixes.txt

  Scenario: No regression from blocker fixes
    Tool: Bash
    Preconditions: Blocking fixes complete
    Steps:
      1. Re-run `npm test 2>&1`
      2. Compare failure count against baseline
    Expected Result: Same or fewer failures than baseline
    Failure Indicators: Additional test failures beyond documented baseline
    Evidence: .sisyphus/evidence/task-3-regression-check.txt
  ```

  **Commit**: YES
  - Message: `fix(testing): stabilize refactor-blocking baseline failures`
  - Files: targeted baseline failure files only
  - Pre-commit: `npm test && npx tsc --noEmit`

- [x] 4. Add or expand safety tests around hotspot behavior

  **What to do**:
  - Add targeted characterization tests around CLI dispatch, plugin fetch orchestration, account persistence, and slash-command routing where coverage is currently indirect
  - Ensure hotspot refactors have regression nets before structural extraction

  **Must NOT do**:
  - Do NOT pursue blanket coverage growth across the whole repo

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: behavior-locking tests across multiple hotspots
  - **Skills**: [`testing`, `quality-standard`]
    - `testing`: create characterization/regression tests
    - `quality-standard`: keep tests behavioral, deterministic, and scoped
  - **Skills Evaluated but Omitted**:
    - `writing`: not documentation work

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 3 where file overlap permits)
  - **Blocks**: Tasks 5-15
  - **Blocked By**: Task 2

  **References**:
  - `src/__tests__/index.parallel.test.ts` — regression style for orchestrated plugin behavior
  - `src/__tests__/fingerprint-regression.test.ts` — example of strong behavior lock-in
  - `vitest.config.ts` — where new tests must be discoverable

  **Acceptance Criteria**:
  - [ ] Each hotspot has direct safety coverage before decomposition
  - [ ] New tests fail if extraction changes behavior

  **QA Scenarios**:

  ```
  Scenario: Hotspot safety tests are active
    Tool: Bash
    Preconditions: New or expanded tests added
    Steps:
      1. Run targeted vitest files for cli/index/accounts/router coverage
      2. Confirm tests are discovered and pass
    Expected Result: Direct hotspot regression tests execute successfully
    Failure Indicators: Tests not discovered, flaky, or only assert implementation details
    Evidence: .sisyphus/evidence/task-4-safety-tests.txt

  Scenario: Characterization tests protect current behavior
    Tool: Bash
    Preconditions: Tests written
    Steps:
      1. Read test assertions
      2. Verify they target observable outputs/contracts
    Expected Result: Tests lock behavior, not internals
    Failure Indicators: Assertions on private structure or refactor-specific internals
    Evidence: .sisyphus/evidence/task-4-test-review.txt
  ```

  **Commit**: YES
  - Message: `test: add hotspot characterization coverage before refactor`
  - Files: targeted hotspot test files
  - Pre-commit: `npm test`

- [x] 5. Extract CLI formatting and rendering utilities from `src/cli.ts`

  **What to do**:
  - Move ANSI/color helpers, duration/time formatting, padding/render-bar helpers into focused CLI support modules
  - Leave behavior and command signatures unchanged

  **Must NOT do**:
  - Do NOT mix command-handler extraction into this step

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: mechanical extraction with low behavior risk
  - **Skills**: [`quality-standard`]
    - `quality-standard`: preserve single-responsibility boundaries
  - **Skills Evaluated but Omitted**:
    - `testing`: already handled by surrounding tasks

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Tasks 6-8
  - **Blocked By**: Tasks 3-4

  **References**:
  - `src/cli.ts` — current mixed formatting/rendering helpers near file top
  - `src/commands/router.ts:60-63` — existing `stripAnsi` implementation to avoid duplication

  **Acceptance Criteria**:
  - [ ] `src/cli.ts` shrinks meaningfully
  - [ ] Formatting behavior remains unchanged

  **QA Scenarios**:

  ```
  Scenario: CLI output formatting preserved after extraction
    Tool: Bash
    Preconditions: Utility extraction complete
    Steps:
      1. Run representative CLI commands (help, status, list)
      2. Compare output shape to pre-refactor baseline
    Expected Result: Same visible formatting and content structure
    Failure Indicators: Broken alignment, lost color gating, changed labels, runtime import errors
    Evidence: .sisyphus/evidence/task-5-cli-formatting.txt

  Scenario: No duplicate ANSI helper remains
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Search for `stripAnsi` implementations across `src/`
      2. Verify duplicate logic is eliminated or intentionally centralized
    Expected Result: Single maintained implementation path
    Failure Indicators: Duplicate helper bodies remain in multiple files
    Evidence: .sisyphus/evidence/task-5-duplication.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): extract formatting and rendering helpers`
  - Files: `src/cli.ts` + new CLI support modules
  - Pre-commit: `npm test && npx tsc --noEmit`

- [x] 6. Extract CLI auth/account command handlers

  **What to do**:
  - Move auth/account-oriented command logic from `src/cli.ts` into focused modules
  - Preserve command names, behavior, and side effects

  **Must NOT do**:
  - Do NOT redesign command semantics

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: sizable extraction with behavior-sensitive command logic
  - **Skills**: [`quality-standard`, `testing`]
    - `quality-standard`: prevent new god-modules
    - `testing`: keep command behavior verified during extraction
  - **Skills Evaluated but Omitted**:
    - `writing`: not prose work

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 8
  - **Blocked By**: Task 5

  **References**:
  - `src/cli.ts` — auth/account command handlers and dispatch paths
  - `README.md` — documented CLI command surface that must remain stable

  **Acceptance Criteria**:
  - [ ] Auth/account commands still behave identically
  - [ ] CLI dispatch continues to route correctly

  **QA Scenarios**:

  ```
  Scenario: Auth/account commands still resolve and run
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Run representative commands such as help/status/list using the CLI entrypoint
      2. Verify command parsing and output are unchanged
    Expected Result: Commands execute with expected outputs and no import/runtime failures
    Failure Indicators: Unknown command behavior, argument parsing regressions, changed output contract
    Evidence: .sisyphus/evidence/task-6-cli-auth-account.txt

  Scenario: Public CLI surface unchanged
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Compare command names/options against README-documented surface
    Expected Result: No removed or renamed public commands
    Failure Indicators: README drift or missing command paths
    Evidence: .sisyphus/evidence/task-6-surface-check.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): extract auth and account command handlers`
  - Files: `src/cli.ts` + new CLI command modules
  - Pre-commit: `npm test && npx tsc --noEmit`

- [x] 7. Extract CLI usage/config/manage command handlers

  **What to do**:
  - Move usage/config/manage flows from `src/cli.ts` into dedicated modules
  - Preserve interactive behavior and outputs

  **Must NOT do**:
  - Do NOT change prompt wording or command UX unless required to preserve behavior

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: interactive and stateful command extraction
  - **Skills**: [`quality-standard`, `testing`]
    - `quality-standard`: maintain clean boundaries
    - `testing`: keep behavior stable under extraction
  - **Skills Evaluated but Omitted**:
    - `writing`: not a copy-editing task

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 8
  - **Blocked By**: Task 5

  **References**:
  - `src/cli.ts` — usage/config/manage handler logic
  - `src/commands/router.ts` — reference for thinner command dispatch style

  **Acceptance Criteria**:
  - [ ] Manage/config/usage flows work as before
  - [ ] `src/cli.ts` is reduced to orchestration rather than implementation

  **QA Scenarios**:

  ```
  Scenario: Usage/config commands preserve output contracts
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Run representative usage/config commands
      2. Verify output structure and command completion
    Expected Result: Same observable behavior as before extraction
    Failure Indicators: Missing command output, changed labels, broken parsing
    Evidence: .sisyphus/evidence/task-7-cli-usage-config.txt

  Scenario: Interactive manage flow remains intact
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Invoke manage/help path non-destructively
      2. Verify command reaches the expected prompt/help behavior
    Expected Result: Manage flow still initializes correctly
    Failure Indicators: Runtime failures or detached prompt behavior
    Evidence: .sisyphus/evidence/task-7-manage-flow.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): extract usage config and manage handlers`
  - Files: `src/cli.ts` + new CLI command modules
  - Pre-commit: `npm test && npx tsc --noEmit`

- [x] 8. Thin CLI dispatch and remove avoidable account `any` usage

  **What to do**:
  - Reduce `src/cli.ts` to a thin entrypoint/dispatcher
  - Replace avoidable `Record<string, any>` account shapes with stronger types where practical in touched CLI code

  **Must NOT do**:
  - Do NOT force perfect typing across untouched boundaries

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: combines final cleanup with type-boundary tightening
  - **Skills**: [`quality-standard`]
    - `quality-standard`: maintain safe, explicit boundaries
  - **Skills Evaluated but Omitted**:
    - `testing`: surrounding command tests already cover behavior

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: Tasks 9-15
  - **Blocked By**: Tasks 6-7

  **References**:
  - `src/accounts.ts` — `ManagedAccount` and related account types
  - `src/cli.ts` — current `Record<string, any>` seams

  **Acceptance Criteria**:
  - [ ] `src/cli.ts` is materially smaller and mostly orchestration
  - [ ] Avoidable account-shape `any` usage in touched CLI paths is reduced

  **QA Scenarios**:

  ```
  Scenario: CLI entrypoint remains functional after thinning
    Tool: Bash
    Preconditions: Thinning complete
    Steps:
      1. Run representative CLI entry commands
      2. Run `npx tsc --noEmit`
    Expected Result: Commands still work and touched CLI typings are accepted
    Failure Indicators: Entry wiring failures or new type errors in CLI modules
    Evidence: .sisyphus/evidence/task-8-cli-thin.txt

  Scenario: Avoidable account any-usage reduced in touched code
    Tool: Bash
    Preconditions: Typing cleanup complete
    Steps:
      1. Search for `Record<string, any>` and `as any` in touched CLI files
    Expected Result: Count is reduced where stronger domain types exist
    Failure Indicators: No reduction despite direct opportunities in touched CLI code
    Evidence: .sisyphus/evidence/task-8-type-cleanup.txt
  ```

  **Commit**: YES
  - Message: `refactor(cli): thin entrypoint and strengthen touched account typing`
  - Files: `src/cli.ts` + extracted CLI modules
  - Pre-commit: `npm test && npx tsc --noEmit`

- [x] 9. Extract `src/index.ts` request-attempt and orchestration helpers

  **What to do**:
  - Break the oversized fetch/orchestration path into focused helper functions/modules
  - Preserve closure-based state and existing behavior

  **Must NOT do**:
  - Do NOT redesign plugin state ownership
  - Do NOT change exported plugin hook behavior

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: most behavior-sensitive runtime extraction in the repo
  - **Skills**: [`quality-standard`, `testing`]
    - `quality-standard`: preserve single responsibility and safe boundaries
    - `testing`: protect hot-path behavior under extraction
  - **Skills Evaluated but Omitted**:
    - `architecture`: this is surgical extraction, not architecture redesign

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10-11 where file overlap is absent)
  - **Blocks**: Tasks 12-15
  - **Blocked By**: Task 8 and baseline stabilization

  **References**:
  - `src/index.ts` — current plugin factory and large fetch path
  - `src/plugin-helpers.ts`, `src/refresh-helpers.ts` — existing extraction style already used in repo
  - `src/__tests__/index.parallel.test.ts` — important regression protection for plugin behavior

  **Acceptance Criteria**:
  - [ ] `src/index.ts` is materially smaller
  - [ ] Runtime behavior is preserved under existing regression tests

  **QA Scenarios**:

  ```
  Scenario: Plugin orchestration behavior preserved
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Run targeted plugin runtime tests including parallel/index-focused suites
      2. Run `npm run build`
    Expected Result: Existing plugin behavior tests still pass and build succeeds
    Failure Indicators: Runtime regression in request transformation, retry, or account handling paths
    Evidence: .sisyphus/evidence/task-9-index-runtime.txt

  Scenario: Closure-based state preserved
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Review touched helper signatures and call sites
      2. Verify state remains closure-owned, not moved into new singleton/class state
    Expected Result: Extraction is structural, not architectural
    Failure Indicators: New state owner objects or behavior-changing indirection introduced
    Evidence: .sisyphus/evidence/task-9-state-review.txt
  ```

  **Commit**: YES
  - Message: `refactor(plugin): extract index orchestration helpers`
  - Files: `src/index.ts` + new/existing helper modules
  - Pre-commit: `npm test && npm run build`

- [x] 10. Extract account persistence and reconciliation helpers from `src/accounts.ts`

  **What to do**:
  - Separate save/load/reconciliation logic into focused helpers while preserving `AccountManager` behavior
  - Keep matching/merge logic explicit and test-backed

  **Must NOT do**:
  - Do NOT redesign account selection semantics

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: stateful domain logic with persistence concerns
  - **Skills**: [`quality-standard`, `testing`]
    - `quality-standard`: preserve responsibility boundaries and avoid accidental semantic changes
    - `testing`: account-state behavior must remain locked down
  - **Skills Evaluated but Omitted**:
    - `database`: file-based storage only; not a DB schema task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: Tasks 12-15
  - **Blocked By**: Task 8 and baseline stabilization

  **References**:
  - `src/accounts.ts` — `AccountManager`, save/load/reconciliation logic
  - `src/storage.ts` — existing persistence model/types
  - `src/accounts.test.ts`, `src/account-state.test.ts`, `src/accounts.dedup.test.ts` — important behavior coverage

  **Acceptance Criteria**:
  - [ ] Persistence/reconciliation concerns are structurally separated
  - [ ] Account behavior remains unchanged under current tests

  **QA Scenarios**:

  ```
  Scenario: Account persistence behavior preserved
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Run account-related test suites
      2. Review touched persistence helper boundaries
    Expected Result: Save/load/reconciliation behavior remains stable
    Failure Indicators: Account dedup, identity matching, or active-index regressions
    Evidence: .sisyphus/evidence/task-10-account-tests.txt

  Scenario: No semantic drift in reconciliation logic
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Compare old/new responsibility split
      2. Verify matching precedence and merge semantics are unchanged
    Expected Result: Refactor is structural only
    Failure Indicators: Changed matching order or persistence semantics
    Evidence: .sisyphus/evidence/task-10-reconciliation-review.txt
  ```

  **Commit**: YES
  - Message: `refactor(accounts): separate persistence and reconciliation helpers`
  - Files: `src/accounts.ts` + helper modules
  - Pre-commit: `npm test && npx tsc --noEmit`

- [x] 11. Reduce `src/commands/router.ts` to routing plus thin coordination

  **What to do**:
  - Extract inline Files API or command-specific business logic into focused helper modules
  - Keep router centered on parse/dispatch/response flow

  **Must NOT do**:
  - Do NOT change slash-command surface

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: router thinning plus helper extraction
  - **Skills**: [`quality-standard`, `testing`]
    - `quality-standard`: keep routing thin and explicit
    - `testing`: protect slash-command behavior and output
  - **Skills Evaluated but Omitted**:
    - `writing`: not a docs-first task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: Tasks 12-15
  - **Blocked By**: Task 8 and baseline stabilization

  **References**:
  - `src/commands/router.ts` — current mixed routing/business logic
  - `src/commands/oauth-flow.ts` — example of moving command behavior into a focused module

  **Acceptance Criteria**:
  - [ ] Router is materially thinner
  - [ ] Slash-command behavior remains unchanged

  **QA Scenarios**:

  ```
  Scenario: Slash command behavior preserved after router thinning
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Run representative slash-command-related tests
      2. Verify router output/messages remain consistent
    Expected Result: Same routing semantics and command handling
    Failure Indicators: Changed parsing, broken files/account flows, or message drift
    Evidence: .sisyphus/evidence/task-11-router-tests.txt

  Scenario: Router no longer owns extracted business logic
    Tool: Bash
    Preconditions: Extraction complete
    Steps:
      1. Review router file structure
      2. Confirm helper modules own command-specific work
    Expected Result: Router is primarily coordination/dispatch
    Failure Indicators: Large inline business-logic blocks remain in router
    Evidence: .sisyphus/evidence/task-11-router-review.txt
  ```

  **Commit**: YES
  - Message: `refactor(commands): move router business logic into helpers`
  - Files: `src/commands/router.ts` + helper modules
  - Pre-commit: `npm test && npx tsc --noEmit`

- [x] 12. Remove avoidable boundary type escapes in touched paths

  **What to do**:
  - Reduce avoidable `Record<string, any>` and `as any` usage in files touched by the hotspot refactor
  - Preserve justified boundary suppressions where the external API is truly opaque

  **Must NOT do**:
  - Do NOT attempt repo-wide elimination of every `any`

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: scoped type cleanup after structural extraction
  - **Skills**: [`quality-standard`]
    - `quality-standard`: maintain explicit safe boundaries
  - **Skills Evaluated but Omitted**:
    - `testing`: type cleanup is verified via diagnostics and touched tests

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 tail
  - **Blocks**: Tasks 13-15
  - **Blocked By**: Tasks 9-11

  **References**:
  - `src/index.ts` — current plugin API-boundary suppressions
  - `src/cli.ts` — current account/usage shape looseness
  - `src/plugin-helpers.ts`, `src/refresh-helpers.ts` — current forward-compatible config/client seams

  **Acceptance Criteria**:
  - [ ] Avoidable escapes reduced in touched files
  - [ ] No new type errors introduced

  **QA Scenarios**:

  ```
  Scenario: Touched-path type cleanup is real and safe
    Tool: Bash
    Preconditions: Type cleanup complete
    Steps:
      1. Search touched files for `Record<string, any>` and `as any`
      2. Run `npx tsc --noEmit`
    Expected Result: Reduced avoidable escapes with no new type errors
    Failure Indicators: No actual reduction or diagnostic regressions
    Evidence: .sisyphus/evidence/task-12-type-report.txt

  Scenario: Justified boundary suppressions remain documented
    Tool: Bash
    Preconditions: Cleanup complete
    Steps:
      1. Review remaining suppressions in touched files
      2. Verify each has a clear API-boundary rationale
    Expected Result: Remaining escapes are intentional and documented
    Failure Indicators: Undocumented or arbitrary residual `any` usage
    Evidence: .sisyphus/evidence/task-12-suppression-review.txt
  ```

  **Commit**: YES
  - Message: `refactor(types): reduce avoidable boundary any-usage in touched paths`
  - Files: touched hotspot files only
  - Pre-commit: `npx tsc --noEmit && npm test`

- [ ] 13. Add or expand tests for extracted modules and changed behavior

  **What to do**:
  - Add direct tests for newly extracted helper modules where coverage was previously indirect
  - Expand regression tests for hotspot behavior affected by decomposition

  **Must NOT do**:
  - Do NOT write tests that mirror implementation details

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: multi-module regression and unit test additions
  - **Skills**: [`testing`, `quality-standard`]
    - `testing`: behavior-first test additions
    - `quality-standard`: keep tests deterministic and maintainable
  - **Skills Evaluated but Omitted**:
    - `writing`: not docs work

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4
  - **Blocks**: Tasks 14-15 and final verification
  - **Blocked By**: Task 12

  **References**:
  - `vitest.config.ts` — test inclusion rules
  - existing hotspot-related tests in `src/` and `src/__tests__/`

  **Acceptance Criteria**:
  - [ ] Newly extracted modules have direct test coverage where needed
  - [ ] Regression net for hotspot behavior is stronger than baseline

  **QA Scenarios**:

  ```
  Scenario: Extracted-module tests are active and green
    Tool: Bash
    Preconditions: Test additions complete
    Steps:
      1. Run targeted vitest suites for new/extracted modules
      2. Run full `npm test`
    Expected Result: New tests run and pass; full suite shows no regression beyond documented baseline policy
    Failure Indicators: New tests not discovered, flaky, or causing unrelated regressions
    Evidence: .sisyphus/evidence/task-13-test-suite.txt

  Scenario: Test intent remains behavioral
    Tool: Bash
    Preconditions: Tests added
    Steps:
      1. Review test assertions for extracted modules
    Expected Result: Assertions target outputs/contracts, not implementation internals
    Failure Indicators: Tests tightly coupled to refactor structure
    Evidence: .sisyphus/evidence/task-13-test-review.txt
  ```

  **Commit**: YES
  - Message: `test: expand regression coverage for extracted hotspot modules`
  - Files: touched test files
  - Pre-commit: `npm test`

- [x] 14. Clean up duplication and dead seams exposed by the hotspot refactor

  **What to do**:
  - Remove duplicate helpers and dead transitional seams uncovered by extraction
  - Focus only on duplication directly exposed by the hotspot work

  **Must NOT do**:
  - Do NOT launch a whole-repo dead-code purge

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: cleanup pass after structural changes are settled
  - **Skills**: [`quality-standard`]
    - `quality-standard`: remove debt without changing behavior
  - **Skills Evaluated but Omitted**:
    - `testing`: already handled by surrounding verification

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Task 15)
  - **Blocks**: Final verification
  - **Blocked By**: Task 13

  **References**:
  - `src/cli.ts` and `src/commands/router.ts` — duplicated `stripAnsi` area noted in review
  - other touched hotspot files after extraction

  **Acceptance Criteria**:
  - [ ] Duplication directly exposed by the refactor is removed
  - [ ] No orphaned dead seams remain in touched modules

  **QA Scenarios**:

  ```
  Scenario: Duplicate helper logic reduced in touched modules
    Tool: Bash
    Preconditions: Cleanup complete
    Steps:
      1. Search for known duplicate helper signatures in touched areas
      2. Verify one canonical implementation remains
    Expected Result: No unnecessary duplicate helper bodies remain
    Failure Indicators: Multiple active copies of the same helper logic in touched code
    Evidence: .sisyphus/evidence/task-14-duplication.txt

  Scenario: No dead seams remain after extraction
    Tool: Bash
    Preconditions: Cleanup complete
    Steps:
      1. Search touched modules for unused transitional wrappers/imports
      2. Run lint and type-check
    Expected Result: Touched modules are free of obvious dead seams
    Failure Indicators: Unused imports, stale wrappers, or disconnected helper code
    Evidence: .sisyphus/evidence/task-14-dead-seams.txt
  ```

  **Commit**: YES
  - Message: `refactor: remove duplication and dead seams from hotspot cleanup`
  - Files: touched hotspot modules only
  - Pre-commit: `npm run lint && npx tsc --noEmit`

- [x] 15. Update documentation only for externally visible refactor-impacting details

  **What to do**:
  - If command behavior, verification workflow, or maintainers’ expectations changed in an externally visible way, update README/related docs minimally
  - Otherwise leave docs untouched

  **Must NOT do**:
  - Do NOT rewrite README just because code moved internally

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: this is prose/documentation work if needed at all
  - **Skills**: [`writing`]
    - `writing`: keep docs concise and non-sloppy
  - **Skills Evaluated but Omitted**:
    - `quality-standard`: docs quality is handled by writing skill here

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: Final verification
  - **Blocked By**: Task 13

  **References**:
  - `README.md` — public CLI/plugin documentation surface
  - `AGENTS.md` — repo-specific contributor constraints, if affected

  **Acceptance Criteria**:
  - [ ] Docs updated only if external behavior/expectations changed
  - [ ] No documentation drift for touched public surfaces

  **QA Scenarios**:

  ```
  Scenario: Documentation changes are necessary and accurate
    Tool: Bash
    Preconditions: Candidate doc updates prepared
    Steps:
      1. Compare touched public behavior against README/AGENTS.md
      2. Confirm each doc edit maps to a real externally visible change
    Expected Result: Only necessary docs are touched, and they are accurate
    Failure Indicators: Cosmetic or speculative doc churn with no behavior change
    Evidence: .sisyphus/evidence/task-15-doc-review.txt

  Scenario: Public command/docs remain aligned
    Tool: Bash
    Preconditions: Doc updates complete
    Steps:
      1. Run representative commands/help output
      2. Compare to documented surface
    Expected Result: Docs and actual behavior align
    Failure Indicators: Documentation drift
    Evidence: .sisyphus/evidence/task-15-doc-sync.txt
  ```

  **Commit**: YES
  - Message: `docs: align documentation with hotspot refactor outcomes`
  - Files: docs only if needed
  - Pre-commit: manual doc/CLI alignment review

---

## Final Verification Wave

- [x] F1. **Plan Compliance Audit** — `oracle` ✅ APPROVE
  Verify that baseline stabilization happened first, hotspot ordering was respected, and all required deliverables exist. Confirm out-of-scope boundaries were honored.

  **QA Scenario**:

  ```
  Scenario: Plan deliverables and ordering are satisfied
    Tool: Bash
    Preconditions: All implementation tasks are marked complete and evidence files exist
    Steps:
      1. Read `.sisyphus/plans/quality-refactor.md`
      2. Read the final change summary / diff map for implemented files
      3. Verify baseline-capture evidence exists before hotspot-refactor evidence
      4. Verify each planned deliverable has a corresponding changed file or verification artifact
      5. Verify no out-of-scope category (feature work, API redesign, config migration) appears in the diff summary
    Expected Result: Every deliverable is accounted for and execution order matches the plan
    Failure Indicators: Missing deliverables, missing evidence, or out-of-scope work present
    Evidence: .sisyphus/evidence/final-f1-plan-compliance.txt
  ```

- [x] F2. **Code Quality Review** — `unspecified-high` ✅ APPROVE
  Run build, type-check, lint, and tests. Review changed files for residual god-functions, accidental complexity, undocumented `any`, silent error swallowing, duplication, and dead seams.

  **QA Scenario**:

  ```
  Scenario: Quality gates pass on final refactor result
    Tool: Bash
    Preconditions: Final implementation state ready for review
    Steps:
      1. Run `npm test 2>&1`
      2. Run `npx tsc --noEmit 2>&1`
      3. Run `npm run lint 2>&1`
      4. Run `npm run build 2>&1`
      5. Search changed hotspot files for residual `as any`, `Record<string, any>`, silent catches, duplicate helper seams, and oversized residual god-functions
    Expected Result: Same or fewer failures than baseline, no new quality regressions in changed files
    Failure Indicators: New diagnostics, failing build, or unresolved quality smells in touched hotspots
    Evidence: .sisyphus/evidence/final-f2-quality-review.txt
  ```

- [x] F3. **Real Manual QA** — `unspecified-high` ✅ APPROVE
  Execute representative CLI commands and behavior-critical plugin tests. Confirm actual outputs, not just static diagnostics.

  **QA Scenario**:

  ```
  Scenario: Real user-facing behavior still works
    Tool: Bash
    Preconditions: Build artifacts and tests are available
    Steps:
      1. Run representative CLI commands such as help/status/list using the real CLI entrypoint
      2. Run the most behavior-critical plugin-focused regression tests for index/accounts/router paths
      3. Capture actual command outputs and test outputs
      4. Compare outputs against expected documented command surface and baseline behavior notes
    Expected Result: Real CLI outputs and critical plugin behavior remain intact after refactor
    Failure Indicators: Broken commands, changed visible behavior, or critical regression test failures
    Evidence: .sisyphus/evidence/final-f3-manual-qa.txt
  ```

- [x] F4. **Scope Fidelity Check** — `deep` ✅ APPROVE
  Confirm work stayed within the requested refactor scope: no feature additions, no API redesign, no broad unrelated cleanup.

  **QA Scenario**:

  ```
  Scenario: Work stayed inside the requested refactor scope
    Tool: Bash
    Preconditions: Final diff summary available
    Steps:
      1. Review changed files and commit summaries
      2. Compare all changes against the plan's Must NOT Have and Out of Scope sections
      3. Flag any feature additions, public API redesign, config-schema changes, or unrelated cleanup outside hotspot work
    Expected Result: All changes map directly to planned hotspot refactor work and stabilization tasks
    Failure Indicators: New features, scope expansion, or unrelated repo-wide cleanup appears in the final diff
    Evidence: .sisyphus/evidence/final-f4-scope-fidelity.txt
  ```

---

## Commit Strategy

- Stabilization commits separate from structural refactor commits
- Prefer one commit per hotspot sub-phase:
  - baseline blocker fixes
  - CLI extraction series
  - index extraction
  - accounts extraction
  - router extraction
  - regression tests
  - cleanup/docs if needed

---

## Success Criteria

### Verification Commands

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

### Final Checklist

- [ ] Baseline issues documented before refactor work
- [ ] Hotspots refactored in planned order
- [ ] No unintended public behavior changes
- [ ] Same or fewer test/type/lint failures than baseline
- [ ] Manual QA evidence captured for touched behaviors
