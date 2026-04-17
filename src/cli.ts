#!/usr/bin/env bun
/**
 * CLI entrypoint — thin dispatcher that routes to command handlers.
 *
 * Command handlers live in:
 *   ./cli/commands/auth.ts   — auth, account commands (login, logout, list, switch, etc.)
 *   ./cli/commands/config.ts — config, usage, manage commands (strategy, stats, manage, etc.)
 *
 * This file owns: argv parsing, flag extraction, IO context routing, direct entry.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import { c, setUseColor } from "./cli/formatting.js";
import {
    cmdAuthGroupHelp,
    cmdDisable,
    cmdEnable,
    cmdList,
    cmdLogin,
    cmdLogout,
    cmdReauth,
    cmdRefresh,
    cmdRemove,
    cmdReset,
    cmdStats,
    cmdStatus,
    cmdSwitch,
} from "./cli/commands/auth.js";
import {
    cmdHelp,
    cmdManage,
    cmdProfile,
    cmdResetStats,
    cmdStrategy,
    dispatchConfigCommands,
    dispatchManageCommands,
    dispatchUsageCommands,
} from "./cli/commands/config.js";

// Re-export for backward compatibility (tests and external consumers import from cli.ts)
export { formatDuration, formatTimeAgo, renderBar, formatResetTime, renderUsageLines } from "./cli/formatting.js";
export { fetchProfile, fetchUsage } from "./cli/status-api.js";
export {
    ensureTokenAndFetchUsage,
    refreshAccessToken,
    cmdDisable,
    cmdEnable,
    cmdList,
    cmdLogin,
    cmdLogout,
    cmdReauth,
    cmdRefresh,
    cmdRemove,
    cmdReset,
    cmdStats,
    cmdStatus,
    cmdSwitch,
} from "./cli/commands/auth.js";
export { cmdConfig, cmdHelp, cmdManage, cmdProfile, cmdResetStats, cmdStrategy } from "./cli/commands/config.js";

// ---------------------------------------------------------------------------
// IO context — routes console.log/error through AsyncLocalStorage for testing
// ---------------------------------------------------------------------------

type IoStore = {
    log?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
};
const ioContext = new AsyncLocalStorage<IoStore>();

const nativeConsoleLog = console.log.bind(console);
const nativeConsoleError = console.error.bind(console);
let consoleRouterUsers = 0;

function installConsoleRouter() {
    if (consoleRouterUsers === 0) {
        console.log = (...args) => {
            const io = ioContext.getStore();
            if (io?.log) return io.log(...args);
            return nativeConsoleLog(...args);
        };
        console.error = (...args) => {
            const io = ioContext.getStore();
            if (io?.error) return io.error(...args);
            return nativeConsoleError(...args);
        };
    }
    consoleRouterUsers++;
}

function uninstallConsoleRouter() {
    consoleRouterUsers = Math.max(0, consoleRouterUsers - 1);
    if (consoleRouterUsers === 0) {
        console.log = nativeConsoleLog;
        console.error = nativeConsoleError;
    }
}

async function runWithIoContext(io: IoStore, fn: () => Promise<number>) {
    installConsoleRouter();
    try {
        return await ioContext.run(io, fn);
    } finally {
        uninstallConsoleRouter();
    }
}

// ---------------------------------------------------------------------------
// Group dispatchers — delegate to sub-module dispatchers where they exist,
// inline the thin auth/account routing that needs flag threading.
// ---------------------------------------------------------------------------

async function dispatchAuth(args: string[], flags: { force: boolean; all: boolean }) {
    const subcommand = args[0] || "help";
    const arg = args[1];

    switch (subcommand) {
        case "login":
        case "ln":
            return cmdLogin();
        case "logout":
        case "lo":
            return cmdLogout(arg, { force: flags.force, all: flags.all });
        case "reauth":
        case "ra":
            return cmdReauth(arg);
        case "refresh":
        case "rf":
            return cmdRefresh(arg);
        case "help":
        case "-h":
        case "--help":
            return cmdAuthGroupHelp("auth");
        default:
            console.error(c.red(`Unknown auth command: ${subcommand}`));
            console.error(c.dim("Run 'opencode-anthropic-auth auth help' for usage."));
            return 1;
    }
}

async function dispatchAccount(args: string[], flags: { force: boolean }) {
    const subcommand = args[0] || "list";
    const arg = args[1];

    switch (subcommand) {
        case "list":
        case "ls":
            return cmdList();
        case "switch":
        case "sw":
            return cmdSwitch(arg);
        case "enable":
        case "en":
            return cmdEnable(arg);
        case "disable":
        case "dis":
            return cmdDisable(arg);
        case "remove":
        case "rm":
            return cmdRemove(arg, { force: flags.force });
        case "reset":
            return cmdReset(arg);
        case "help":
        case "-h":
        case "--help":
            return cmdAuthGroupHelp("account");
        default:
            console.error(c.red(`Unknown account command: ${subcommand}`));
            console.error(c.dim("Run 'opencode-anthropic-auth account help' for usage."));
            return 1;
    }
}

// ---------------------------------------------------------------------------
// Top-level dispatch — two-level (group → subcommand) with legacy flat aliases
// ---------------------------------------------------------------------------

async function dispatch(argv: string[]) {
    const args = argv.filter((a: string) => !a.startsWith("--"));
    const flags = argv.filter((a: string) => a.startsWith("--"));

    if (flags.includes("--no-color")) setUseColor(false);
    if (flags.includes("--help")) return cmdHelp();

    const command = args[0] || "list";
    const remainingArgs = args.slice(1);
    const force = flags.includes("--force");
    const all = flags.includes("--all");

    switch (command) {
        // ── Group dispatchers ──────────────────────────────────────────────
        case "auth":
            return dispatchAuth(remainingArgs, { force, all });
        case "account":
            return dispatchAccount(remainingArgs, { force });
        case "usage":
            return dispatchUsageCommands(remainingArgs);
        case "config":
            return dispatchConfigCommands(remainingArgs);
        case "manage":
            return dispatchManageCommands(remainingArgs);

        // ── Legacy flat aliases (backward compat) ──────────────────────────
        // Auth
        case "login":
        case "ln":
            return cmdLogin();
        case "logout":
        case "lo":
            return cmdLogout(remainingArgs[0], { force, all });
        case "reauth":
        case "ra":
            return cmdReauth(remainingArgs[0]);
        case "refresh":
        case "rf":
            return cmdRefresh(remainingArgs[0]);

        // Account
        case "list":
        case "ls":
            return cmdList();
        case "switch":
        case "sw":
            return cmdSwitch(remainingArgs[0]);
        case "enable":
        case "en":
            return cmdEnable(remainingArgs[0]);
        case "disable":
        case "dis":
            return cmdDisable(remainingArgs[0]);
        case "remove":
        case "rm":
            return cmdRemove(remainingArgs[0], { force });
        case "reset":
            return cmdReset(remainingArgs[0]);

        // Usage
        case "stats":
            return cmdStats();
        case "reset-stats":
            return cmdResetStats(remainingArgs[0]);
        case "status":
        case "st":
            return cmdStatus();

        // Config
        case "strategy":
        case "strat":
            return cmdStrategy(remainingArgs[0]);
        case "profile":
            return cmdProfile(remainingArgs[0]);
        case "cfg":
            return dispatchConfigCommands(["show"]);

        // Manage
        case "mg":
            return cmdManage();

        // Help
        case "help":
        case "-h":
        case "--help":
            return cmdHelp();

        default:
            console.error(c.red(`Unknown command: ${command}`));
            console.error(c.dim("Run 'opencode-anthropic-auth help' for usage."));
            return 1;
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function main(argv: string[], options: { io?: IoStore } = {}) {
    if (options.io) {
        return runWithIoContext(options.io, () => dispatch(argv));
    }
    return dispatch(argv);
}

// ---------------------------------------------------------------------------
// Direct execution detection
// ---------------------------------------------------------------------------

export async function detectMain(
    options: {
        argv1?: string;
        importMetaMain?: boolean;
        importMetaUrl?: string;
    } = {},
) {
    if (options.importMetaMain ?? import.meta.main) {
        return true;
    }

    const argv1 = options.argv1 ?? process.argv[1];
    const importMetaUrl = options.importMetaUrl ?? import.meta.url;

    if (!argv1) return false;
    if (importMetaUrl === pathToFileURL(argv1).href) return true;
    try {
        const { realpath } = await import("node:fs/promises");
        const resolved = await realpath(argv1);
        return importMetaUrl === pathToFileURL(resolved).href;
    } catch {
        return false;
    }
}

if (await detectMain()) {
    main(process.argv.slice(2))
        .then((code) => process.exit(code))
        .catch((err) => {
            console.error(c.red(`Fatal: ${err.message}`));
            process.exit(1);
        });
}
