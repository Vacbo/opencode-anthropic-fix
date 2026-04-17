# agents.md

This repository is OAuth-first and optimized for Claude Code request mimese.

## Operating rules

- Use OAuth login flows (`opencode-anthropic-auth login` / `reauth`) for all accounts.
- Treat direct API-key auth as out of scope for normal operation.
- Keep Claude signature emulation enabled by default unless debugging a regression.

## Concurrency guarantees

The plugin architecture maintains these invariants for parallel request handling:

- **Single proxy handles N concurrent requests** — each OpenCode instance's dedicated proxy process can handle multiple concurrent requests without blocking
- **Circuit breaker is per-request not global** — failure isolation prevents one bad request from affecting others; each request gets its own circuit breaker context
- **No restart-kill behavior** — the proxy process does not restart or kill itself during normal operation; it stays alive for the parent's lifetime
- **Stable identity dedup** — account identity resolution prevents duplicate accounts across concurrent auth flows; same identity always maps to the same account record

These guarantees ensure that parallel requests (for example, multiple concurrent API calls or file operations) remain isolated and do not interfere with each other.

## Request-shaping expectations

- Always include OAuth beta behavior: `oauth-2025-04-20` must be present in `anthropic-beta` when authenticated via OAuth.
- Preserve model/provider-aware beta composition logic in `src/betas.ts` and `src/headers/builder.ts`.
- Preserve Claude-style system prompt shaping (identity block + billing header block rules).
- Keep `metadata.user_id` composition stable across account/session context.

## Change policy for contributors and agents

- Prefer minimal diffs that keep existing runtime behavior intact.
- When updating beta/header logic, update docs in `docs/mimese-http-header-system-prompt.md` and `README.md` together.
- Add or adjust tests in `index.test.ts` and `tests/regression/fingerprint/cc-comparison.test.ts` for any header/system/body mimicry change.
- Preserve the per-instance proxy lifecycle: each OpenCode instance gets its own proxy that dies with the parent process.
- Maintain concurrency guarantees: single proxy handles N concurrent requests, circuit breaker is per-request not global, no restart-kill behavior, stable identity dedup.
- Keep graceful fallback to native fetch when Bun is unavailable.
