/**
 * Side-by-side comparison: plugin output vs expected CC 2.1.98 values.
 * Run: npx vitest run src/__tests__/cc-comparison.test.ts
 */
import { describe, expect, it } from "vitest";
import { buildAnthropicBetaHeader } from "../betas.js";
import { CLAUDE_CODE_IDENTITY_STRING, FALLBACK_CLAUDE_CLI_VERSION } from "../constants.js";
import { buildAnthropicBillingHeader } from "../headers/billing.js";
import { buildRequestHeaders } from "../headers/builder.js";
import { buildUserAgent } from "../headers/user-agent.js";
import { buildSystemPromptBlocks } from "../system-prompt/builder.js";

describe("CC 2.1.98 — Full request fingerprint comparison", () => {
    const CC_VERSION = "2.1.98";
    const signature = { enabled: true, claudeCliVersion: CC_VERSION, promptCompactionMode: "minimal" as const };
    const messages = [{ role: "user", content: "say the word hello" }];

    it("prints the exact fingerprint the plugin would send", () => {
        // Simulate env
        process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "true";
        process.env.CLAUDE_CODE_ENTRYPOINT = "cli";

        const ua = buildUserAgent(CC_VERSION);
        const billing = buildAnthropicBillingHeader(CC_VERSION, messages);
        const betas = buildAnthropicBetaHeader(
            "",
            true,
            "claude-haiku-4-5",
            "anthropic",
            undefined,
            undefined,
            "/v1/messages",
            false,
        );
        const blocks = buildSystemPromptBlocks([], signature, messages);

        console.log("\n╔══════════════════════════════════════════════════════════╗");
        console.log("║  PLUGIN FINGERPRINT (what opencode sends)               ║");
        console.log("╠══════════════════════════════════════════════════════════╣");
        console.log(`║ CLI version:     ${FALLBACK_CLAUDE_CLI_VERSION}`);
        console.log(`║ User-Agent:      ${ua}`);
        console.log(`║ anthropic-beta:  ${betas}`);
        console.log(`║ Billing header:  ${billing}`);
        console.log(`║ Identity:        ${CLAUDE_CODE_IDENTITY_STRING}`);
        console.log("║");
        console.log("║ System prompt blocks:");
        for (const b of blocks) {
            const preview = b.text.length > 80 ? b.text.slice(0, 80) + "..." : b.text;
            console.log(`║   [${b.cache_control ? JSON.stringify(b.cache_control) : "no-cache"}] ${preview}`);
        }
        console.log("╠══════════════════════════════════════════════════════════╣");
        console.log("║  EXPECTED CC 2.1.98 VALUES (from source code)           ║");
        console.log("╠══════════════════════════════════════════════════════════╣");
        console.log(`║ CLI version:     2.1.98`);
        console.log(`║ User-Agent:      claude-cli/2.1.98 (external, cli)`);
        console.log(`║ SDK version:     0.81.0 (x-stainless-package-version)`);
        console.log(`║ Axios version:   1.13.6 (token endpoint UA)`);
        console.log(`║ anthropic-ver:   2023-06-01`);
        console.log(`║ x-app:           cli`);
        console.log(`║ cch:             00000 placeholder → xxHash64(serialized body, seed 0x6E52736AC806831E)`);
        console.log(`║ Identity:        You are Claude Code, Anthropic's official CLI for Claude.`);
        console.log(`║ Identity cache:  {"type":"ephemeral","scope":"global","ttl":"1h"}`);
        console.log(`║ Client ID:       9d1c250a-e61b-44d9-88ed-5944d1962f5e`);
        console.log("╚══════════════════════════════════════════════════════════╝");

        // Assertions
        expect(FALLBACK_CLAUDE_CLI_VERSION).toBe("2.1.98");
        expect(ua).toBe("claude-cli/2.1.98 (external, cli)");
        expect(billing).toMatch(/cch=[0-9a-f]{5};/);
        expect(billing).toContain("cc_entrypoint=cli;");
        expect(billing).toMatch(/cc_version=2\.1\.98\.[0-9a-f]{3}/);
        expect(betas.split(",")).toContain("oauth-2025-04-20");
        expect(CLAUDE_CODE_IDENTITY_STRING).toBe("You are Claude Code, Anthropic's official CLI for Claude.");

        const identityBlock = blocks.find((b) => b.text === CLAUDE_CODE_IDENTITY_STRING);
        expect(identityBlock?.cache_control).toEqual({ type: "ephemeral" });
    });

    it("builds full request headers matching CC", () => {
        process.env.CLAUDE_CODE_ENTRYPOINT = "cli";

        const headers = buildRequestHeaders(
            "https://api.anthropic.com/v1/messages",
            { headers: {} },
            "test-access-token",
            JSON.stringify({ model: "claude-haiku-4-5", messages }),
            new URL("https://api.anthropic.com/v1/messages"),
            signature,
        );

        console.log("\n╔══════════════════════════════════════════════════════════╗");
        console.log("║  FULL REQUEST HEADERS                                    ║");
        console.log("╠══════════════════════════════════════════════════════════╣");
        headers.forEach((value, key) => {
            if (key === "authorization") value = "Bearer ***redacted***";
            console.log(`║ ${key}: ${value}`);
        });
        console.log("╚══════════════════════════════════════════════════════════╝");

        expect(headers.get("user-agent")).toBe("claude-cli/2.1.98 (external, cli)");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        expect(headers.get("x-app")).toBe("cli");
        expect(headers.get("x-stainless-lang")).toBe("js");
        expect(headers.get("x-stainless-runtime")).toBe("node");
        expect(headers.get("x-stainless-package-version")).toBe("0.81.0");
        expect(headers.get("x-stainless-timeout")).toBe("600");
        expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
        expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    });
});
