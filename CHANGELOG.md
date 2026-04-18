# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-17

This release hardens wire-level parity with real Claude Code 2.1.113, introduces a dev sandbox for safe iteration, ports a per-model smoke harness from griffinmartin/opencode-claude-auth, and adds a structured logger with OAuth-token redaction. CHANGELOG entries for 0.1.5 through 0.1.9 were skipped; this version consolidates all changes since 0.1.4.

### Added

- **Dev sandbox** (`scripts/sandbox.ts`): isolated OpenCode tree under `.sandbox/` that runs a copied plugin bundle instead of the live symlink, so parse-time errors during iteration no longer kill live OpenCode sessions. Commands: `bun run sandbox:up|down|reinstall|run|status`. Full guide at [`docs/dev-sandbox.md`](docs/dev-sandbox.md).
- **Per-model smoke test** (`scripts/smoke/test-models.ts`): hits `/v1/messages` once per model with a minimal prompt, records failures in `manifests/smoke/failed-models.json`, and on re-run skips models that have never passed. Opt in to Opus with `--all` or `--model claude-opus-4-7`. Ported from griffinmartin/opencode-claude-auth with our canonical model list and no OpenCode-SDK dependency.
- **Structured JSON logger** (`src/logger.ts`): `debug`, `info`, `warn`, `error` levels with auto-redaction of bearer tokens (`sk-ant-oat01-...`) and common credential keys (`access`, `access_token`, `refresh`, `refreshToken`, `token`, `bearer`, `authorization`). Debug output is gated on the pre-existing `OPENCODE_ANTHROPIC_DEBUG` env var.
- **Candidate manifest ingestion for CC 2.1.109, 2.1.111, 2.1.112, and 2.1.113** under `manifests/candidate/claude-code/` with per-version notes in `docs/cc-versions/`.
- **Bun-native binary extraction** (`scripts/analysis/extract-cc-bundle.ts`): CC 2.1.113 ships as a Bun-compiled native binary instead of `cli.js`. The extractor now pulls strings/patterns from the native binary so drift checking and fingerprint extraction continue working. Template-literal fallbacks recover user-agent and billing templates when `cli.js` is unavailable.
- **Adaptive thinking wire shape** (`src/request/body.ts`): rewrote thinking body to match CC's native shape (`thinking: { type: "adaptive" }` + `output_config.effort`) with `xhigh`/`max` tiers for Opus 4.6+ and Sonnet 4.6+.
- **Context-aware identity selector** (`src/constants.ts::selectClaudeCodeIdentity`): mirrors CC 2.1.113's decompiled `zN_()` — emits the interactive identity on TTY, the Claude-Agent-SDK identity for non-interactive runs, and the Vertex identity for first-party Vertex. See `.sisyphus/evidence/phase-1-claim-validation/2026-04-17/` for the captures that proved the selector logic.
- **Phase 1 validation scenarios** (`scripts/verification/scenarios/*.json`) and `scripts/verification/run-live-verification.ts --prompt-file` / `--model` flags for running Proxyman-backed capture comparisons against the live API.
- **One-shot beta-order verifier** (`scripts/verification/check-beta-order.ts`): extracts `anthropic-beta` from two capture JSONs and asserts equality by content AND order. Exits 0 on match, 1 on mismatch with a side-by-side diff.
- **Proxyman HAR workflow** (`scripts/proxyman/`): canonical live-capture runner for Wave 1/2/3 reproducibility.
- **Capabilities snapshot tool** (`scripts/capabilities/snapshot.ts`): per-model `/v1/models/{id}` snapshot used to validate model-specific claims in `src/models.ts`.
- **`CLAUDE_CODE_ENTRYPOINT` default flipped to `sdk-cli`** (`src/headers/builder.ts`): matches real CC 2.1.113 emission for the non-interactive common case.
- **Progressive long-context retry** (`src/request/long-context-retry.ts`): mirrors CC's automatic beta exclusion on long-context 400/429.
- **Wire-visible tool-name rewriting** (`src/tools/wire-names.ts`): rewrites internal OpenCode tool names to Claude Code wire names so tool-use blocks look like CC emitted them.
- **Anthropic account/org UUIDs surfaced** through the full OAuth stack for metadata.user_id composition consistency.

### Changed

- **`anthropic-beta` emission order now matches CC 2.1.113 byte-for-byte** on Haiku 4.5 minimal-hi. The plugin previously emitted `claude-code-20250219` at position 0; CC emits it at position 4, between `prompt-caching-scope-2026-01-05` and `advisor-tool-2026-03-01`. See `.sisyphus/evidence/phase-1-claim-validation/2026-04-17/proxyman-minimal-hi-2.1.113/minimal-hi-og-capture.json:20` for the reference capture. Sonnet 4.6 and Opus 4.7 ordering validation is deferred because their Phase-1 captures have a separate beta-membership gap (`context-1m-2025-08-07`).
- **`src/betas.ts` `buildAnthropicBetaHeader()`** reorders signature-branch pushes so the final output matches CC's live emission. Two golden-order tests (`tests/unit/profiles/index.test.ts`, `tests/regression/fingerprint/fingerprint-regression.test.ts`) were updated to reflect the new authoritative order.
- **19 silent error-swallowing catch blocks** across `src/oauth.ts`, `src/storage.ts`, `src/backoff.ts`, `src/token-refresh.ts`, `src/request-orchestration-helpers.ts`, `src/accounts.ts`, `src/env.ts`, `src/refresh-lock.ts`, `src/response/streaming.ts`, and `src/response/mcp.ts` now emit `logger.debug()` calls. Runtime behavior is unchanged — each catch keeps its original "continue, don't throw" intent — but the errors are now observable under `OPENCODE_ANTHROPIC_DEBUG=1`. A new regression test (`tests/unit/no-empty-catches.test.ts`) prevents future silent swallows from landing.
- **Plugin bundle renamed** `dist/opencode-anthropic-auth-plugin.js` → `dist/opencode-anthropic-auth-plugin.mjs`.
- **Capture tooling migrated from shell + JavaScript to TypeScript** (`scripts/proxyman/`, `scripts/verification/`, `scripts/analysis/`).

### Fixed

- **Haiku 4.5 now receives `claude-code-20250219` and `advisor-tool-2026-03-01`** (`src/betas.ts`). Both were previously excluded by a `!haiku` guard; live CC 2.1.112 capture on 2026-04-17 proved CC sends them on Haiku too.
- **Identity string is context-aware** (`src/constants.ts`, `src/system-prompt/builder.ts`): matches decompiled CC 2.1.113 `zN_()` logic instead of hard-coding a single string that was wrong for either interactive or non-interactive flows.
- **Cache-control TTL on the identity block is 1h** (matches CC 2.1.112 on-wire value).
- **Sonnet 4.6+ correctly treated as 1M-context** and Haiku 4.5+ correctly allowed structured outputs (`src/models.ts`). Proven via the new capabilities snapshot tool.
- **Account selection when OAuth refresh succeeds but a single-account sticky setup hits a transient failure**: the "All accounts exhausted" message no longer implies real quota exhaustion — the underlying per-request backoff was tightening before the first request finished.
- **Test suite stability across account persistence, CLI, and integration suites**; 80 test files / 1369 tests + 5 skipped currently green.
- **cli.js import support** — `scripts/analysis/build-candidate-manifest.ts` now accepts a raw `cli.js` input and extracts the fingerprint automatically.

### Known issues

- **`cc_version` suffix algorithm is incorrect**. The existing `src/headers/billing.ts` computes `SHA-256(salt + text[4,7,20] + version).slice(0, 3)` with `salt = "59cf53e54c78"`. Validated against 5 real CC 2.1.113 OG captures and **0/5 match**: all 5 captures have identical first-user-message text but CC emits 5 distinct suffixes, so the text alone is not a sufficient input. Additional inputs tested and ruled out: session_id, request_id, their sha256 variants, literal substrings of both, sha256(bodyText), sha256(messagesJson), substrings of the `cch` field. **Impact: LOW** — Anthropic accepts the request regardless of suffix match; the field is a billing/tracing hint, not an auth check. Golden-pair tests shipped under `tests/unit/headers/billing-suffix.test.ts` with `describe.skip` for future work. See `docs/mimese-http-header-system-prompt.md` line 399 for the full investigation.

### Notes

- CHANGELOG entries for 0.1.5, 0.1.6, 0.1.7, 0.1.8, and 0.1.9 were skipped in the repo. The changes in those versions are consolidated under this 0.2.0 entry.
- Phase-1 evidence captures under `.sisyphus/evidence/phase-1-claim-validation/2026-04-17/` are intentionally gitignored; use them for local reference, not PRs.
- Sandbox integration test (`tests/integration/scripts/sandbox.test.ts`) must remain green before shipping any wire-level change that touches the plugin's XDG plumbing.

## [0.1.4] - 2026-04-11

### Changed

- **System prompt is now kept byte-for-byte identical to genuine Claude Code.** The plugin used to scrub OpenCode/Sisyphus/Morph identifiers in place via regex (`\bopencode\b → Claude` and friends). That approach corrupted any string that happened to contain `opencode` as a substring — most painfully, file paths and package names like `opencode-anthropic-fix` were being rewritten to `Claude-anthropic-fix` mid-request, breaking tool calls that referenced those paths. Worse, Claude (and Claude Code itself) misbehaves when third-party content is appended to its system prompt at all, even when the content is correctly scrubbed.
- **All non-Claude-Code system blocks now relocate to the first user message.** `parsed.system` is reduced to exactly two blocks — the billing header and the canonical identity string — matching what genuine Claude Code emits. Every other block (OpenCode behavior, plugin instructions, agent system prompts, env blocks, AGENTS.md content, etc.) is moved into `messages[0]`, wrapped in a `<system-instructions>` block with an explicit leading sentence telling the model to treat the wrapped content with the same authority as a system prompt.
- **The legacy `THIRD_PARTY_MARKERS` regex gate is gone.** It only relocated blocks that matched a hand-curated allowlist of known-bad slugs (`sisyphus`, `ohmyclaude`, `morph_`, etc.). The new rule is the opposite and complete: keep billing+identity in system, relocate everything else.
- The regex-based sanitizer is still available for users who explicitly opt in, but its default flipped from `true` to `false`. When opted in, the regexes now use negative lookarounds for `[\w\-/]` on both sides, so hyphenated identifiers and path segments survive verbatim. Path corruption is impossible even with sanitize on.

### Added

- `signature_emulation.sanitize_system_prompt` config field (default `false`).
- Top-level `sanitize_system_prompt` config alias for users who want a flat schema. The top-level value takes precedence over the nested one.
- `OPENCODE_ANTHROPIC_SANITIZE_SYSTEM_PROMPT` environment variable to override at runtime (`1`/`true` to enable, `0`/`false` to disable).
- `wrapAsSystemInstructions(text)` helper exported from `src/request/body.ts` for testability.
- 30 new tests covering: aggressive relocation behavior, the explicit wrapper instruction, hyphen/slash regex regressions, the sanitize gate, the config alias loader, and environment variable overrides.

### Fixed

- **Cache-control is now preserved on the relocated `<system-instructions>` wrapper.** The previous implementation pushed the wrapped block into `messages[0]` without any `cache_control`, which meant every request re-billed the full relocated prefix (skills list, MCP tool instructions, agent prompts, AGENTS.md, etc.) as fresh input tokens — a major cost regression vs. native Claude Code. The wrapper now carries `cache_control: { type: "ephemeral" }`, so the first turn pays `cache_creation` and subsequent turns read the prefix at `cache_read` pricing (~10% of fresh). String-content user messages are now converted to block form so `cache_control` can attach; the original user text is preserved as a second block so per-turn content does not invalidate the cache key. Anthropic's 4-breakpoint-per-request ceiling still has two slots of headroom (billing identity + relocated wrapper = 2).
- `logTransformedSystemPrompt` now detects title-generator requests in the relocated user message too. The previous detection only scanned `parsed.system` and missed title-generator requests after relocation, so the debug log was firing for them in violation of the documented `OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT` contract.

### Notes

- This is a behavior change. Existing users who relied on the old in-place sanitization will see their original strings (`OpenCode`, `Sisyphus`, `morph_edit`, etc.) preserved verbatim in the relocated wrapper. If you need the old rewriting behavior, set `sanitize_system_prompt: true` in your config.
- User messages that previously arrived as a plain string are now reshaped into a two-block array when signature emulation is on. Upstream code that assumes `messages[0].content` is always a string after this plugin runs needs to handle both shapes — `string | Array<{ type, text, cache_control? }>`. No upstream caller in this repo relied on the old assumption.

## [0.1.3] - 2026-04-11

### Removed

- Dead dependency `@openauthjs/openauth` (unused since the OAuth implementation was replaced by `src/oauth.ts` and `src/token-refresh.ts`). The package had zero references anywhere in source, tests, docs, or config — it was only listed in `package.json`. esbuild was already tree-shaking it out, so the published plugin bundle is byte-for-byte identical to 0.1.2 (SHA `f6a56195...`).

### Security

- Removing `@openauthjs/openauth` eliminates its transitive dependency on `hono`, which reduced `bun audit` findings from 27 → 7 (removed 14 hono-related CVEs plus 6 other transitive vulns). The remaining 7 are all in the dev toolchain (`vitest` → `vite` → `picomatch` / `yaml` / `brace-expansion` chain) and will resolve upstream when those packages release versions with updated inner deps.
- `npm audit fix` applied earlier in 0.1.2's dev-loop also resolved 8 dev-dep CVEs (ajv, brace-expansion, flatted, hono, picomatch, rollup, vite, yaml).

### Notes

- No runtime behavior changes. All 903 tests pass. Plugin SHA unchanged.

[0.1.3]: https://github.com/marco-jardim/opencode-anthropic-fix/releases/tag/v0.1.3

## [0.1.2] - 2026-04-11

### Fixed

- Removed `./` prefix from `main` and `bin` paths in `package.json` to silence npm publish warnings about "bin[X] script name ... was invalid and removed". The entries were never actually removed — npm's normalizer was auto-stripping the `./` prefix and warning about the diff between `package.json` and the registry manifest. This cosmetic fix aligns both.

### Notes

- No runtime behavior changes. `npm install @vacbo/opencode-anthropic-fix` continues to create working symlinks for `opencode-anthropic-auth` and `oaa` in `node_modules/.bin` (verified in 0.1.1 and unchanged in 0.1.2).

[0.1.2]: https://github.com/marco-jardim/opencode-anthropic-fix/releases/tag/v0.1.2

## [0.1.1] - 2026-04-11

### Fixed

- Dead conditional in `bun-fetch.ts` `reportFallback` function where both if/else branches executed identical `console.error` calls
- 16 lint errors: 12 CommonJS `require()` calls in `scripts/mock-upstream.js` and `scripts/rotation-test.js` converted to ESM `import`
- 4 empty catch blocks in `src/bun-fetch.ts` and `src/response/streaming.ts` annotated with explanatory comments

### Notes

- This is the first published release of the 0.1.x line. Version 0.1.0 was the plan completion checkpoint but was not published to npm; 0.1.1 is what ships with post-review fixes applied.

[0.1.1]: https://github.com/marco-jardim/opencode-anthropic-fix/releases/tag/v0.1.1

## [0.1.0] - 2026-04-10

### Fixed

- Parallel subagent failures that caused "tool_use" orphan errors when multiple concurrent requests were in flight
- SSE streaming fragility that produced "Unable to connect" errors under concurrent load
- Duplicate account creation when token rotation occurred during parallel OAuth flows
- 55+ inventoried bugs related to race conditions in account management and request handling

### Changed

- Proxy lifecycle: each OpenCode instance now owns its own dedicated proxy process instead of sharing a global proxy
- Refresh lock constants widened to 15-second timeout and 90-second stale threshold for better reliability under load
- SSE event-framing completely rewritten for robustness with concurrent streams
- Account deduplication strategy now uses identity-based matching instead of email-only comparison

### Added

- Account identity abstraction module for stable identity resolution across OAuth flows
- Circuit breaker implementation for per-request failure isolation (prevents one bad request from affecting others)
- Parent PID watcher for cross-platform proxy death detection
- 10 new test files covering parallel request scenarios and account deduplication edge cases
- `scripts/qa-parallel.sh` and `scripts/rotation-test.js` for manual QA verification

### Removed

- Global health check failure counter (replaced with per-request circuit breaker)
- Fixed port 48372 assignment (now uses ephemeral port allocation)
- Global PID file (now uses per-instance process tracking)
- Global process event handlers (replaced with parent-PID monitoring)

[0.1.0]: https://github.com/marco-jardim/opencode-anthropic-fix/releases/tag/v0.1.0
