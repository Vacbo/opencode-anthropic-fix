// ---------------------------------------------------------------------------
// Betas slash-command handler (/anthropic betas)
// ---------------------------------------------------------------------------

import { resolveBetaShortcut } from "../../betas.js";
import type { AnthropicAuthConfig } from "../../config.js";
import { loadConfigFresh, saveConfig } from "../../config.js";
import { isTruthyEnv } from "../../env.js";

export interface BetasHandlerDeps {
    sendCommandMessage: (sessionID: string, message: string) => Promise<void>;
    config: AnthropicAuthConfig;
    initialAccountPinned: boolean;
}

/**
 * Handle /anthropic betas [list|add|remove <beta>].
 */
export async function handleBetasCommand(sessionID: string, args: string[], deps: BetasHandlerDeps): Promise<void> {
    const { sendCommandMessage, config, initialAccountPinned } = deps;
    const action = (args[1] || "").toLowerCase();

    if (!action || action === "list") {
        const fresh = loadConfigFresh();
        const strategy = fresh.account_selection_strategy || config.account_selection_strategy;
        const lines = [
            "▣ Anthropic Betas",
            "",
            "Preset betas (auto-computed per model/provider):",
            "  oauth-2025-04-20, claude-code-20250219,",
            "  advanced-tool-use-2025-11-20, fast-mode-2026-02-01,",
            "  interleaved-thinking-2025-05-14 (non-Opus 4.6) OR effort-2025-11-24 (Opus 4.6),",
            "  files-api-2025-04-14 (only /v1/files and requests with file_id),",
            "  token-counting-2024-11-01 (only /v1/messages/count_tokens),",
            `  prompt-caching-scope-2026-01-05 (non-interactive${strategy === "round-robin" ? ", skipped in round-robin" : ""})`,
            "",
            `Experimental betas: ${isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) ? "disabled (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1)" : "enabled"}`,
            `Strategy: ${strategy}${initialAccountPinned ? " (pinned via OPENCODE_ANTHROPIC_INITIAL_ACCOUNT)" : ""}`,
            `Custom betas: ${fresh.custom_betas.length ? fresh.custom_betas.join(", ") : "(none)"}`,
            "",
            "Toggleable presets:",
            "  /anthropic betas add structured-outputs-2025-12-15",
            "  /anthropic betas add context-management-2025-06-27",
            "  /anthropic betas add task-budgets-2026-03-13",
            "  /anthropic betas add web-search-2025-03-05",
            "  /anthropic betas add compact-2026-01-12",
            "  /anthropic betas add mcp-servers-2025-12-04",
            "  /anthropic betas add redact-thinking-2026-02-12",
            "  /anthropic betas add 1m   (shortcut for context-1m-2025-08-07)",
            "",
            "Remove: /anthropic betas remove <beta>",
        ];
        await sendCommandMessage(sessionID, lines.join("\n"));
        return;
    }

    if (action === "add") {
        const betaInput = args[2]?.trim();
        if (!betaInput) {
            await sendCommandMessage(sessionID, "▣ Anthropic Betas\n\nUsage: /anthropic betas add <beta-name>");
            return;
        }
        const beta = resolveBetaShortcut(betaInput);
        const fresh = loadConfigFresh();
        const current = fresh.custom_betas || [];
        if (current.includes(beta)) {
            await sendCommandMessage(sessionID, `▣ Anthropic Betas\n\n"${beta}" already added.`);
            return;
        }
        saveConfig({ custom_betas: [...current, beta] });
        Object.assign(config, loadConfigFresh());
        const fromShortcut = beta !== betaInput;
        await sendCommandMessage(
            sessionID,
            `▣ Anthropic Betas\n\nAdded: ${beta}${fromShortcut ? ` (from shortcut: ${betaInput})` : ""}`,
        );
        return;
    }

    if (action === "remove" || action === "rm") {
        const betaInput = args[2]?.trim();
        if (!betaInput) {
            await sendCommandMessage(sessionID, "▣ Anthropic Betas\n\nUsage: /anthropic betas remove <beta-name>");
            return;
        }
        const beta = resolveBetaShortcut(betaInput);
        const fresh = loadConfigFresh();
        const current = fresh.custom_betas || [];
        if (!current.includes(beta)) {
            await sendCommandMessage(sessionID, `▣ Anthropic Betas\n\n"${beta}" not in custom betas.`);
            return;
        }
        saveConfig({ custom_betas: current.filter((b) => b !== beta) });
        Object.assign(config, loadConfigFresh());
        await sendCommandMessage(sessionID, `▣ Anthropic Betas\n\nRemoved: ${beta}`);
        return;
    }

    await sendCommandMessage(sessionID, "▣ Anthropic Betas\n\nUsage: /anthropic betas [add|remove <beta>]");
}
