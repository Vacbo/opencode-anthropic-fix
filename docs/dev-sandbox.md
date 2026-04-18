# Dev Sandbox

Iterate on the plugin without breaking live OpenCode sessions.

## Why this exists

`bun run install:link` symlinks `src/index.ts` into `~/.config/opencode/plugin/`. Every keystroke in `src/` hot-reloads the plugin into every running OpenCode session. A parse-time or import-time error kills live sessions until you fix the file and save again. The sandbox gives you an independent XDG tree where the plugin comes from a copied bundle, not a live symlink.

Use the sandbox whenever you are:

- changing wire-visible behavior (headers, betas, system prompt, request body)
- experimenting with new OpenCode versions or configs
- working through a refactor that may temporarily break
- running end-to-end captures without risking the plugin the rest of the system is using

Keep `install:link` for quick edits to code paths you are confident about.

## Paths

| Path                                        | Purpose                                        |
| ------------------------------------------- | ---------------------------------------------- |
| `.sandbox/`                                 | Sandbox root (repo-local, gitignored)          |
| `.sandbox/config/opencode/plugin/*.js`      | Copied plugin bundle (not a symlink)           |
| `.sandbox/config/opencode/opencode.json`    | Sandbox-scoped OpenCode config                 |
| `.sandbox/config/opencode/anthropic-*.json` | Sandbox-scoped plugin config and accounts      |
| `.sandbox/bin/opencode-anthropic-auth`      | Copied CLI binary                              |
| `.sandbox/data/`                            | Sandbox-scoped OpenCode data (`XDG_DATA_HOME`) |
| `.sandbox/cache/`                           | Sandbox-scoped cache (`XDG_CACHE_HOME`)        |

Override the root with `SANDBOX_ROOT=/path/to/elsewhere`. Useful when running more than one sandbox at a time or testing the integration harness side-by-side with a real sandbox.

## Lifecycle

```bash
bun run sandbox:up         # build dist + copy plugin + CLI into the sandbox
bun run sandbox:reinstall  # rebuild + recopy without wiping sandbox state
bun run sandbox:status     # show plugin + CLI size, mtime, opencode.json state
bun run sandbox:down       # wipe the sandbox tree entirely
```

All of the above accept `SANDBOX_ROOT` to target a different root.

## Running OpenCode through the sandbox

Two options.

### Option 1: activate in your current shell

```bash
source scripts/sandbox-env.sh
opencode            # picks up the sandbox plugin, CLI, XDG paths
```

The activator exports:

- `SANDBOX_ROOT`
- `XDG_CONFIG_HOME=$SANDBOX_ROOT/config`
- `XDG_DATA_HOME=$SANDBOX_ROOT/data`
- `XDG_CACHE_HOME=$SANDBOX_ROOT/cache`
- `PATH=$SANDBOX_ROOT/bin:$PATH`
- `OPENCODE_ANTHROPIC_DEBUG=1`

Open a fresh shell when you want to leave sandbox mode. The sandbox never touches your real `~/.config/opencode/` or `~/.local/bin/` entries.

### Option 2: one-shot launch via `sandbox:run`

```bash
bun run sandbox:run -- run "hello, world"
```

Everything after `--` is forwarded to `opencode`. Useful for scripted smoke tests or CI-style checks.

## Account setup inside the sandbox

The sandbox starts with no Claude accounts. You have three options, cheapest first.

1. **Claude Code credential reuse (recommended when `claude` is installed).** The plugin detects `Claude Code-credentials` in Keychain (macOS) or `~/.claude/.credentials.json` (Linux) and uses the same token OG Claude Code uses. Zero login flow, zero duplicate tokens, and the sandbox reads Keychain read-only so it cannot corrupt the live credential.
2. **`oaa login` inside the sandbox.** With the activator sourced:
    ```bash
    source scripts/sandbox-env.sh
    opencode-anthropic-auth login
    ```
    This writes to `.sandbox/config/opencode/anthropic-accounts.json`. The live accounts file is untouched.
3. **Copy an existing accounts file.** `cp ~/.config/opencode/anthropic-accounts.json .sandbox/config/opencode/`. Useful when you want to reproduce a specific account setup.

## Verifying the sandbox did not leak

After `sandbox:up`, confirm the live install is untouched:

```bash
ls -la ~/.config/opencode/plugin/
# opencode-anthropic-auth-plugin.js -> /path/to/opencode-anthropic-fix/src/index.ts
```

The symlink target should still be `src/index.ts` — the sandbox never rewrites it.

## Common failure modes

| Symptom                                                  | Cause                                                            | Fix                                                                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox:up` fails with `dist/...not found`              | `bun run build` did not complete                                 | Re-run `bun run sandbox:up`; the script calls `bun run build` automatically                                                                                |
| `bun run sandbox:run` logs "`opencode` binary not found" | OpenCode is not on PATH                                          | Install OpenCode (`brew install sst/tap/opencode`) and re-source the activator                                                                             |
| Live OpenCode session breaks anyway                      | You edited `src/` and the `install:link` symlink is still active | That is expected. The sandbox does not replace `install:link`; run `bun run uninstall` first if you want ONLY the sandbox active                           |
| Sandbox state leaks between runs                         | `.sandbox/` is persistent                                        | Run `bun run sandbox:down` to wipe it                                                                                                                      |
| Credential reuse fails silently in the sandbox           | `claude` is not on PATH within the sandbox shell                 | The activator prepends `$SANDBOX_ROOT/bin` but keeps the rest of PATH; if `claude` is not on your real PATH it will not be found inside the sandbox either |

## Relationship to `install:link`

Both mechanisms can coexist. They target different directories:

- `install:link` → `~/.config/opencode/plugin/opencode-anthropic-auth-plugin.js` (symlink to `src/index.ts`)
- `sandbox:up` → `.sandbox/config/opencode/plugin/opencode-anthropic-auth-plugin.js` (copy of `dist/opencode-anthropic-auth-plugin.mjs`)

Live OpenCode sessions outside the sandbox still hot-reload from the symlink. Sandbox sessions see only the copy and only update on explicit `sandbox:reinstall`.

## When to run the sandbox integration test

`tests/integration/scripts/sandbox.test.ts` covers the invariants the sandbox exists to protect. Re-run it any time you touch `scripts/sandbox.ts` or change the shape of `XDG_*` handling:

```bash
bun run test tests/integration/scripts/sandbox.test.ts
```

The test uses `.sandbox-test/` (not `.sandbox/`) so your working sandbox is preserved across test runs.
