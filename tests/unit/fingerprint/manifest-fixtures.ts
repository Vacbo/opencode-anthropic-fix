import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
    CandidateManifest,
    ManifestIndex,
    VerifiedField,
    VerifiedManifest,
} from "../../../src/fingerprint/types.ts";

const FIXTURE_TIMESTAMP = "2026-04-15T17:32:35.000Z";

function getManifestDirectory(root: string, tier: "candidate" | "verified"): string {
    return join(root, tier, "claude-code");
}

export function createCandidateManifest(version: string): CandidateManifest {
    return {
        version,
        source: {
            npmPackage: "@anthropic-ai/claude-code",
            tarballUrl: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${version}.tgz`,
            tarballHash: `sha256:${version.split(".").join("")}`,
            extractionTimestamp: FIXTURE_TIMESTAMP,
        },
        transport: {
            pathStyle: {
                value: "/v1/messages?beta=true",
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "high",
            },
            defaultHeaders: {
                value: { "content-type": "application/json" },
                risk: "low-risk",
                origin: "bundle-string",
                confidence: "high",
            },
            authHeaderMode: {
                value: "bearer",
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
        },
        headers: {
            userAgent: {
                value: `claude-cli/${version} (external, cli)`,
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
            xApp: {
                value: "cli",
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
            xStainlessHeaders: {
                value: {
                    "x-stainless-arch": "arm64",
                    "x-stainless-lang": "js",
                },
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "medium",
            },
            xClientRequestId: {
                value: "x-client-request-id",
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "high",
            },
            xClaudeCodeSessionId: {
                value: "X-Claude-Code-Session-Id",
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "high",
            },
        },
        betas: {
            requiredBaseBetas: {
                value: ["oauth-2025-04-20"],
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
            optionalBetas: {
                value: ["claude-code-20250219"],
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "medium",
            },
            authModeBetas: {
                value: ["oauth-2025-04-20"],
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
        },
        billing: {
            ccVersion: {
                value: version,
                risk: "low-risk",
                origin: "bundle-string",
                confidence: "high",
            },
            ccEntrypoint: {
                value: "cli",
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
            cchStrategy: {
                value: "xxhash64",
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
        },
        body: {
            defaultStream: {
                value: true,
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
            defaultMaxTokens: {
                value: 4096,
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
            temperaturePresence: {
                value: false,
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "medium",
            },
            thinkingKey: {
                value: true,
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "medium",
            },
            contextManagementKey: {
                value: true,
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "medium",
            },
            toolsKey: {
                value: true,
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "medium",
            },
        },
        prompt: {
            identityString: {
                value: "You are Claude Code, Anthropic's official CLI for Claude.",
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
            billingBlockPlacement: {
                value: "prepend",
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
            appendMode: {
                value: false,
                risk: "critical",
                origin: "bundle-string",
                confidence: "medium",
            },
            cacheControlBehavior: {
                value: "default",
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "medium",
            },
        },
        metadata: {
            userIdShape: {
                value: "oauth:<account_id>",
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
            deviceLinkage: {
                value: "default",
                risk: "low-risk",
                origin: "bundle-string",
                confidence: "medium",
            },
            accountLinkage: {
                value: "default",
                risk: "low-risk",
                origin: "bundle-string",
                confidence: "medium",
            },
        },
        parserWarnings: [],
        unknownFields: [],
    };
}

export function createVerifiedManifest(version: string, promotedFields: VerifiedField[] = []): VerifiedManifest {
    return {
        version,
        verifiedAt: FIXTURE_TIMESTAMP,
        verifiedBy: "unit-test-runner",
        scenarioIds: ["minimal-hi"],
        promotedFields,
        rejectedCandidateFields: [],
        evidenceArtifacts: [],
    };
}

export function writeManifestIndex(
    root: string,
    tier: "candidate" | "verified",
    versions: string[],
    latest?: string | null,
): void {
    const manifestDirectory = getManifestDirectory(root, tier);
    mkdirSync(manifestDirectory, { recursive: true });

    const index: ManifestIndex = {
        schemaVersion: "1.0.0",
        lastUpdated: FIXTURE_TIMESTAMP,
        versions: versions.map((version) => ({
            version,
            path: `${version}.json`,
            createdAt: FIXTURE_TIMESTAMP,
        })),
        latest: latest === undefined ? (versions[versions.length - 1] ?? null) : latest,
    };

    writeFileSync(join(manifestDirectory, "index.json"), JSON.stringify(index, null, 2) + "\n", "utf-8");
}

export function writeCandidateManifest(root: string, manifest: CandidateManifest): void {
    const manifestDirectory = getManifestDirectory(root, "candidate");
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(
        join(manifestDirectory, `${manifest.version}.json`),
        JSON.stringify(manifest, null, 2) + "\n",
        "utf-8",
    );
}

export function writeVerifiedManifest(root: string, manifest: VerifiedManifest): void {
    const manifestDirectory = getManifestDirectory(root, "verified");
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(
        join(manifestDirectory, `${manifest.version}.json`),
        JSON.stringify(manifest, null, 2) + "\n",
        "utf-8",
    );
}
