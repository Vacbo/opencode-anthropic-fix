# OpenCode plugin cache

Where OpenCode actually loads plugins from, why it's not where you think, and how to flush it when a new version does not take effect.

## TL;DR

- Plugins listed in `~/.config/opencode/opencode.json` are NOT loaded from `~/.config/opencode/node_modules/`.
- They are resolved into `~/.cache/opencode/packages/<name>@<spec>/node_modules/<name>/`.
- A running OpenCode process keeps the old plugin code in memory. Cache flushes do nothing until you restart OpenCode.
- Proxies spawned by the plugin are child processes of the OpenCode instance that spawned them.

## The plugin loading path

When `opencode.json` lists a plugin:

```jsonc
{
    "plugin": ["@vacbo/opencode-anthropic-fix@latest"],
}
```

OpenCode resolves that spec into its own package cache:

```
~/.cache/opencode/packages/@vacbo/opencode-anthropic-fix@latest/
└── node_modules/
    └── @vacbo/
        └── opencode-anthropic-fix/
            ├── package.json        <-- version lives here
            └── dist/
└── opencode-anthropic-auth-plugin.mjs  <-- built artifact cached here
```

The cache-directory name mirrors the `opencode.json` spec exactly (`@latest`, `^1.0.0`, etc.).

## The red-herring directory

`~/.config/opencode/` also looks like a plugin install target. It has a `package.json`, a `node_modules/` tree, a `bun.lock`, and a `package-lock.json`. None of that is used by OpenCode's plugin loader. It is leftover state from a manual `npm install` attempt or an older OpenCode version. Updating a plugin under `~/.config/opencode/node_modules/` has zero effect on what OpenCode loads.

## How to verify which version OpenCode is actually running

```bash
# Check the cache, not ~/.config/opencode/
cat ~/.cache/opencode/packages/@vacbo/opencode-anthropic-fix@latest/node_modules/@vacbo/opencode-anthropic-fix/package.json | grep version

# Compare its SHA with what we published
shasum -a 256 ~/.cache/opencode/packages/@vacbo/opencode-anthropic-fix@latest/node_modules/@vacbo/opencode-anthropic-fix/dist/opencode-anthropic-auth-plugin.mjs
```

## Forcing an upgrade

A clean upgrade requires all three of these steps. Skipping any one leaves stale state behind.

### 1. Clear the plugin cache

```bash
rm -rf ~/.cache/opencode/packages/@vacbo/opencode-anthropic-fix@latest
```

This deletes the cached extraction. On next OpenCode start, it will re-resolve `@latest` from the npm registry.

### 2. Kill any stale proxy child processes

The Bun-based TLS mimicry proxy runs as a child of the OpenCode process that spawned it. Find it:

```bash
ps -eo pid,ppid,command | grep -E 'bun-proxy|opencode-anthropic'
```

Expected output for a running proxy:

```
<pid> <ppid> bun run ~/.cache/opencode/.../dist/bun-proxy.mjs <port>
```

- Pre-0.1.1 plugin versions hardcode port **48372**. Verify with `lsof -nP -iTCP:48372 -sTCP:LISTEN`.
- Post-0.1.1 plugin versions use ephemeral ports assigned by the kernel.
- Kill with `kill <pid>` or `kill -9 <pid>` if it does not exit cleanly.

### 3. Restart OpenCode

This is the step most often forgotten. OpenCode loads the plugin module into memory at startup. Clearing the cache on disk does nothing for already-running OpenCode instances — they continue executing the old in-memory bundle until the process exits.

```bash
# Find all OpenCode processes
ps -eo pid,ppid,command | grep '\.opencode'

# Restart the UI (or kill and relaunch from your terminal / dock)
```

After restart, OpenCode re-resolves `@latest` from npm, extracts it into the cache, loads the new module, and the new plugin spawns a fresh proxy on an ephemeral port.

## Debugging symptoms of a stale cache

| Symptom                                                    | Likely cause                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `[bun-fetch] Routing through Bun proxy at :48372` in logs  | Pre-0.1.1 plugin loaded from cache. Port 48372 was removed in 0.1.1.                                        |
| `[bun-fetch] Reusing existing Bun proxy` in logs           | Pre-0.1.1 plugin loaded from cache. Message was removed in 0.1.1.                                           |
| Debug logs appearing when `debug: false` in config         | Pre-0.1.1 plugin loaded from cache. All per-request debug logs were gated behind `resolveDebug()` in 0.1.1. |
| New plugin version published to npm but behavior unchanged | Cache flush was skipped, or OpenCode was not restarted, or both.                                            |

## Plugin version ↔ plugin SHA reference

| Version            | Plugin bundle SHA (first 16 chars) | Notes                                                                                                           |
| ------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 0.0.45 and earlier | varies per release                 | Pre-refactor. Contains fixed port `48372`. Contains unguarded debug logs.                                       |
| 0.1.1              | `f6a561955b33a913`                 | First published 0.1.x. Ephemeral ports. Parent-PID watcher. Guarded debug logs.                                 |
| 0.1.2              | `f6a561955b33a913`                 | Metadata-only fix (bin paths). Bundle identical to 0.1.1.                                                       |
| 0.1.3              | `f6a561955b33a913`                 | Removed unused `@openauthjs/openauth` dep. Bundle identical to 0.1.1 (esbuild was already tree-shaking it out). |

If the SHA of `~/.cache/opencode/packages/@vacbo/opencode-anthropic-fix@latest/node_modules/@vacbo/opencode-anthropic-fix/dist/opencode-anthropic-auth-plugin.mjs` is not `f6a561955b33a913...`, OpenCode is running a pre-0.1.1 plugin and needs a full cache flush plus restart.
