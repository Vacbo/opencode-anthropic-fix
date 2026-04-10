import { AccountManager } from "./accounts.js";
import { stripAnsi } from "./commands/router.js";
import type { AnthropicAuthConfig } from "./config.js";
import type { OpenCodeClient } from "./token-refresh.js";

/**
 * Cap on the toast-debounce timestamp map. Bounded because each distinct
 * `debounceKey` creates a long-lived entry, and new debounce keys accumulate
 * over a session (one per account switch reason, per account, etc.). Eviction
 * is FIFO on the insertion order preserved by Map.
 */
const DEBOUNCE_TOAST_MAP_MAX_SIZE = 50;

export interface PluginHelperDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenCode plugin client API boundary; accepts arbitrary extension methods
  client: OpenCodeClient & Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- plugin config accepts forward-compatible arbitrary keys
  config: AnthropicAuthConfig & Record<string, any>;
  debugLog: (...args: unknown[]) => void;
  getAccountManager: () => AccountManager | null;
  setAccountManager: (accountManager: AccountManager | null) => void;
}

export function createPluginHelpers({
  client,
  config,
  debugLog,
  getAccountManager,
  setAccountManager,
}: PluginHelperDeps) {
  const debouncedToastTimestamps = new Map<string, number>();

  async function sendCommandMessage(sessionID: string, text: string) {
    await client.session?.prompt({
      path: { id: sessionID },
      body: { noReply: true, parts: [{ type: "text", text, ignored: true }] },
    });
  }

  async function reloadAccountManagerFromDisk() {
    if (!getAccountManager()) return;
    setAccountManager(await AccountManager.load(config, null));
  }

  async function persistOpenCodeAuth(refresh: string, access: string | undefined, expires: number | undefined) {
    await client.auth?.set({
      path: { id: "anthropic" },
      body: { type: "oauth", refresh, access, expires },
    });
  }

  async function runCliCommand(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const logs: string[] = [];
    const errors: string[] = [];
    let code = 1;
    try {
      const { main: cliMain } = await import("./cli.js");
      code = await cliMain(argv, {
        io: {
          log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
          error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
        },
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    return {
      code,
      stdout: stripAnsi(logs.join("\n")).trim(),
      stderr: stripAnsi(errors.join("\n")).trim(),
    };
  }

  async function toast(
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
    options: { debounceKey?: string } = {},
  ) {
    if (config.toasts.quiet && variant !== "error") return;
    if (variant !== "error" && options.debounceKey) {
      const minGapMs = Math.max(0, config.toasts.debounce_seconds) * 1000;
      if (minGapMs > 0) {
        const now = Date.now();
        const lastAt = debouncedToastTimestamps.get(options.debounceKey) ?? 0;
        if (now - lastAt < minGapMs) return;
        if (
          !debouncedToastTimestamps.has(options.debounceKey) &&
          debouncedToastTimestamps.size >= DEBOUNCE_TOAST_MAP_MAX_SIZE
        ) {
          const oldestKey = debouncedToastTimestamps.keys().next().value;
          if (oldestKey !== undefined) debouncedToastTimestamps.delete(oldestKey);
        }
        debouncedToastTimestamps.set(options.debounceKey, now);
      }
    }
    try {
      await client.tui?.showToast({ body: { message, variant } });
    } catch (err) {
      if (!(err instanceof TypeError)) debugLog("toast failed:", err);
    }
  }

  return {
    toast,
    sendCommandMessage,
    runCliCommand,
    reloadAccountManagerFromDisk,
    persistOpenCodeAuth,
  };
}

export type PluginHelpers = ReturnType<typeof createPluginHelpers>;
