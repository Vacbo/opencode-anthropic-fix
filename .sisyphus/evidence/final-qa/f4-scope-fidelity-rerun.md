Tasks [RECHECKED] | Baseline Changed Files [179] | Implementation Commits Seen [37/41 expected before F*] | Metis Tripwires [CLEAN] | VERDICT: REJECT

## Inputs reviewed

- Plan scope: `.sisyphus/plans/parallel-and-auth-fix.md` (especially F4 scope-fidelity instructions and Metis tripwires)
- Previous F4 review: `.sisyphus/evidence/final-qa/f4-scope-fidelity.md`
- Git status and `git diff --name-only c4b557db7c525f70f2494cd6b0e1ab76376b4e28...HEAD`
- F3 evidence commit: `ba7dd9b2de5a380493dad17f7718142c1e4a98d8`

## Verdict

**REJECT**

The previous rejection does not clear on rerun. The branch still contains broad scope drift, and the newer F3 evidence commit is itself out of scope relative to the plan's declared F3 evidence filenames. Metis tripwires remain clean, but scope fidelity does not.

## What still fails

### 1. Prior scope violations are still present in the current baseline→HEAD diff

The earlier F4 review rejected for **103 unaccounted files** and **50 unexpected overlaps**. Those violation classes still exist in the current diff. Representative files still outside plan scope include:

- Repo/meta artifacts never listed by this plan:
  - `.mcp.json`
  - `.sisyphus/boulder.json`
  - `src.zip`
  - `vacbo-opencode-anthropic-fix-0.0.43.tgz`
  - `vacbo-opencode-anthropic-fix-0.0.44.tgz`
- Cross-plan contamination:
  - `.sisyphus/plans/membership-fix-cli-revamp.md`
  - `.sisyphus/plans/quality-refactor.md`
  - `.sisyphus/notepads/membership-fix-cli-revamp/learnings.md`
  - `.sisyphus/notepads/quality-refactor/decisions.md`
  - `.sisyphus/notepads/quality-refactor/issues.md`
  - `.sisyphus/notepads/quality-refactor/learnings.md`
  - `.sisyphus/notepads/quality-refactor/problems.md`
- Sacred/audited plan drift:
  - `.sisyphus/plans/parallel-and-auth-fix.md`
- Unplanned test/file additions not claimed by the plan:
  - `src/cli.test.ts`
  - `src/__tests__/fingerprint-regression.test.ts`

Those are enough on their own to keep F4 in **REJECT**.

### 2. The new F3 evidence commit is not plan-compliant

The plan allows F3 to add evidence under `.sisyphus/evidence/final-qa/`, but it names specific outputs. The committed F3 files do not match that declared set.

Committed by `ba7dd9b2de5a380493dad17f7718142c1e4a98d8`:

- `f3-manual-qa-summary.md`
- `f3-phase1-audit.txt`
- `f3-phase2-build.txt`
- `f3-phase2-install.txt`
- `f3-phase2-worktree.txt`
- `f3-phase3-qa-parallel-run-{1,2,3}.txt`
- `f3-phase4-n50-fanout.txt`
- `f3-phase5-rotation.txt`
- `f3-phase6-cleanup.txt`
- `f3-phase7-verify.txt`

But the plan's F3 evidence block expects named artifacts like:

- `qa-parallel-run-{1,2,3}.txt`
- `n50-parallel.txt`
- `10-rotation.txt`
- `f3-residual.txt`
- `f3-main-source-clean.txt` / `f3-main-clean.txt`

So the rerun adds a **new scope mismatch** rather than resolving the old one.

### 3. Commit structure is still off-plan

The plan expects **41 implementation commits** before F1-F4 evidence commits land, and **45 total** after the four final-QA evidence commits.

Current observed count from the baseline:

- `37` commits total from `c4b557db7c525f70f2494cd6b0e1ab76376b4e28..HEAD`

That count is inconsistent with the plan's one-task/one-commit mapping and lines up with the earlier finding that tasks were bundled together or otherwise not landing as declared.

### 4. Current worktree is dirty, so approval would be unsafe even without the historical violations

At rerun time the main worktree also has pending edits and untracked files, including:

- Modified tracked files:
  - `.sisyphus/plans/parallel-and-auth-fix.md`
  - `scripts/mock-upstream.js`
  - `scripts/rotation-test.js`
  - `src/bun-fetch.ts`
  - `src/response/streaming.ts`
- Additional final-QA drafts/rerun artifacts under `.sisyphus/evidence/final-qa/`

That means the audited state is not cleanly frozen.

## Metis tripwire check

Tripwires remain clean against `c4b557db7c525f70f2494cd6b0e1ab76376b4e28..HEAD`:

- `src/oauth.ts` — no diff
- `src/system-prompt/` — no diff
- `src/headers/` — no diff
- `src/request/url.ts` / `src/request/metadata.ts` — no diff
- `src/rotation.ts` — no diff
- `src/files*` — no diff
- `src/commands/` — no diff
- `src/models.ts` / `src/env.ts` — no diff

So this is **not** a tripwire failure. It is a **scope discipline** failure.

## Final finding

F4 remains **REJECT**.

Why:

1. Previously identified unaccounted files and unexpected overlaps still exist in the current branch diff.
2. The newer F3 evidence commit does not match the plan's declared F3 evidence filenames.
3. Commit count is still below the plan's required implementation-history shape.
4. The current worktree is dirty, including a direct modification to the sacred plan file.

Approval would require the branch to remove or justify the out-of-scope files, realign final-QA evidence names with the plan, restore the plan file to read-only status, and present a clean reviewable git state.
