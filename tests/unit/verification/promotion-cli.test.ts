import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    buildPromotionReviewBundle,
    discoverPendingVerifications,
    renderVerifiedPrDescription,
} from "../../../scripts/verification/promotion-cli.ts";
import type { CandidateManifest, VerificationReport, VerifiedManifest } from "../../../src/fingerprint/types.ts";

const tempDirs = new Set<string>();

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

afterEach(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.add(dir);
    return dir;
}

function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createReport(overrides?: Partial<VerificationReport>): VerificationReport {
    return {
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
                        path: "headers.xApp",
                        ogValue: "cli",
                        pluginValue: "cli",
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
            totalFields: 3,
            matchingFields: 2,
            mismatchedFields: 1,
        },
        ...overrides,
    };
}

describe("promotion-cli", () => {
    it("discovers pending verification reports that are not already referenced by verified manifests", () => {
        const rootDir = createTempDir("promotion-cli-pending-");
        const reportDir = join(rootDir, "reports");
        const candidateDir = join(rootDir, "candidate");
        const verifiedDir = join(rootDir, "verified");
        const pendingReportPath = join(reportDir, "2.1.109-20260415.json");
        const appliedReportPath = join(reportDir, "2.1.108-20260415.json");

        writeJson(join(candidateDir, "2.1.109.json"), candidateManifest);
        writeJson(join(candidateDir, "2.1.108.json"), { ...candidateManifest, version: "2.1.108" });
        writeJson(pendingReportPath, createReport());
        writeJson(appliedReportPath, createReport({ version: "2.1.108" }));
        writeJson(join(verifiedDir, "2.1.108.json"), {
            version: "2.1.108",
            verifiedAt: "2026-04-15T17:32:35.000Z",
            verifiedBy: "trusted-local-verifier",
            scenarioIds: ["minimal-hi"],
            promotedFields: [],
            rejectedCandidateFields: [],
            evidenceArtifacts: [appliedReportPath],
        } satisfies VerifiedManifest);

        const pending = discoverPendingVerifications({ reportDir, candidateDir, verifiedDir, repoRoot: rootDir });

        expect(pending).toHaveLength(1);
        expect(pending[0]).toEqual(
            expect.objectContaining({
                version: "2.1.109",
                reportPath: pendingReportPath,
                candidatePath: join(candidateDir, "2.1.109.json"),
            }),
        );
    });

    it("builds a promotion review bundle with approved, withheld, and auto-rejected fields", () => {
        const bundle = buildPromotionReviewBundle({
            candidate: candidateManifest,
            report: createReport(),
            reportPath: "/tmp/2.1.109-report.json",
            candidatePath: "/tmp/2.1.109-candidate.json",
            reviewedBy: "manual-reviewer",
            approvedPaths: new Set(["headers.userAgent"]),
        });

        expect(bundle.approvedPromotions.map((field) => field.path)).toEqual(["headers.userAgent"]);
        expect(bundle.withheldPromotions).toEqual([
            expect.objectContaining({
                path: "headers.xApp",
                risk: "critical",
                reason: "Held back during manual review",
            }),
        ]);
        expect(bundle.autoRejectedFields).toEqual([
            expect.objectContaining({
                path: "metadata.userIdShape",
                risk: "critical",
                rejectionReason: "Observed OG/plugin mismatch during live verification",
            }),
        ]);
    });

    it("renders a verified-manifest PR description from a review bundle", () => {
        const bundle = buildPromotionReviewBundle({
            candidate: candidateManifest,
            report: createReport(),
            reportPath: "/tmp/2.1.109-report.json",
            candidatePath: "/tmp/2.1.109-candidate.json",
            reviewedBy: "manual-reviewer",
            approvedPaths: new Set(["headers.userAgent"]),
        });

        const description = renderVerifiedPrDescription(bundle);

        expect(description).toContain("## Summary");
        expect(description).toContain("## Changes");
        expect(description).toContain("## Verification Evidence");
        expect(description).toContain("## Risk Assessment");
        expect(description).toContain("## Reviewer Checklist");
        expect(description).toContain("headers.userAgent");
        expect(description).toContain("metadata.userIdShape");
    });
});
