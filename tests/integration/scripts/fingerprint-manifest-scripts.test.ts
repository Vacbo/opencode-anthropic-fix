import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import type { CandidateManifest } from "../../../src/fingerprint/types.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFilePath), "..", "..", "..");
const buildManifestScriptPath = join(projectRoot, "scripts", "analysis", "build-candidate-manifest.ts");
const diffManifestScriptPath = join(projectRoot, "scripts", "analysis", "diff-manifests.ts");

const tempPathsToRemove = new Set<string>();

afterEach(() => {
    for (const path of tempPathsToRemove) {
        rmSync(path, { recursive: true, force: true });
    }

    tempPathsToRemove.clear();
});

function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempPathsToRemove.add(dir);
    return dir;
}

function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, "utf8")) as T;
}

function runBunScript(scriptPath: string, args: string[]): string {
    return execFileSync("bun", [scriptPath, ...args], {
        cwd: projectRoot,
        encoding: "utf8",
    });
}

function createCandidateManifest(overrides?: Partial<CandidateManifest>): CandidateManifest {
    return {
        version: "2.1.108",
        source: {
            npmPackage: "@anthropic-ai/claude-code",
            tarballUrl: "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.108.tgz",
            tarballHash: "unknown",
            extractionTimestamp: "2026-04-15T17:32:35.000Z",
        },
        transport: {
            pathStyle: {
                value: "/v1/messages?beta=true",
                risk: "sensitive",
                origin: "bundle-heuristic",
                confidence: "medium",
            },
            defaultHeaders: {
                value: { "content-type": "application/json" },
                risk: "sensitive",
                origin: "bundle-heuristic",
                confidence: "medium",
            },
            authHeaderMode: {
                value: "bearer",
                risk: "critical",
                origin: "bundle-heuristic",
                confidence: "medium",
            },
        },
        headers: {
            userAgent: {
                value: "claude-cli/2.1.108 (external)",
                risk: "critical",
                origin: "bundle-string",
                confidence: "high",
            },
            xApp: {
                value: "cli",
                risk: "critical",
                origin: "bundle-heuristic",
                confidence: "medium",
            },
            xStainlessHeaders: {
                value: {
                    "x-stainless-arch": "arm64",
                    "x-stainless-lang": "js",
                },
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "high",
            },
            xClientRequestId: {
                value: "x-client-request-id",
                risk: "sensitive",
                origin: "bundle-heuristic",
                confidence: "medium",
            },
            xClaudeCodeSessionId: {
                value: "X-Claude-Code-Session-Id",
                risk: "sensitive",
                origin: "bundle-heuristic",
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
            optionalBetas: {
                value: ["claude-code-20250219"],
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "high",
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
                value: "2.1.108",
                risk: "low-risk",
                origin: "bundle-heuristic",
                confidence: "high",
            },
            ccEntrypoint: {
                value: "cli",
                risk: "critical",
                origin: "bundle-heuristic",
                confidence: "medium",
            },
            cchStrategy: {
                value: "xxhash64-5hex",
                risk: "low-risk",
                origin: "bundle-string",
                confidence: "medium",
            },
        },
        body: {
            defaultStream: {
                value: true,
                risk: "critical",
                origin: "bundle-heuristic",
                confidence: "medium",
            },
            defaultMaxTokens: {
                value: 4096,
                risk: "critical",
                origin: "bundle-heuristic",
                confidence: "medium",
            },
            temperaturePresence: {
                value: false,
                risk: "low-risk",
                origin: "bundle-heuristic",
                confidence: "low",
            },
            thinkingKey: {
                value: true,
                risk: "low-risk",
                origin: "bundle-heuristic",
                confidence: "low",
            },
            contextManagementKey: {
                value: true,
                risk: "low-risk",
                origin: "bundle-heuristic",
                confidence: "low",
            },
            toolsKey: {
                value: true,
                risk: "low-risk",
                origin: "bundle-heuristic",
                confidence: "low",
            },
        },
        prompt: {
            identityString: {
                value: "You are Claude Code, Anthropic's official CLI for Claude.",
                risk: "critical",
                origin: "bundle-heuristic",
                confidence: "medium",
            },
            billingBlockPlacement: {
                value: "prepend",
                risk: "critical",
                origin: "bundle-heuristic",
                confidence: "medium",
            },
            appendMode: {
                value: false,
                risk: "low-risk",
                origin: "bundle-heuristic",
                confidence: "low",
            },
            cacheControlBehavior: {
                value: "ephemeral-identity-block",
                risk: "critical",
                origin: "bundle-heuristic",
                confidence: "low",
            },
        },
        metadata: {
            userIdShape: {
                value: "user_<persistentUserId>_account_<accountId>_session_<sessionId>",
                risk: "critical",
                origin: "bundle-heuristic",
                confidence: "low",
            },
            deviceLinkage: {
                value: "persistentUserId",
                risk: "low-risk",
                origin: "bundle-heuristic",
                confidence: "low",
            },
            accountLinkage: {
                value: "accountUuid-or-id",
                risk: "low-risk",
                origin: "bundle-heuristic",
                confidence: "low",
            },
        },
        parserWarnings: [],
        unknownFields: [],
        ...overrides,
    };
}

describe("fingerprint manifest scripts", () => {
    it("build-candidate-manifest accepts a raw cli.js input and extracts the fingerprint automatically", () => {
        const tempDir = createTempDir("fingerprint-manifest-cli-input-");
        const cliPath = join(tempDir, "cli-2.1.109.js");
        const outputDir = join(tempDir, "candidate-manifests");

        writeFileSync(
            cliPath,
            [
                'const CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e";',
                'const UA="claude-cli/2.1.109 (external, cli)";',
                'const SDK="0.81.0";',
                'const BETA="oauth-2025-04-20";',
                'const BILLING="cch=00000";',
                'const OAUTH="/v1/oauth/token";',
                'const AUTH="/oauth/authorize";',
                'const PLATFORM="https://platform.claude.com";',
                'const CLAUDE_AI="https://claude.ai";',
                'const SCOPE="user:inference";',
                'const STAINLESS="x-stainless-runtime";',
                'const PKCE="code_challenge_method";',
                'const METHOD="S256";',
                'const VERIFIER="code_verifier";',
                'const CHALLENGE="code_challenge";',
            ].join("\n"),
            "utf8",
        );

        const stdout = runBunScript(buildManifestScriptPath, [
            cliPath,
            "--version",
            "2.1.109",
            "--output",
            outputDir,
        ]);

        const result = JSON.parse(stdout) as { manifestPath: string; indexPath: string; version: string };
        const manifest = readJson<CandidateManifest>(join(outputDir, "2.1.109.json"));

        expect(result.version).toBe("2.1.109");
        expect(result.manifestPath).toBe(join(outputDir, "2.1.109.json"));
        expect(manifest.source.npmPackage).toBe("@anthropic-ai/claude-code");
        expect(manifest.headers.userAgent.value).toContain("claude-cli/2.1.109");
        expect(manifest.betas.requiredBaseBetas.value).toContain("oauth-2025-04-20");
    });

    it("build-candidate-manifest writes a versioned manifest and updates the index", () => {
        const tempDir = createTempDir("fingerprint-manifest-build-");
        const fingerprintPath = join(tempDir, "fingerprint.json");
        const outputDir = join(tempDir, "candidate-manifests");

        writeJson(fingerprintPath, {
            version: "2.1.109",
            extractedAt: "2026-04-15T17:32:35.000Z",
            oauth: {
                clientIds: ["9d1c250a-e61b-44d9-88ed-5944d1962f5e"],
                scopes: ["user:inference", "org:create_api_key"],
                endpoints: {
                    platformBase: "https://platform.claude.com",
                    claudeAi: "https://claude.ai",
                    tokenEndpoint: "/v1/oauth/token",
                    authorizeEndpoint: "/oauth/authorize",
                },
                pkce: {
                    hasCodeChallenge: true,
                    hasCodeVerifier: true,
                    method: "S256",
                    s256Confirmed: true,
                },
            },
            headers: {
                userAgent: {
                    template: "claude-cli/2.1.109 (external)",
                    hasExternal: true,
                },
                sdkVersion: "0.81.0",
                axiosVersion: "1.13.1",
                stainlessHeaders: {
                    "x-stainless-arch": "arm64",
                    "x-stainless-lang": "js",
                    "x-stainless-package-version": "0.81.0",
                    "x-stainless-runtime": "node",
                    "x-stainless-runtime-version": "v24.0.0",
                    "x-stainless-timeout": "600",
                },
            },
            betas: {
                betas: ["oauth-2025-04-20", "claude-code-20250219", "managed-agents-2026-04-01"],
                bedrockUnsupported: ["interleaved-thinking-2025-05-14"],
                oauthBeta: "oauth-2025-04-20",
                oauthBetas: ["oauth-2025-04-20"],
            },
            billing: {
                cch: "cch=00000",
                allCchValues: ["cch=00000"],
                salt: "59cf53e54c78",
                allSalts: ["59cf53e54c78"],
                template: "cch=${hash}",
                allTemplates: ["cch=${hash}"],
                hashPositions: [{ start: 4, end: 7 }],
            },
        });

        const stdout = runBunScript(buildManifestScriptPath, [
            fingerprintPath,
            "--version",
            "2.1.109",
            "--output",
            outputDir,
        ]);

        const result = JSON.parse(stdout) as { manifestPath: string; indexPath: string; version: string };
        const manifest = readJson<CandidateManifest>(join(outputDir, "2.1.109.json"));
        const index = readJson<{
            latest: string | null;
            versions: Array<{ version: string; path: string }>;
        }>(join(outputDir, "index.json"));

        expect(result.version).toBe("2.1.109");
        expect(result.manifestPath).toBe(join(outputDir, "2.1.109.json"));
        expect(manifest.headers.userAgent.value).toContain("claude-cli/2.1.109");
        expect(manifest.headers.userAgent.origin).toBe("bundle-string");
        expect(manifest.headers.xApp.value).toBe("cli");
        expect(manifest.headers.xApp.origin).toBe("bundle-heuristic");
        expect(manifest.betas.requiredBaseBetas.value).toEqual(["oauth-2025-04-20"]);
        expect(manifest.betas.optionalBetas.value).toContain("claude-code-20250219");
        expect(manifest.source.tarballUrl).toContain("claude-code-2.1.109.tgz");
        expect(index.latest).toBe("2.1.109");
        expect(index.versions).toContainEqual(
            expect.objectContaining({
                version: "2.1.109",
                path: "2.1.109.json",
            }),
        );
    });

    it("diff-manifests writes reports and exits with code 2 for critical changes", () => {
        const tempDir = createTempDir("fingerprint-manifest-diff-");
        const oldManifestPath = join(tempDir, "old.json");
        const newManifestPath = join(tempDir, "new.json");
        const jsonOutputPath = join(tempDir, "diff.json");
        const markdownOutputPath = join(tempDir, "diff.md");

        writeJson(oldManifestPath, createCandidateManifest());
        writeJson(
            newManifestPath,
            createCandidateManifest({
                version: "2.1.109",
                headers: {
                    ...createCandidateManifest().headers,
                    userAgent: {
                        ...createCandidateManifest().headers.userAgent,
                        value: "claude-cli/2.1.109 (external)",
                    },
                },
            }),
        );

        const result = spawnSync(
            "bun",
            [
                diffManifestScriptPath,
                oldManifestPath,
                newManifestPath,
                "--json-output",
                jsonOutputPath,
                "--markdown-output",
                markdownOutputPath,
            ],
            {
                cwd: projectRoot,
                encoding: "utf8",
            },
        );

        expect(result.status).toBe(2);

        const diffReport = readJson<{
            summary: { critical: number; sensitive: number; lowRisk: number; total: number };
            changes: Array<{ path: string; severity: string }>;
        }>(jsonOutputPath);
        const markdownSummary = readFileSync(markdownOutputPath, "utf8");

        expect(diffReport.summary.critical).toBeGreaterThan(0);
        expect(diffReport.changes).toContainEqual(
            expect.objectContaining({
                path: "headers.userAgent.value",
                severity: "critical",
            }),
        );
        expect(markdownSummary).toContain("## Critical changes");
        expect(markdownSummary).toContain("headers.userAgent.value");
    });

    it("diff-manifests ignores extraction bookkeeping fields", () => {
        const tempDir = createTempDir("fingerprint-manifest-bookkeeping-");
        const oldManifestPath = join(tempDir, "old.json");
        const newManifestPath = join(tempDir, "new.json");
        const jsonOutputPath = join(tempDir, "diff.json");

        const oldManifest = createCandidateManifest();
        const newManifest = createCandidateManifest({
            source: {
                ...oldManifest.source,
                extractionTimestamp: "2026-04-16T09:00:00.000Z",
            },
            transport: {
                ...oldManifest.transport,
                pathStyle: {
                    ...oldManifest.transport.pathStyle,
                    extractedAt: "2026-04-16T09:00:00.000Z",
                },
            },
            headers: {
                ...oldManifest.headers,
                userAgent: {
                    ...oldManifest.headers.userAgent,
                    extractedAt: "2026-04-16T09:00:00.000Z",
                },
            },
        });

        writeJson(oldManifestPath, oldManifest);
        writeJson(newManifestPath, newManifest);

        const result = spawnSync(
            "bun",
            [diffManifestScriptPath, oldManifestPath, newManifestPath, "--json-output", jsonOutputPath],
            {
                cwd: projectRoot,
                encoding: "utf8",
            },
        );

        expect(result.status).toBe(0);

        const diffReport = readJson<{
            summary: { critical: number; sensitive: number; lowRisk: number; total: number };
            changes: Array<{ path: string; severity: string }>;
        }>(jsonOutputPath);

        expect(diffReport.summary.total).toBe(0);
        expect(diffReport.changes).toEqual([]);
    });
});
