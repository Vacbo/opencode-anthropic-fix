import { describe, expect, it } from "vitest";

import { buildFieldDecision } from "../../../scripts/verification/promote-verified.ts";
import type { CandidateManifest, VerificationReport } from "../../../src/fingerprint/types.ts";

const candidateManifest: CandidateManifest = {
    version: "2.1.109",
    source: {
        npmPackage: "@anthropic-ai/claude-code",
        tarballUrl: "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.109.tgz",
        tarballHash: "sha256:test",
        extractionTimestamp: "2026-04-15T17:32:35.000Z",
    },
    transport: {
        pathStyle: { value: "/v1/messages?beta=true", risk: "sensitive", origin: "bundle-string", confidence: "high" },
        defaultHeaders: { value: {}, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
        authHeaderMode: { value: "bearer", risk: "critical", origin: "bundle-string", confidence: "high" },
    },
    headers: {
        userAgent: { value: "claude-cli/2.1.109", risk: "critical", origin: "bundle-string", confidence: "high" },
        xApp: { value: "cli", risk: "critical", origin: "bundle-string", confidence: "high" },
        xStainlessHeaders: { value: {}, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
        xClientRequestId: {
            value: "x-client-request-id",
            risk: "sensitive",
            origin: "bundle-string",
            confidence: "medium",
        },
        xClaudeCodeSessionId: {
            value: "X-Claude-Code-Session-Id",
            risk: "sensitive",
            origin: "bundle-string",
            confidence: "medium",
        },
    },
    betas: {
        requiredBaseBetas: {
            value: ["oauth-2025-04-20"],
            risk: "critical",
            origin: "bundle-string",
            confidence: "high",
        },
        optionalBetas: { value: [], risk: "sensitive", origin: "bundle-string", confidence: "medium" },
        authModeBetas: { value: ["oauth-2025-04-20"], risk: "critical", origin: "bundle-string", confidence: "high" },
    },
    billing: {
        ccVersion: { value: "2.1.109", risk: "low-risk", origin: "bundle-string", confidence: "high" },
        ccEntrypoint: { value: "cli", risk: "critical", origin: "bundle-string", confidence: "high" },
        cchStrategy: { value: "xxhash64-5hex", risk: "critical", origin: "bundle-string", confidence: "high" },
    },
    body: {
        defaultStream: { value: true, risk: "critical", origin: "bundle-string", confidence: "high" },
        defaultMaxTokens: { value: 4096, risk: "critical", origin: "bundle-string", confidence: "high" },
        temperaturePresence: { value: false, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
        thinkingKey: { value: true, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
        contextManagementKey: { value: true, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
        toolsKey: { value: true, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
    },
    prompt: {
        identityString: {
            value: "You are Claude Code, Anthropic's official CLI for Claude.",
            risk: "critical",
            origin: "bundle-string",
            confidence: "high",
        },
        billingBlockPlacement: { value: "prepend", risk: "critical", origin: "bundle-string", confidence: "high" },
        appendMode: { value: false, risk: "critical", origin: "bundle-string", confidence: "medium" },
        cacheControlBehavior: {
            value: "ephemeral-identity-block",
            risk: "critical",
            origin: "bundle-string",
            confidence: "high",
        },
    },
    metadata: {
        userIdShape: {
            value: "json:account_uuid+device_id+session_id",
            risk: "critical",
            origin: "bundle-string",
            confidence: "high",
        },
        deviceLinkage: {
            value: "metadata.user_id.device_id",
            risk: "low-risk",
            origin: "bundle-string",
            confidence: "medium",
        },
        accountLinkage: {
            value: "metadata.user_id.account_uuid",
            risk: "low-risk",
            origin: "bundle-string",
            confidence: "medium",
        },
    },
    parserWarnings: [],
    unknownFields: [],
};

describe("promote-verified", () => {
    it("promotes fields whose candidate values match live verification", () => {
        const report: VerificationReport = {
            version: "2.1.109",
            verifiedAt: "2026-04-15T17:32:35.000Z",
            verifiedBy: "trusted-local-verifier",
            scenarioResults: [
                {
                    scenarioId: "minimal-hi",
                    passed: false,
                    ogCapture: null,
                    pluginCapture: null,
                    fieldResults: [
                        {
                            path: "headers.userAgent",
                            ogValue: "claude-cli/2.1.109",
                            pluginValue: "claude-cli/2.1.109",
                            match: true,
                            severity: "critical",
                        },
                        {
                            path: "metadata.userIdShape",
                            ogValue: "json:account_uuid+device_id+session_id",
                            pluginValue: "json:device_id+session_id",
                            match: false,
                            severity: "critical",
                        },
                    ],
                },
            ],
            summary: {
                totalScenarios: 1,
                passedScenarios: 0,
                failedScenarios: 1,
                totalFields: 2,
                matchingFields: 1,
                mismatchedFields: 1,
            },
        };

        const decision = buildFieldDecision(
            candidateManifest,
            report,
            "trusted-local-verifier",
            "artifacts/report.json",
        );

        expect(decision.promoted).toEqual([
            expect.objectContaining({
                path: "headers.userAgent",
                value: "claude-cli/2.1.109",
                scenarioIds: ["minimal-hi"],
            }),
        ]);
        expect(decision.rejected).toEqual([
            expect.objectContaining({
                path: "metadata.userIdShape",
                rejectionReason: "Observed OG/plugin mismatch during live verification",
            }),
        ]);
    });

    it("rejects fields when the candidate manifest disagrees with the live value", () => {
        const report: VerificationReport = {
            version: "2.1.109",
            verifiedAt: "2026-04-15T17:32:35.000Z",
            verifiedBy: "trusted-local-verifier",
            scenarioResults: [
                {
                    scenarioId: "append-system-prompt",
                    passed: true,
                    ogCapture: null,
                    pluginCapture: null,
                    fieldResults: [
                        {
                            path: "prompt.appendMode",
                            ogValue: true,
                            pluginValue: true,
                            match: true,
                            severity: "critical",
                        },
                    ],
                },
            ],
            summary: {
                totalScenarios: 1,
                passedScenarios: 1,
                failedScenarios: 0,
                totalFields: 1,
                matchingFields: 1,
                mismatchedFields: 0,
            },
        };

        const decision = buildFieldDecision(
            candidateManifest,
            report,
            "trusted-local-verifier",
            "artifacts/report.json",
        );

        expect(decision.promoted).toEqual([]);
        expect(decision.rejected).toEqual([
            expect.objectContaining({
                path: "prompt.appendMode",
                rejectionReason: "Candidate manifest value does not match live verified value",
            }),
        ]);
    });

    it("can limit promotion output to an approved field subset", () => {
        const report: VerificationReport = {
            version: "2.1.109",
            verifiedAt: "2026-04-15T17:32:35.000Z",
            verifiedBy: "trusted-local-verifier",
            scenarioResults: [
                {
                    scenarioId: "minimal-hi",
                    passed: true,
                    ogCapture: null,
                    pluginCapture: null,
                    fieldResults: [
                        {
                            path: "headers.userAgent",
                            ogValue: "claude-cli/2.1.109",
                            pluginValue: "claude-cli/2.1.109",
                            match: true,
                            severity: "critical",
                        },
                        {
                            path: "headers.xApp",
                            ogValue: "cli",
                            pluginValue: "cli",
                            match: true,
                            severity: "critical",
                        },
                    ],
                },
            ],
            summary: {
                totalScenarios: 1,
                passedScenarios: 1,
                failedScenarios: 0,
                totalFields: 2,
                matchingFields: 2,
                mismatchedFields: 0,
            },
        };

        const decision = buildFieldDecision(
            candidateManifest,
            report,
            "trusted-local-verifier",
            "artifacts/report.json",
            {
                onlyPaths: new Set(["headers.userAgent"]),
            },
        );

        expect(decision.promoted.map((field) => field.path)).toEqual(["headers.userAgent"]);
        expect(decision.rejected).toEqual([]);
    });
});
