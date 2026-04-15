import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearManifestLoaderCache } from "../../../src/fingerprint/loader.ts";
import { ProfileResolver } from "../../../src/fingerprint/resolver.ts";
import {
    createCandidateManifest,
    createVerifiedManifest,
    writeCandidateManifest,
    writeManifestIndex,
    writeVerifiedManifest,
} from "./manifest-fixtures.ts";

describe("fingerprint/resolver", () => {
    let manifestRoot = "";

    beforeEach(() => {
        manifestRoot = mkdtempSync(join(tmpdir(), "fingerprint-resolver-"));
        clearManifestLoaderCache();
    });

    afterEach(() => {
        clearManifestLoaderCache();
        rmSync(manifestRoot, { recursive: true, force: true });
    });

    it("falls back safely when no manifests are available", () => {
        const resolver = new ProfileResolver({ manifestRoot });
        expect(resolver.resolveProfile().manifestSource).toBe("fallback");
        expect(resolver.getActiveProfile().version).toBe("unknown");
    });

    it("resolves the latest candidate profile when no verified manifest exists", () => {
        const candidate = createCandidateManifest("2.1.108");
        candidate.metadata.deviceLinkage.value = "candidate-device-linkage";

        writeCandidateManifest(manifestRoot, candidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.108"]);

        const resolver = new ProfileResolver({ manifestRoot });
        const profile = resolver.resolveProfile();
        expect(profile.version).toBe("2.1.108");
        expect(profile.manifestSource).toBe("candidate");
        expect(profile.metadata.deviceLinkage.value).toBe("candidate-device-linkage");
    });

    it("prefers the latest verified version over the latest candidate version", () => {
        const candidate = createCandidateManifest("2.1.109");
        const verified = createVerifiedManifest("2.1.107", [
            {
                path: "billing.ccVersion",
                value: "2.1.107-verified",
                verifiedAt: "2026-04-15T17:32:35.000Z",
                verifiedBy: "unit-test-runner",
                scenarioIds: ["minimal-hi"],
            },
        ]);

        writeCandidateManifest(manifestRoot, candidate);
        writeVerifiedManifest(manifestRoot, verified);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.109"]);
        writeManifestIndex(manifestRoot, "verified", ["2.1.107"]);

        const resolver = new ProfileResolver({ manifestRoot });
        const profile = resolver.resolveProfile();
        expect(profile.version).toBe("2.1.107");
        expect(profile.manifestSource).toBe("verified");
        expect(profile.billing.ccVersion.value).toBe("2.1.107-verified");
    });

    it("refreshes cached profiles when manifests change", () => {
        const resolver = new ProfileResolver({ manifestRoot });
        const firstCandidate = createCandidateManifest("2.1.108");
        firstCandidate.metadata.deviceLinkage.value = "first";

        writeCandidateManifest(manifestRoot, firstCandidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.108"]);

        expect(resolver.resolveProfile().metadata.deviceLinkage.value).toBe("first");

        const nextCandidate = createCandidateManifest("2.1.110");
        nextCandidate.metadata.deviceLinkage.value = "second";

        writeCandidateManifest(manifestRoot, nextCandidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.108", "2.1.110"], "2.1.110");

        expect(resolver.getActiveProfile().metadata.deviceLinkage.value).toBe("first");

        resolver.refresh();
        const refreshed = resolver.resolveProfile();
        expect(refreshed.version).toBe("2.1.110");
        expect(refreshed.metadata.deviceLinkage.value).toBe("second");
    });
});
