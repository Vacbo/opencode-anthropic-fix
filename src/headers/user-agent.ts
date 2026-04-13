import { CLAUDE_CODE_NPM_LATEST_URL } from "../constants.js";

export function getClaudeEntrypoint(): string {
    return process.env.CLAUDE_CODE_ENTRYPOINT || "cli";
}

export function buildUserAgent(claudeCliVersion: string): string {
    const sdkSuffix = process.env.CLAUDE_AGENT_SDK_VERSION ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}` : "";
    const appSuffix = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
        ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
        : "";
    return `claude-cli/${claudeCliVersion} (external, ${getClaudeEntrypoint()}${sdkSuffix}${appSuffix})`;
}

/**
 * Resolve latest claude-code package version from npm registry.
 * Returns null on timeout/network/parse failures.
 */
export async function fetchLatestClaudeCodeVersion(timeoutMs = 1200): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(CLAUDE_CODE_NPM_LATEST_URL, {
            method: "GET",
            headers: { accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) return null;
        const data = (await response.json()) as Record<string, unknown>;
        if (!data || typeof data !== "object") return null;
        return typeof data.version === "string" && data.version ? data.version : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}
