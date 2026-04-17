/**
 * Side-by-side comparison: plugin output vs the current fallback Claude Code fingerprint.
 * Run: npx vitest run tests/regression/fingerprint/cc-comparison.test.ts
 */
import { describe, expect, it } from "vitest";
import { buildAnthropicBetaHeader } from "../../../src/betas.js";
import { CLAUDE_CODE_IDENTITY_STRING, FALLBACK_CLAUDE_CLI_VERSION } from "../../../src/constants.js";
import { buildAnthropicBillingHeader } from "../../../src/headers/billing.js";
import { buildRequestHeaders } from "../../../src/headers/builder.js";
import { getRequestProfile } from "../../../src/request/profile-resolver.js";
import { buildUserAgent } from "../../../src/headers/user-agent.js";
import { buildSystemPromptBlocks } from "../../../src/system-prompt/builder.js";

describe("fallback Claude Code fingerprint — full request comparison", () => {
    const CC_VERSION = FALLBACK_CLAUDE_CLI_VERSION;
    const signature = {
        enabled: true,
        claudeCliVersion: CC_VERSION,
        promptCompactionMode: "minimal" as const,
        sessionId: "session-123",
    };
    const messages = [{ role: "user", content: "say the word hello" }];

    it("prints the exact fingerprint the plugin would send", () => {
        // Simulate env
        process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "true";
        process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";

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
        console.log("║  EXPECTED FALLBACK VALUES (from source code)             ║");
        console.log("╠══════════════════════════════════════════════════════════╣");
        console.log(`║ CLI version:     ${CC_VERSION}`);
        console.log(`║ User-Agent:      claude-cli/${CC_VERSION} (external, sdk-cli)`);
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
        expect(ua).toBe(`claude-cli/${CC_VERSION} (external, sdk-cli)`);
        expect(billing).toMatch(/cch=[0-9a-f]{5};/);
        expect(billing).toContain("cc_entrypoint=sdk-cli;");
        expect(billing).toMatch(new RegExp(`cc_version=${CC_VERSION.replace(/\./g, "\\.")}\\.[0-9a-f]{3}`));
        expect(betas.split(",")).toContain("oauth-2025-04-20");
        expect(betas.split(",")).not.toContain("managed-agents-2026-04-01");
        expect(CLAUDE_CODE_IDENTITY_STRING).toBe("You are Claude Code, Anthropic's official CLI for Claude.");

        const identityBlock = blocks.find((b) => b.text === CLAUDE_CODE_IDENTITY_STRING);
        expect(identityBlock?.cache_control).toEqual({ type: "ephemeral" });
    });

    it("builds full request headers matching CC", () => {
        process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
        const runtimeProfile = getRequestProfile({ version: signature.claudeCliVersion, forceRefresh: true });

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

        expect(headers.get("user-agent")).toBe(buildUserAgent(runtimeProfile.billing.ccVersion.value));
        expect(headers.get("accept")).toBe("application/json");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        expect(headers.get("x-app")).toBe("cli");
        expect(headers.get("x-stainless-lang")).toBe("js");
        expect(headers.get("x-stainless-runtime")).toBe("node");
        expect(headers.get("x-stainless-runtime-version")).toBe(process.version);
        expect(headers.get("x-stainless-package-version")).toBe("0.81.0");
        expect(headers.get("x-stainless-timeout")).toBe("600");
        expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
        const betaHeader = headers.get("anthropic-beta") ?? "";
        expect(betaHeader).toContain("interleaved-thinking-2025-05-14");
        expect(betaHeader).toContain("context-management-2025-06-27");
        expect(betaHeader).toContain("prompt-caching-scope-2026-01-05");
        expect(betaHeader).not.toContain("advisor-tool-2026-03-01");
        expect(betaHeader).not.toContain("managed-agents-2026-04-01");
        expect(betaHeader).toContain("oauth-2025-04-20");
        expect(headers.get("x-claude-code-session-id")).toBe("session-123");
        expect(headers.get("x-session-affinity")).toBeNull();
    });

    it("ignores incoming anthropic-beta headers in signature mode", () => {
        const headers = buildRequestHeaders(
            "https://api.anthropic.com/v1/messages",
            { headers: { "anthropic-beta": "structured-outputs-2025-11-13,my-custom-beta" } },
            "test-access-token",
            JSON.stringify({ model: "claude-haiku-4-5", messages }),
            new URL("https://api.anthropic.com/v1/messages"),
            signature,
        );

        const betaHeader = headers.get("anthropic-beta") ?? "";
        expect(betaHeader).not.toContain("structured-outputs-2025-11-13");
        expect(betaHeader).not.toContain("my-custom-beta");
        expect(betaHeader).toContain("oauth-2025-04-20");
    });

    it("does not infer Files API usage from plain text that merely mentions user:file_upload", () => {
        const headers = buildRequestHeaders(
            "https://api.anthropic.com/v1/messages",
            { headers: {} },
            "test-access-token",
            JSON.stringify({
                model: "claude-haiku-4-5",
                messages: [{ role: "user", content: "Explain the OAuth scope user:file_upload without using the Files API." }],
            }),
            new URL("https://api.anthropic.com/v1/messages"),
            signature,
        );

        expect(headers.get("anthropic-beta") ?? "").not.toContain("files-api-2025-04-14");
    });

    it("overrides incoming accept and strips session affinity in signature mode", () => {
        const headers = buildRequestHeaders(
            "https://api.anthropic.com/v1/messages",
            { headers: { accept: "*/*", "x-session-affinity": "ses_test_affinity" } },
            "test-access-token",
            JSON.stringify({ model: "claude-haiku-4-5", messages }),
            new URL("https://api.anthropic.com/v1/messages"),
            signature,
        );

        expect(headers.get("accept")).toBe("application/json");
        expect(headers.get("x-session-affinity")).toBeNull();
    });
});
