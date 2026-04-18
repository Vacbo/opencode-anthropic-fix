// Characterization tests for resolveRequestProfile (src/fingerprint/merge.ts).
//
// Locks the runtime merge entry before the root-package-decomposition (C5) so
// version normalization, MergeConfig defaults, and fallback behavior cannot
// silently drift when merge.ts is relocated or split.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearManifestLoaderCache } from "../../../src/fingerprint/loader.js";
import { resolveRequestProfile } from "../../../src/fingerprint/merge.js";
import { DEFAULT_FALLBACK_PROFILE } from "../../../src/fingerprint/schema.js";
import {
    createCandidateManifest,
    createVerifiedManifest,
    writeCandidateManifest,
    writeManifestIndex,
    writeVerifiedManifest,
} from "./manifest-fixtures.js";

const MANIFEST_ROOT_ENV = "OPENCODE_ANTHROPIC_MANIFEST_ROOT";

describe("fingerprint/merge resolveRequestProfile", () => {
    let manifestRoot = "";
    let originalRoot: string | undefined;

    beforeEach(() => {
        manifestRoot = mkdtempSync(join(tmpdir(), "fingerprint-merge-"));
        originalRoot = process.env[MANIFEST_ROOT_ENV];
        process.env[MANIFEST_ROOT_ENV] = manifestRoot;
        clearManifestLoaderCache();
    });

    afterEach(() => {
        clearManifestLoaderCache();
        if (originalRoot === undefined) {
            delete process.env[MANIFEST_ROOT_ENV];
        } else {
            process.env[MANIFEST_ROOT_ENV] = originalRoot;
        }
        rmSync(manifestRoot, { recursive: true, force: true });
    });

    it("falls back to DEFAULT_FALLBACK_PROFILE when version is null, undefined, or blank", () => {
        for (const version of [null, undefined, "", "   "]) {
            const profile = resolveRequestProfile(version);
            expect(profile.manifestSource).toBe("fallback");
            expect(profile.version).toBe(DEFAULT_FALLBACK_PROFILE.version);
            expect(profile.transport.pathStyle.value).toBe(DEFAULT_FALLBACK_PROFILE.transport.pathStyle.value);
            expect(profile.billing.ccEntrypoint.value).toBe(DEFAULT_FALLBACK_PROFILE.billing.ccEntrypoint.value);
        }
    });

    it("trims whitespace from version before loading manifests", () => {
        const verified = createVerifiedManifest("2.1.111", [
            {
                path: "headers.xApp",
                value: "cli",
                verifiedAt: "2026-04-15T17:32:35.000Z",
                verifiedBy: "unit-test-runner",
                scenarioIds: ["minimal-hi"],
            },
        ]);
        writeVerifiedManifest(manifestRoot, verified);

        const profile = resolveRequestProfile("   2.1.111   ");
        expect(profile.version).toBe("2.1.111");
        expect(profile.manifestSource).toBe("verified");
    });

    it("returns a fallback source when the version has no manifest files", () => {
        const profile = resolveRequestProfile("0.0.0-nonexistent");
        expect(profile.manifestSource).toBe("fallback");
        expect(profile.version).toBe(DEFAULT_FALLBACK_PROFILE.version);
    });

    it("prefers verified manifest fields over fallback values", () => {
        const verified = createVerifiedManifest("2.1.111", [
            {
                path: "headers.xApp",
                value: "cli-verified",
                verifiedAt: "2026-04-15T17:32:35.000Z",
                verifiedBy: "unit-test-runner",
                scenarioIds: ["minimal-hi"],
            },
        ]);
        writeVerifiedManifest(manifestRoot, verified);

        const profile = resolveRequestProfile("2.1.111");
        expect(profile.manifestSource).toBe("verified");
        expect(profile.headers.xApp.value).toBe("cli-verified");
        expect(profile.headers.xApp.origin).toBe("live-verified");
    });

    it("uses candidate manifestSource by default but keeps fallback values for critical/sensitive fields", () => {
        const candidate = createCandidateManifest("2.1.111");
        candidate.headers.userAgent.value = "claude-cli/candidate-user-agent";
        candidate.billing.ccEntrypoint.value = "candidate-cli";
        writeCandidateManifest(manifestRoot, candidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.111"]);

        const profile = resolveRequestProfile("2.1.111");
        expect(profile.version).toBe("2.1.111");
        expect(profile.manifestSource).toBe("candidate");
        expect(profile.headers.userAgent.value).toBe(DEFAULT_FALLBACK_PROFILE.headers.userAgent.value);
        expect(profile.billing.ccEntrypoint.value).toBe(DEFAULT_FALLBACK_PROFILE.billing.ccEntrypoint.value);
    });

    it("allowCandidateLowRisk=true surfaces low-risk candidate values but still blocks critical fields", () => {
        const candidate = createCandidateManifest("2.1.111");
        candidate.metadata.deviceLinkage.value = "candidate-device-linkage";
        candidate.headers.userAgent.value = "claude-cli/candidate-user-agent";
        writeCandidateManifest(manifestRoot, candidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.111"]);

        const profile = resolveRequestProfile("2.1.111", { allowCandidateLowRisk: true });
        expect(profile.manifestSource).toBe("candidate");
        expect(profile.metadata.deviceLinkage.value).toBe("candidate-device-linkage");
        expect(profile.headers.userAgent.value).toBe(DEFAULT_FALLBACK_PROFILE.headers.userAgent.value);
    });

    it("normalizeMergeConfig: blockedCandidatePaths defaults to [] when omitted", () => {
        const candidate = createCandidateManifest("2.1.111");
        candidate.metadata.deviceLinkage.value = "low-risk-candidate";
        writeCandidateManifest(manifestRoot, candidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.111"]);

        const profile = resolveRequestProfile("2.1.111", { allowCandidateLowRisk: true });
        expect(profile.metadata.deviceLinkage.value).toBe("low-risk-candidate");
    });

    it("blockedCandidatePaths forces fallback on listed low-risk paths", () => {
        const candidate = createCandidateManifest("2.1.111");
        candidate.metadata.deviceLinkage.value = "should-be-blocked";
        writeCandidateManifest(manifestRoot, candidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.111"]);

        const profile = resolveRequestProfile("2.1.111", {
            allowCandidateLowRisk: true,
            blockedCandidatePaths: ["metadata.deviceLinkage"],
        });
        expect(profile.metadata.deviceLinkage.value).toBe(DEFAULT_FALLBACK_PROFILE.metadata.deviceLinkage.value);
    });

    it("verified manifests take precedence over candidate manifests at the same version", () => {
        const candidate = createCandidateManifest("2.1.111");
        candidate.headers.xApp.value = "cli-candidate";
        writeCandidateManifest(manifestRoot, candidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.111"]);

        const verified = createVerifiedManifest("2.1.111", [
            {
                path: "headers.xApp",
                value: "cli-verified",
                verifiedAt: "2026-04-15T17:32:35.000Z",
                verifiedBy: "unit-test-runner",
                scenarioIds: ["minimal-hi"],
            },
        ]);
        writeVerifiedManifest(manifestRoot, verified);

        const profile = resolveRequestProfile("2.1.111", { allowCandidateLowRisk: true });
        expect(profile.manifestSource).toBe("verified");
        expect(profile.headers.xApp.value).toBe("cli-verified");
    });
});
