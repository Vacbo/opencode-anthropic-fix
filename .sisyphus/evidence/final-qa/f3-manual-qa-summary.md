# F3 Manual QA Summary

**Sandbox:** `/tmp/f3-sandbox-1775879429` (git worktree @ HEAD 1b4afe8)
**Runtime:** bun available; node 20 fallback wired
**Date:** 2026-04-11

## Phase Results

Phase 1 Evidence: 23/42 present (19 missing: T21, T22, T23, T24, T25, T26, T27, T28, T29, T30, T31, T32, T33, T34, T35, T36, T37, T38, T39)
Phase 2 Sandbox: OK (worktree add clean; npm install 185 pkgs; npm run build OK; dist/bun-proxy.mjs built via esbuild side-build per qa-parallel convention)
Phase 3 qa-parallel: 3/3 PASS

- Run 1: PASS | requests=50 | orphans=0 | connect_errors=0 | parent_death_ok=Y
- Run 2: PASS | requests=50 | orphans=0 | connect_errors=0 | parent_death_ok=Y
- Run 3: PASS | requests=50 | orphans=0 | connect_errors=0 | parent_death_ok=Y
  Phase 4 N=50: 50 message_stop / 0 connect_errors / 0 orphans / 0 non-200
  Phase 5 Rotation: ACCOUNT_COUNT=2
  Phase 6 Sandbox: cleaned (git worktree list confirms main worktree only)
  Phase 7 Main Source: CLEAN (git status --porcelain -- src/ index.test.ts cli.test.ts empty)
- ps aux bun-proxy: only user's pre-existing cached plugin process (PID 4423, unrelated to F3 sandbox)

## VERDICT: CONDITIONAL APPROVE

**Runtime behavior: GREEN**

- qa-parallel.sh fully stable across 3 runs (parent-death verification, orphan sweep, connect-error sweep all clean)
- Independent N=50 curl fan-out via standalone mock-upstream + bun-proxy: 50/50 message_stop, 0 connect errors, 0 orphan tool_use events
- Rotation dedup: 10 iterations × 2 accounts yields ACCOUNT_COUNT=2 (no spurious duplicates under repeated OAuth refresh)
- Source tree CLEAN: no mutations to src/, index.test.ts, or cli.test.ts
- Sandbox lifecycle CLEAN: worktree removed, no leaked bun-proxy or mock-upstream processes from F3 runs

**Evidence audit: GAP**

- Phase 1 audit shows 19 missing task-N-\*.txt files (T21–T39). This is the only blocking concern.
- Evidence exists for T0–T20, T40, T41, plus wave-6-final-regression.md and task-7-wave1-checkpoint.txt.
- Plan shows T20 and T21 were declared an "atomic pair" in Wave 3 (one commit), which may explain T21 folding into T20 evidence but does not explain T22–T39.
- Runtime verification (Phases 3–5) exercises the code that T21–T39 implemented and finds it behaviorally sound, so the gap is a documentation/bookkeeping issue rather than a runtime regression.

**Recommendation:**

- Approve for runtime correctness based on Phases 2–7 results.
- Orchestrator must reconcile the Phase 1 evidence gap (either locate misnamed artifacts for T21–T39 or regenerate missing evidence from wave checkpoints) before closing out the overall plan.
- Do NOT gate F3 deliverables on runtime behavior; DO gate final plan closure on evidence reconciliation.

## Artifacts

- `.sisyphus/evidence/final-qa/f3-phase1-audit.txt` — raw missing-task list
- `.sisyphus/evidence/final-qa/f3-phase2-worktree.txt` — worktree creation
- `.sisyphus/evidence/final-qa/f3-phase2-install.txt` — npm install log
- `.sisyphus/evidence/final-qa/f3-phase2-build.txt` — build + bun-proxy esbuild log
- `.sisyphus/evidence/final-qa/f3-phase3-qa-parallel-run-{1,2,3}.txt` — stability runs
- `.sisyphus/evidence/final-qa/f3-phase4-n50-fanout.txt` — independent fan-out result
- `.sisyphus/evidence/final-qa/f3-phase5-rotation.txt` — rotation dedup result
- `.sisyphus/evidence/final-qa/f3-phase6-cleanup.txt` — worktree removal
- `.sisyphus/evidence/final-qa/f3-phase7-verify.txt` — ps + git status verification
