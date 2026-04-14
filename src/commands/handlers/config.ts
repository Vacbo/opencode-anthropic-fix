// ---------------------------------------------------------------------------
// Config slash-command handlers (/anthropic config, /anthropic set)
// ---------------------------------------------------------------------------

import type { AnthropicAuthConfig } from "../../config.js";
import { loadConfigFresh, saveConfig } from "../../config.js";

export interface ConfigHandlerDeps {
    sendCommandMessage: (sessionID: string, message: string) => Promise<void>;
    config: AnthropicAuthConfig;
}

/**
 * Handle /anthropic config — display current configuration.
 */
export async function handleConfigCommand(sessionID: string, deps: ConfigHandlerDeps): Promise<void> {
    const { sendCommandMessage } = deps;
    const fresh = loadConfigFresh();
    const lines = [
        "▣ Anthropic Config",
        "",
        `strategy: ${fresh.account_selection_strategy}`,
        `profile: ${fresh.signature_profile}`,
        `emulation: ${fresh.signature_emulation.enabled ? "on" : "off"}`,
        `compaction: ${fresh.signature_emulation.prompt_compaction}`,
        `1m-context: ${fresh.override_model_limits.enabled ? "on" : "off"}`,
        `idle-refresh: ${fresh.idle_refresh.enabled ? "on" : "off"}`,
        `debug: ${fresh.debug ? "on" : "off"}`,
        `quiet: ${fresh.toasts.quiet ? "on" : "off"}`,
        `custom_betas: ${fresh.custom_betas.length ? fresh.custom_betas.join(", ") : "(none)"}`,
    ];
    await sendCommandMessage(sessionID, lines.join("\n"));
}

/**
 * Handle /anthropic set <key> <value> — update a config setting.
 */
export async function handleSetCommand(sessionID: string, args: string[], deps: ConfigHandlerDeps): Promise<void> {
    const { sendCommandMessage, config } = deps;
    const key = (args[1] || "").toLowerCase();
    const value = (args[2] || "").toLowerCase();
    const setters: Record<string, () => void> = {
        emulation: () =>
            saveConfig({
                signature_emulation: {
                    enabled: value === "on" || value === "1" || value === "true",
                },
            }),
        compaction: () =>
            saveConfig({
                signature_emulation: {
                    prompt_compaction: value === "off" ? "off" : "minimal",
                },
            }),
        "1m-context": () =>
            saveConfig({
                override_model_limits: {
                    enabled: value === "on" || value === "1" || value === "true",
                },
            }),
        "idle-refresh": () =>
            saveConfig({
                idle_refresh: {
                    enabled: value === "on" || value === "1" || value === "true",
                },
            }),
        debug: () =>
            saveConfig({
                debug: value === "on" || value === "1" || value === "true",
            }),
        quiet: () =>
            saveConfig({
                toasts: {
                    quiet: value === "on" || value === "1" || value === "true",
                },
            }),
        strategy: () => {
            const valid = ["sticky", "round-robin", "hybrid"];
            if (valid.includes(value))
                saveConfig({ account_selection_strategy: value as "sticky" | "round-robin" | "hybrid" });
            else throw new Error(`Invalid strategy. Valid: ${valid.join(", ")}`);
        },
    };

    if (!key || !setters[key]) {
        const keys = Object.keys(setters).join(", ");
        await sendCommandMessage(
            sessionID,
            `▣ Anthropic Set\n\nUsage: /anthropic set <key> <value>\nKeys: ${keys}\nValues: on/off (or specific values for strategy/compaction)`,
        );
        return;
    }
    if (!value) {
        await sendCommandMessage(sessionID, `▣ Anthropic Set\n\nMissing value for "${key}".`);
        return;
    }
    setters[key]();
    Object.assign(config, loadConfigFresh());
    await sendCommandMessage(sessionID, `▣ Anthropic Set\n\n${key} = ${value}`);
}
