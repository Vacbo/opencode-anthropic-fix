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

## Dev sandbox (prefer for breaking changes)

`bun run install:link` symlinks `src/index.ts` into `~/.config/opencode/plugin/`, which means parse-time errors kill every live OpenCode session. Before changing wire-visible behavior (headers, betas, system prompt, request body shape, OAuth flow), use the sandbox:

1. `bun run sandbox:up` — builds and installs the plugin into `./.sandbox/`, no symlinks.
2. `source scripts/sandbox-env.sh` — points the current shell at the sandbox plugin/CLI/XDG paths.
3. `opencode` — now runs against the sandbox, with `OPENCODE_ANTHROPIC_DEBUG=1` for verbose logging.
4. `bun run sandbox:reinstall` — after each edit, rebuild dist and copy into the sandbox; state is preserved.
5. `bun run sandbox:down` when done.

`bun run test tests/integration/scripts/sandbox.test.ts` covers the isolation invariants (plugin/CLI are copies, live `~/.config/opencode/` stays untouched, reinstall preserves state). Re-run any time you touch `scripts/sandbox.ts` or the XDG plumbing.

Full operator docs: [`docs/dev-sandbox.md`](docs/dev-sandbox.md).
