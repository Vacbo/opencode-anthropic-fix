// ---------------------------------------------------------------------------
// Slash-command router for /anthropic commands
// ---------------------------------------------------------------------------

import type { AccountManager } from "../accounts.js";
import type { AnthropicAuthConfig } from "../config.js";
import { loadAccounts } from "../storage.js";
import type { ManagedAccount } from "../token-refresh.js";
import { handleBetasCommand } from "./handlers/betas.js";
import { handleConfigCommand, handleSetCommand } from "./handlers/config.js";
import { handleFilesCommand } from "./handlers/files.js";
import { completeSlashOAuth, startSlashOAuth, type OAuthFlowDeps, type PendingOAuthEntry } from "./oauth-flow.js";

// Re-export files utilities so existing imports from "./router.js" continue to work
export { capFileAccountMap, FILE_ACCOUNT_MAP_MAX_SIZE } from "./handlers/files.js";

export const ANTHROPIC_COMMAND_HANDLED = "__ANTHROPIC_COMMAND_HANDLED__";

export interface CliResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface CommandDeps {
    sendCommandMessage: (sessionID: string, message: string) => Promise<void>;
    accountManager: AccountManager | null;
    runCliCommand: (args: string[]) => Promise<CliResult>;
    config: AnthropicAuthConfig;
    fileAccountMap: Map<string, number>;
    initialAccountPinned: boolean;
    pendingSlashOAuth: Map<string, PendingOAuthEntry>;
    reloadAccountManagerFromDisk: () => Promise<void>;
    persistOpenCodeAuth: (refresh: string, access: string | undefined, expires: number | undefined) => Promise<void>;
    refreshAccountTokenSingleFlight: (account: ManagedAccount) => Promise<string>;
}

/**
 * Remove ANSI color/control codes from output text.
 */
export function stripAnsi(value: string): string {
    // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with \x1b which is a control char
    return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Parse command arguments with minimal quote support.
 *
 * Examples:
 *   a b "c d"  -> ["a", "b", "c d"]
 *   a 'c d'     -> ["a", "c d"]
 */
export function parseCommandArgs(raw: string): string[] {
    if (!raw || !raw.trim()) return [];
    const parts: string[] = [];
    const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
    let match;
    while ((match = re.exec(raw)) !== null) {
        const token = match[1] ?? match[2] ?? match[3] ?? "";
        parts.push(token.replace(/\\(["'\\])/g, "$1"));
    }
    return parts;
}

/**
 * Handle /anthropic slash commands.
 */
export async function handleAnthropicSlashCommand(
    input: { command: string; arguments?: string; sessionID: string },
    deps: CommandDeps,
): Promise<void> {
    const {
        sendCommandMessage,
        accountManager,
        runCliCommand,
        config,
        fileAccountMap,
        initialAccountPinned,
        pendingSlashOAuth,
        reloadAccountManagerFromDisk,
        persistOpenCodeAuth,
        refreshAccountTokenSingleFlight,
    } = deps;

    const oauthFlowDeps: OAuthFlowDeps = {
        pendingSlashOAuth,
        sendCommandMessage,
        reloadAccountManagerFromDisk,
        persistOpenCodeAuth,
    };

    const args = parseCommandArgs(input.arguments || "");
    const primary = (args[0] || "list").toLowerCase();

    // Friendly alias: /anthropic usage -> list
    if (primary === "usage") {
        const result = await runCliCommand(["list"]);
        const heading = result.code === 0 ? "▣ Anthropic" : "▣ Anthropic (error)";
        const body = result.stdout || result.stderr || "No output.";
        await sendCommandMessage(input.sessionID, [heading, "", body].join("\n"));
        await reloadAccountManagerFromDisk();
        return;
    }

    // Two-step login flow
    if (primary === "login") {
        if ((args[1] || "").toLowerCase() === "complete") {
            const code = args.slice(2).join(" ").trim();
            if (!code) {
                await sendCommandMessage(
                    input.sessionID,
                    "▣ Anthropic OAuth\n\nMissing code. Use: /anthropic login complete <code#state>",
                );
                return;
            }
            const result = await completeSlashOAuth(input.sessionID, code, oauthFlowDeps);
            const heading = result.ok ? "▣ Anthropic OAuth" : "▣ Anthropic OAuth (error)";
            await sendCommandMessage(input.sessionID, `${heading}\n\n${result.message}`);
            return;
        }
        await startSlashOAuth(input.sessionID, "login", undefined, oauthFlowDeps);
        return;
    }

    // Two-step reauth flow
    if (primary === "reauth") {
        if ((args[1] || "").toLowerCase() === "complete") {
            const code = args.slice(2).join(" ").trim();
            if (!code) {
                await sendCommandMessage(
                    input.sessionID,
                    "▣ Anthropic OAuth\n\nMissing code. Use: /anthropic reauth complete <code#state>",
                );
                return;
            }
            const result = await completeSlashOAuth(input.sessionID, code, oauthFlowDeps);
            const heading = result.ok ? "▣ Anthropic OAuth" : "▣ Anthropic OAuth (error)";
            await sendCommandMessage(input.sessionID, `${heading}\n\n${result.message}`);
            return;
        }
        const n = parseInt(args[1], 10);
        if (Number.isNaN(n) || n < 1) {
            await sendCommandMessage(
                input.sessionID,
                "▣ Anthropic OAuth\n\nProvide an account number. Example: /anthropic reauth 1",
            );
            return;
        }
        const stored = await loadAccounts();
        if (!stored || stored.accounts.length === 0) {
            await sendCommandMessage(input.sessionID, "▣ Anthropic OAuth (error)\n\nNo accounts configured.");
            return;
        }
        const idx = n - 1;
        if (idx >= stored.accounts.length) {
            await sendCommandMessage(
                input.sessionID,
                `▣ Anthropic OAuth (error)\n\nAccount ${n} does not exist. You have ${stored.accounts.length} account(s).`,
            );
            return;
        }
        await startSlashOAuth(input.sessionID, "reauth", idx, oauthFlowDeps);
        return;
    }

    // Delegate to focused handlers
    if (primary === "config") {
        await handleConfigCommand(input.sessionID, { sendCommandMessage, config });
        return;
    }

    if (primary === "set") {
        await handleSetCommand(input.sessionID, args, { sendCommandMessage, config });
        return;
    }

    if (primary === "betas") {
        await handleBetasCommand(input.sessionID, args, { sendCommandMessage, config, initialAccountPinned });
        return;
    }

    if (primary === "files") {
        await handleFilesCommand(input.sessionID, args, {
            sendCommandMessage,
            accountManager,
            fileAccountMap,
            refreshAccountTokenSingleFlight,
        });
        return;
    }

    // Interactive CLI command is not compatible with slash flow.
    if (primary === "manage" || primary === "mg") {
        await sendCommandMessage(
            input.sessionID,
            "▣ Anthropic\n\n`manage` is interactive-only. Use granular slash commands (switch/enable/disable/remove/reset) or run `opencode-anthropic-auth manage` in a terminal.",
        );
        return;
    }

    // Route remaining commands through the CLI command surface.
    const cliArgs = [...args];
    if (cliArgs.length === 0) cliArgs.push("list");

    // Avoid readline prompts in slash mode.
    if (
        (primary === "remove" || primary === "rm" || primary === "logout" || primary === "lo") &&
        !cliArgs.includes("--force")
    ) {
        cliArgs.push("--force");
    }

    const result = await runCliCommand(cliArgs);
    const heading = result.code === 0 ? "▣ Anthropic" : "▣ Anthropic (error)";
    const body = result.stdout || result.stderr || "No output.";
    await sendCommandMessage(input.sessionID, [heading, "", body].join("\n"));
    await reloadAccountManagerFromDisk();
}
