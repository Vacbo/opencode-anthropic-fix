import { describe, expect, it } from "vitest";

import {
    compareScenarioFields,
    extractComparableFields,
    parseArgs,
    sanitizeCapture,
    type CaptureRecord,
    type ScenarioDefinition,
} from "../../../scripts/verification/run-live-verification.ts";

function createCapture(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
    return {
        capturedAt: "2026-04-15T17:32:35.000Z",
        method: "POST",
        url: "https://api.anthropic.com:443/v1/messages?beta=true",
        path: "/v1/messages?beta=true",
        headers: {
            authorization: "Bearer secret-token",
            "anthropic-beta": "oauth-2025-04-20,tool-examples-2025-10-29",
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
            "content-type": "application/json",
            "user-agent": "claude-cli/2.1.109",
            "x-app": "cli",
            "x-stainless-lang": "js",
            "x-stainless-runtime": "node",
            "x-client-request-id": "c1b8af4a-2a2f-4c2d-9b71-6fa57fcb3f90",
            "x-claude-code-session-id": "9bb5f247-3d72-4619-a980-c4c05ccf488f",
        },
        bodyText: "{}",
        parsedBody: {
            stream: true,
            max_tokens: 4096,
            tools: [{ name: "tool_search" }],
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "hi" }],
                },
            ],
            metadata: {
                user_id: JSON.stringify({
                    device_id: "device-1",
                    account_uuid: "account-1",
                    session_id: "session-1",
                }),
            },
            system: [
                {
                    type: "text",
                    text: "x-anthropic-billing-header: cc_version=2.1.109.abc; cc_entrypoint=cli; cch=abc12;",
                },
                {
                    type: "text",
                    text: "You are Claude Code, Anthropic's official CLI for Claude.",
                    cache_control: { type: "ephemeral" },
                },
            ],
        },
        ...overrides,
    };
}

describe("run-live-verification", () => {
    it("parses args with default manifest path", () => {
        const parsed = parseArgs(["--version", "2.1.109", "--scenario", "minimal-hi,tool-search"]);

        expect(parsed.version).toBe("2.1.109");
        expect(parsed.scenarioIds).toEqual(["minimal-hi", "tool-search"]);
        expect(parsed.candidatePath).toContain("manifests/candidate/claude-code/2.1.109.json");
    });

    it("extracts comparable fields without leaking dynamic metadata values", () => {
        const fields = extractComparableFields(createCapture());

        expect(fields["transport.pathStyle"]).toBe("/v1/messages?beta=true");
        expect(fields["betas.requiredBaseBetas"]).toEqual(["oauth-2025-04-20"]);
        expect(fields["betas.optionalBetas"]).toEqual(["tool-examples-2025-10-29"]);
        expect(fields["billing.ccVersion"]).toBe("2.1.109");
        expect(fields["metadata.userIdShape"]).toBe("json:account_uuid+device_id+session_id");
        expect(fields["metadata.deviceLinkage"]).toBe("metadata.user_id.device_id");
        expect(fields["prompt.cacheControlBehavior"]).toBe("ephemeral-identity-block");
    });

    it("classifies compared fields with schema risk levels", () => {
        const scenario: ScenarioDefinition = {
            id: "minimal-hi",
            name: "Minimal Greeting",
            description: "",
            prompt: "hi",
            expectedBehavior: "",
            requiredFields: ["headers.userAgent", "metadata.userIdShape"],
        };

        const results = compareScenarioFields(
            scenario,
            createCapture(),
            createCapture({ headers: { ...createCapture().headers, "user-agent": "claude-cli/2.1.110" } }),
        );

        expect(results).toEqual([
            expect.objectContaining({ path: "headers.userAgent", match: false, severity: "critical" }),
            expect.objectContaining({ path: "metadata.userIdShape", match: true, severity: "critical" }),
        ]);
    });

    it("sanitizes captures before writing reports", () => {
        const sanitized = sanitizeCapture(createCapture());

        expect(sanitized).toEqual(
            expect.objectContaining({
                headers: expect.objectContaining({
                    authorization: "Bearer <redacted>",
                    "x-client-request-id": "<redacted-id>",
                    "x-claude-code-session-id": "<redacted-id>",
                }),
            }),
        );
    });
});
