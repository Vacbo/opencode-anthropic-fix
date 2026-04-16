// ---------------------------------------------------------------------------
// Environment variable helpers extracted from src/index.ts
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";
import { DEBUG_SYSTEM_PROMPT_ENV, USER_ID_STORAGE_FILE } from "./constants.js";

export function isTruthyEnv(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function isFalsyEnv(value: string | undefined): boolean {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "0" || normalized === "false" || normalized === "no";
}

export function isNonInteractiveMode(): boolean {
    if (isTruthyEnv(process.env.CI)) return true;
    return !process.stdout.isTTY;
}

export function getClaudeEntrypoint(): string {
    return process.env.CLAUDE_CODE_ENTRYPOINT || "sdk-cli";
}

export function parseAnthropicCustomHeaders(): Record<string, string> {
    const raw = process.env.ANTHROPIC_CUSTOM_HEADERS;
    if (!raw) return {};

    const headers: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const sep = trimmed.indexOf(":");
        if (sep <= 0) continue;
        const key = trimmed.slice(0, sep).trim();
        const value = trimmed.slice(sep + 1).trim();
        if (!key || !value) continue;
        headers[key] = value;
    }

    return headers;
}

export function getOrCreateSignatureUserId(): string {
    const envUserId = process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID?.trim();
    if (envUserId) return envUserId;

    const configDir = getConfigDir();
    const userIdPath = join(configDir, USER_ID_STORAGE_FILE);

    try {
        if (existsSync(userIdPath)) {
            const existing = readFileSync(userIdPath, "utf-8").trim();
            // CC uses 64-char hex (32 random bytes). Accept existing hex IDs;
            // regenerate if we find an old UUID-format ID.
            if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
        }
    } catch {
        // fall through and generate a new id
    }

    // CC generates device_id as randomBytes(32).toString("hex") → 64-char hex
    const generated = randomBytes(32).toString("hex");
    try {
        mkdirSync(configDir, { recursive: true });
        writeFileSync(userIdPath, `${generated}\n`, {
            encoding: "utf-8",
            mode: 0o600,
        });
    } catch {
        // Ignore filesystem errors; caller still gets generated ID for this runtime.
    }
    return generated;
}

export function shouldDebugSystemPrompt(): boolean {
    return isTruthyEnv(process.env[DEBUG_SYSTEM_PROMPT_ENV]);
}

export function logTransformedSystemPrompt(body: string | undefined): void {
    if (!shouldDebugSystemPrompt()) return;
    if (!body || typeof body !== "string") return;

    try {
        const parsed = JSON.parse(body);
        if (!Object.hasOwn(parsed, "system")) return;
        // Avoid circular import: inline the title-check here
        const isTitleGeneratorText = (text: unknown): boolean => {
            if (typeof text !== "string") return false;
            const lowered = text.trim().toLowerCase();
            return lowered.includes("you are a title generator") || lowered.includes("generate a brief title");
        };

        const system = parsed.system;
        if (
            Array.isArray(system) &&
            system.some(
                (item: { type?: string; text?: string }) => item.type === "text" && isTitleGeneratorText(item.text),
            )
        ) {
            return;
        }

        // The plugin relocates non-CC system blocks into the first user message
        // wrapped in <system-instructions>. Check there too so title-generator
        // requests are still suppressed from the debug log after the relocation
        // pass runs.
        const messages = parsed.messages;
        if (Array.isArray(messages) && messages.length > 0) {
            const firstMsg = messages[0];
            if (firstMsg && firstMsg.role === "user") {
                const content = firstMsg.content;
                if (typeof content === "string" && isTitleGeneratorText(content)) {
                    return;
                }
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (
                            block &&
                            typeof block === "object" &&
                            isTitleGeneratorText((block as { text?: unknown }).text)
                        ) {
                            return;
                        }
                    }
                }
            }
        }

        // eslint-disable-next-line no-console -- explicit debug logger gated by OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT
        console.error(
            "[opencode-anthropic-auth][system-debug] transformed system:",
            JSON.stringify(parsed.system, null, 2),
        );
    } catch {
        // Ignore parse errors in debug logging path.
    }
}
