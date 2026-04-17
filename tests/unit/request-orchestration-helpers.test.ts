import { describe, expect, it, vi } from "vitest";

import { createRequestOrchestrationHelpers } from "../../src/request-orchestration-helpers.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

describe("request orchestration title suppression", () => {
    it("handles title-generation requests locally when disabled", async () => {
        const deps = {
            config: { ...DEFAULT_CONFIG, disable_title_generation_request: true },
            debugLog: vi.fn(),
            toast: vi.fn(async () => undefined),
            getAccountManager: vi.fn(() => null),
            getClaudeCliVersion: vi.fn(() => "2.1.111"),
            getInitialAccountPinned: vi.fn(() => false),
            getLastToastedIndex: vi.fn(() => -1),
            setLastToastedIndex: vi.fn(),
            fileAccountMap: new Map(),
            forwardRequest: vi.fn(async () => new Response("should not be called")),
            parseRefreshFailure: vi.fn(),
            refreshAccountTokenSingleFlight: vi.fn(),
            maybeRefreshIdleAccounts: vi.fn(),
            signatureEmulationEnabled: true,
            promptCompactionMode: "minimal" as const,
            signatureSanitizeSystemPrompt: false,
            getSignatureSessionId: vi.fn(() => "session-123"),
            signatureUserId: "user-123",
        };

        const { executeOAuthFetch } = createRequestOrchestrationHelpers(deps as never);

        const response = await executeOAuthFetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            body: JSON.stringify({
                model: "claude-haiku-4-5-20251001",
                messages: [{ role: "user", content: "hi there" }],
                system: [
                    {
                        type: "text",
                        text: 'Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. Return JSON with a single "title" field.',
                    },
                ],
                output_config: { format: { type: "json_schema" } },
            }),
        });

        const text = await response.text();
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(text).toContain("message_start");
        expect(text).toContain('{\\"title\\":\\"hi there\\"}');
        expect(deps.forwardRequest).not.toHaveBeenCalled();
    });
});
