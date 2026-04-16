import { describe, it, expect } from "vitest";
import type { CandidateManifest, VerifiedManifest, FieldMetadata } from "../../../src/fingerprint/types.ts";
import {
    classifyRisk,
    ManifestValidationError,
    validateCandidateManifest,
    validateVerifiedManifest,
    mergeManifests,
    resolveField,
    DEFAULT_FALLBACK_PROFILE,
    getScenario,
    getScenarioIds,
} from "../../../src/fingerprint/schema.ts";

describe("fingerprint/schema", () => {
    describe("classifyRisk", () => {
        it("should classify critical fields correctly", () => {
            expect(classifyRisk("transport.authHeaderMode")).toBe("critical");
            expect(classifyRisk("betas.requiredBaseBetas")).toBe("critical");
            expect(classifyRisk("headers.userAgent")).toBe("critical");
            expect(classifyRisk("billing.ccEntrypoint")).toBe("critical");
            expect(classifyRisk("prompt.identityString")).toBe("critical");
            expect(classifyRisk("body.defaultStream")).toBe("critical");
        });

        it("should classify sensitive fields correctly", () => {
            expect(classifyRisk("headers.xStainlessHeaders")).toBe("sensitive");
            expect(classifyRisk("headers.xClientRequestId")).toBe("sensitive");
            expect(classifyRisk("betas.optionalBetas")).toBe("sensitive");
            expect(classifyRisk("transport.pathStyle")).toBe("sensitive");
        });

        it("should classify low-risk fields correctly", () => {
            expect(classifyRisk("billing.ccVersion")).toBe("low-risk");
            expect(classifyRisk("metadata.deviceLinkage")).toBe("low-risk");
            expect(classifyRisk("some.random.field")).toBe("low-risk");
        });
    });

    describe("validateCandidateManifest", () => {
        it("should validate a correct candidate manifest", () => {
            const validManifest: CandidateManifest = {
                version: "2.1.109",
                source: {
                    npmPackage: "@anthropic-ai/claude-code",
                    tarballUrl: "https://registry.npmjs.org/...",
                    tarballHash: "sha256:abc123",
                    extractionTimestamp: "2026-04-15T17:32:35.000Z",
                },
                transport: {
                    pathStyle: {
                        value: "/v1/messages?beta=true",
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "high",
                    },
                    defaultHeaders: { value: {}, risk: "low-risk", origin: "bundle-string", confidence: "medium" },
                    authHeaderMode: { value: "bearer", risk: "critical", origin: "bundle-string", confidence: "high" },
                },
                headers: {
                    userAgent: {
                        value: "claude-cli/2.1.109",
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "high",
                    },
                    xApp: { value: "claude-cli", risk: "sensitive", origin: "bundle-string", confidence: "high" },
                    xStainlessHeaders: { value: {}, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
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
                    optionalBetas: { value: [], risk: "sensitive", origin: "bundle-string", confidence: "medium" },
                    authModeBetas: { value: [], risk: "critical", origin: "bundle-string", confidence: "medium" },
                },
                billing: {
                    ccVersion: { value: "2.1.109", risk: "low-risk", origin: "bundle-string", confidence: "high" },
                    ccEntrypoint: {
                        value: "claude-cli",
                        risk: "critical",
                        origin: "bundle-string",
                        confidence: "high",
                    },
                    cchStrategy: { value: "xxhash64", risk: "critical", origin: "bundle-string", confidence: "high" },
                },
                body: {
                    defaultStream: { value: true, risk: "critical", origin: "bundle-string", confidence: "high" },
                    defaultMaxTokens: { value: 4096, risk: "critical", origin: "bundle-string", confidence: "high" },
                    temperaturePresence: {
                        value: false,
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "medium",
                    },
                    thinkingKey: { value: true, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
                    contextManagementKey: {
                        value: true,
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "medium",
                    },
                    toolsKey: { value: true, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
                },
                prompt: {
                    identityString: {
                        value: "You are Claude Code...",
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
                    appendMode: { value: false, risk: "critical", origin: "bundle-string", confidence: "medium" },
                    cacheControlBehavior: {
                        value: "default",
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "medium",
                    },
                },
                metadata: {
                    userIdShape: { value: "oauth:<id>", risk: "critical", origin: "bundle-string", confidence: "high" },
                    deviceLinkage: { value: "default", risk: "low-risk", origin: "bundle-string", confidence: "low" },
                    accountLinkage: { value: "default", risk: "low-risk", origin: "bundle-string", confidence: "low" },
                },
                parserWarnings: [],
                unknownFields: [],
            };

            expect(() => validateCandidateManifest(validManifest)).not.toThrow();
            const result = validateCandidateManifest(validManifest);
            expect(result.version).toBe("2.1.109");
        });

        it("should throw for missing required fields", () => {
            const invalidManifest = {
                version: "2.1.109",
                // Missing other required fields
            };

            expect(() => validateCandidateManifest(invalidManifest)).toThrow(
                "Candidate manifest missing required field",
            );
        });

        it("should throw for non-object manifest", () => {
            expect(() => validateCandidateManifest(null)).toThrow("Candidate manifest must be an object");
            expect(() => validateCandidateManifest("string")).toThrow("Candidate manifest must be an object");
        });

        it("throws ManifestValidationError (not bare Error) so callers can discriminate via instanceof", () => {
            expect(() => validateCandidateManifest(null)).toThrow(ManifestValidationError);
            expect(() => validateCandidateManifest({ version: "2.1.109" })).toThrow(ManifestValidationError);
            try {
                validateCandidateManifest({ version: 42 });
                throw new Error("expected validateCandidateManifest to throw");
            } catch (error) {
                expect(error).toBeInstanceOf(ManifestValidationError);
                expect((error as ManifestValidationError).name).toBe("ManifestValidationError");
            }
        });
    });

    describe("validateVerifiedManifest", () => {
        it("should validate a correct verified manifest", () => {
            const validManifest: VerifiedManifest = {
                version: "2.1.109",
                verifiedAt: "2026-04-15T17:32:35.000Z",
                verifiedBy: "local-verifier",
                scenarioIds: ["minimal-hi", "tool-search"],
                promotedFields: [
                    {
                        path: "headers.userAgent",
                        value: "claude-cli/2.1.109",
                        verifiedAt: "2026-04-15T17:32:35.000Z",
                        verifiedBy: "local-verifier",
                        scenarioIds: ["minimal-hi"],
                    },
                ],
                rejectedCandidateFields: [],
                evidenceArtifacts: ["/tmp/verification-2.1.109.json"],
            };

            expect(() => validateVerifiedManifest(validManifest)).not.toThrow();
            const result = validateVerifiedManifest(validManifest);
            expect(result.version).toBe("2.1.109");
        });

        it("should throw for missing required fields", () => {
            const invalidManifest = {
                version: "2.1.109",
                // Missing other required fields
            };

            expect(() => validateVerifiedManifest(invalidManifest)).toThrow("Verified manifest missing required field");
        });

        it("throws ManifestValidationError (not bare Error) so callers can discriminate via instanceof", () => {
            expect(() => validateVerifiedManifest(null)).toThrow(ManifestValidationError);
            expect(() => validateVerifiedManifest({ version: "2.1.109" })).toThrow(ManifestValidationError);
        });
    });

    describe("resolveField", () => {
        const fallbackValue = "fallback";
        const candidateField: FieldMetadata<string> = {
            value: "candidate",
            risk: "low-risk",
            origin: "bundle-string",
            confidence: "medium",
        };

        it("should prefer verified value when available", () => {
            const result = resolveField("verified", candidateField, fallbackValue, {
                preferVerified: true,
                allowCandidateLowRisk: true,
                blockedCandidatePaths: [],
            });
            expect(result).toBe("verified");
        });

        it("should use candidate for low-risk fields when allowed", () => {
            const result = resolveField(undefined, candidateField, fallbackValue, {
                preferVerified: true,
                allowCandidateLowRisk: true,
                blockedCandidatePaths: [],
            });
            expect(result).toBe("candidate");
        });

        it("should fallback when candidate is critical risk", () => {
            const criticalField: FieldMetadata<string> = {
                value: "candidate",
                risk: "critical",
                origin: "bundle-string",
                confidence: "medium",
            };
            const result = resolveField(undefined, criticalField, fallbackValue, {
                preferVerified: true,
                allowCandidateLowRisk: true,
                blockedCandidatePaths: [],
            });
            expect(result).toBe("fallback");
        });

        it("should fallback when candidate is sensitive risk", () => {
            const sensitiveField: FieldMetadata<string> = {
                value: "candidate",
                risk: "sensitive",
                origin: "bundle-string",
                confidence: "medium",
            };
            const result = resolveField(undefined, sensitiveField, fallbackValue, {
                preferVerified: true,
                allowCandidateLowRisk: true,
                blockedCandidatePaths: [],
            });
            expect(result).toBe("fallback");
        });

        it("should fallback when no verified or candidate", () => {
            const result = resolveField(undefined, undefined, fallbackValue, {
                preferVerified: true,
                allowCandidateLowRisk: true,
                blockedCandidatePaths: [],
            });
            expect(result).toBe("fallback");
        });
    });

    describe("mergeManifests", () => {
        it("should use fallback when no manifests provided", () => {
            const result = mergeManifests(null, null);
            expect(result.manifestSource).toBe("fallback");
            expect(result.version).toBe("unknown");
        });

        it("should prefer verified over candidate", () => {
            const candidate: CandidateManifest = {
                version: "2.1.109",
                source: {
                    npmPackage: "@anthropic-ai/claude-code",
                    tarballUrl: "https://example.com",
                    tarballHash: "abc123",
                    extractionTimestamp: "2026-04-15T17:32:35.000Z",
                },
                transport: {
                    pathStyle: {
                        value: "/v1/messages",
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "high",
                    },
                    defaultHeaders: { value: {}, risk: "low-risk", origin: "bundle-string", confidence: "medium" },
                    authHeaderMode: { value: "bearer", risk: "critical", origin: "bundle-string", confidence: "high" },
                },
                headers: {
                    userAgent: {
                        value: "claude-cli/2.1.109",
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "high",
                    },
                    xApp: { value: "claude-cli", risk: "sensitive", origin: "bundle-string", confidence: "high" },
                    xStainlessHeaders: { value: {}, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
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
                    optionalBetas: { value: [], risk: "sensitive", origin: "bundle-string", confidence: "medium" },
                    authModeBetas: { value: [], risk: "critical", origin: "bundle-string", confidence: "medium" },
                },
                billing: {
                    ccVersion: { value: "2.1.109", risk: "low-risk", origin: "bundle-string", confidence: "high" },
                    ccEntrypoint: {
                        value: "claude-cli",
                        risk: "critical",
                        origin: "bundle-string",
                        confidence: "high",
                    },
                    cchStrategy: { value: "xxhash64", risk: "critical", origin: "bundle-string", confidence: "high" },
                },
                body: {
                    defaultStream: { value: true, risk: "critical", origin: "bundle-string", confidence: "high" },
                    defaultMaxTokens: { value: 4096, risk: "critical", origin: "bundle-string", confidence: "high" },
                    temperaturePresence: {
                        value: false,
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "medium",
                    },
                    thinkingKey: { value: true, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
                    contextManagementKey: {
                        value: true,
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "medium",
                    },
                    toolsKey: { value: true, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
                },
                prompt: {
                    identityString: {
                        value: "You are Claude Code...",
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
                    appendMode: { value: false, risk: "critical", origin: "bundle-string", confidence: "medium" },
                    cacheControlBehavior: {
                        value: "default",
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "medium",
                    },
                },
                metadata: {
                    userIdShape: { value: "oauth:<id>", risk: "critical", origin: "bundle-string", confidence: "high" },
                    deviceLinkage: { value: "default", risk: "low-risk", origin: "bundle-string", confidence: "low" },
                    accountLinkage: { value: "default", risk: "low-risk", origin: "bundle-string", confidence: "low" },
                },
                parserWarnings: [],
                unknownFields: [],
            };

            const verified: VerifiedManifest = {
                version: "2.1.109",
                verifiedAt: "2026-04-15T17:32:35.000Z",
                verifiedBy: "local-verifier",
                scenarioIds: ["minimal-hi"],
                promotedFields: [
                    {
                        path: "headers.userAgent",
                        value: "claude-cli/2.1.109-verified",
                        verifiedAt: "2026-04-15T17:32:35.000Z",
                        verifiedBy: "local-verifier",
                        scenarioIds: ["minimal-hi"],
                    },
                ],
                rejectedCandidateFields: [],
                evidenceArtifacts: [],
            };

            const result = mergeManifests(candidate, verified, DEFAULT_FALLBACK_PROFILE, {
                preferVerified: true,
                allowCandidateLowRisk: false,
                blockedCandidatePaths: [],
            });

            expect(result.manifestSource).toBe("verified");
            // The verified value should be used for userAgent
            expect(result.headers.userAgent.value).toBe("claude-cli/2.1.109-verified");
        });

        it("should use candidate for low-risk fields when allowed", () => {
            const candidate: CandidateManifest = {
                version: "2.1.109",
                source: {
                    npmPackage: "@anthropic-ai/claude-code",
                    tarballUrl: "https://example.com",
                    tarballHash: "abc123",
                    extractionTimestamp: "2026-04-15T17:32:35.000Z",
                },
                transport: {
                    pathStyle: {
                        value: "/v1/messages",
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "high",
                    },
                    defaultHeaders: { value: {}, risk: "low-risk", origin: "bundle-string", confidence: "medium" },
                    authHeaderMode: { value: "bearer", risk: "critical", origin: "bundle-string", confidence: "high" },
                },
                headers: {
                    userAgent: {
                        value: "claude-cli/2.1.109",
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "high",
                    },
                    xApp: { value: "claude-cli", risk: "sensitive", origin: "bundle-string", confidence: "high" },
                    xStainlessHeaders: { value: {}, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
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
                    optionalBetas: { value: [], risk: "sensitive", origin: "bundle-string", confidence: "medium" },
                    authModeBetas: { value: [], risk: "critical", origin: "bundle-string", confidence: "medium" },
                },
                billing: {
                    ccVersion: { value: "2.1.109", risk: "low-risk", origin: "bundle-string", confidence: "high" },
                    ccEntrypoint: {
                        value: "claude-cli",
                        risk: "critical",
                        origin: "bundle-string",
                        confidence: "high",
                    },
                    cchStrategy: { value: "xxhash64", risk: "critical", origin: "bundle-string", confidence: "high" },
                },
                body: {
                    defaultStream: { value: true, risk: "critical", origin: "bundle-string", confidence: "high" },
                    defaultMaxTokens: { value: 4096, risk: "critical", origin: "bundle-string", confidence: "high" },
                    temperaturePresence: {
                        value: false,
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "medium",
                    },
                    thinkingKey: { value: true, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
                    contextManagementKey: {
                        value: true,
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "medium",
                    },
                    toolsKey: { value: true, risk: "sensitive", origin: "bundle-string", confidence: "medium" },
                },
                prompt: {
                    identityString: {
                        value: "You are Claude Code...",
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
                    appendMode: { value: false, risk: "critical", origin: "bundle-string", confidence: "medium" },
                    cacheControlBehavior: {
                        value: "default",
                        risk: "sensitive",
                        origin: "bundle-string",
                        confidence: "medium",
                    },
                },
                metadata: {
                    userIdShape: { value: "oauth:<id>", risk: "critical", origin: "bundle-string", confidence: "high" },
                    deviceLinkage: {
                        value: "device-candidate",
                        risk: "low-risk",
                        origin: "bundle-string",
                        confidence: "low",
                    },
                    accountLinkage: {
                        value: "account-candidate",
                        risk: "low-risk",
                        origin: "bundle-string",
                        confidence: "low",
                    },
                },
                parserWarnings: [],
                unknownFields: [],
            };

            const result = mergeManifests(candidate, null, DEFAULT_FALLBACK_PROFILE, {
                preferVerified: true,
                allowCandidateLowRisk: true,
                blockedCandidatePaths: [],
            });

            expect(result.manifestSource).toBe("candidate");
            // Low-risk fields should use candidate values
            expect(result.metadata.deviceLinkage.value).toBe("device-candidate");
            expect(result.metadata.accountLinkage.value).toBe("account-candidate");
            // Sensitive fields remain fallback-only until live verification promotes them.
            expect(result.headers.xStainlessHeaders.value).toEqual(DEFAULT_FALLBACK_PROFILE.headers.xStainlessHeaders.value);
        });
    });

    describe("VERIFICATION_SCENARIOS", () => {
        it("should contain all expected scenarios", () => {
            const ids = getScenarioIds();
            expect(ids).toContain("minimal-hi");
            expect(ids).toContain("tool-search");
            expect(ids).toContain("append-system-prompt");
            expect(ids).toContain("oauth-token-refresh");
        });

        it("should retrieve scenarios by ID", () => {
            const scenario = getScenario("minimal-hi");
            expect(scenario).toBeDefined();
            expect(scenario?.id).toBe("minimal-hi");
            expect(scenario?.requiredFields).toContain("transport.pathStyle");
        });

        it("should return undefined for unknown scenario", () => {
            const scenario = getScenario("unknown-scenario");
            expect(scenario).toBeUndefined();
        });
    });

    describe("DEFAULT_FALLBACK_PROFILE", () => {
        it("should have all required sections", () => {
            expect(DEFAULT_FALLBACK_PROFILE.transport).toBeDefined();
            expect(DEFAULT_FALLBACK_PROFILE.headers).toBeDefined();
            expect(DEFAULT_FALLBACK_PROFILE.betas).toBeDefined();
            expect(DEFAULT_FALLBACK_PROFILE.billing).toBeDefined();
            expect(DEFAULT_FALLBACK_PROFILE.body).toBeDefined();
            expect(DEFAULT_FALLBACK_PROFILE.prompt).toBeDefined();
            expect(DEFAULT_FALLBACK_PROFILE.metadata).toBeDefined();
        });

        it("should have correct manifest source", () => {
            expect(DEFAULT_FALLBACK_PROFILE.manifestSource).toBe("fallback");
        });

        it("should have critical fields marked correctly", () => {
            expect(DEFAULT_FALLBACK_PROFILE.transport.authHeaderMode.risk).toBe("critical");
            expect(DEFAULT_FALLBACK_PROFILE.betas.requiredBaseBetas.risk).toBe("critical");
            expect(DEFAULT_FALLBACK_PROFILE.prompt.identityString.risk).toBe("critical");
        });
    });
});
