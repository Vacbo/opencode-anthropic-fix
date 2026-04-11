# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
