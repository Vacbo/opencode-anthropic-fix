import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    clearManifestLoaderCache,
    getLatestVersion,
    loadCandidateManifest,
    loadManifestIndex,
    loadVerifiedManifest,
} from "../../../src/fingerprint/loader.ts";
import {
    createCandidateManifest,
    createVerifiedManifest,
    writeCandidateManifest,
    writeManifestIndex,
    writeVerifiedManifest,
} from "./manifest-fixtures.ts";

describe("fingerprint/loader", () => {
    let manifestRoot = "";

    beforeEach(() => {
        manifestRoot = mkdtempSync(join(tmpdir(), "fingerprint-loader-"));
        clearManifestLoaderCache();
    });

    afterEach(() => {
        clearManifestLoaderCache();
        rmSync(manifestRoot, { recursive: true, force: true });
    });

    it("loads candidate, verified, and index manifests from disk", () => {
        const candidate = createCandidateManifest("2.1.108");
        const verified = createVerifiedManifest("2.1.108", [
            {
                path: "billing.ccVersion",
                value: "2.1.108",
                verifiedAt: "2026-04-15T17:32:35.000Z",
                verifiedBy: "unit-test-runner",
                scenarioIds: ["minimal-hi"],
            },
        ]);

        writeCandidateManifest(manifestRoot, candidate);
        writeVerifiedManifest(manifestRoot, verified);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.108"]);
        writeManifestIndex(manifestRoot, "verified", ["2.1.108"]);

        expect(loadCandidateManifest("2.1.108", { manifestRoot })?.version).toBe("2.1.108");
        expect(loadVerifiedManifest("2.1.108", { manifestRoot })?.version).toBe("2.1.108");
        expect(loadManifestIndex("candidate", { manifestRoot })?.latest).toBe("2.1.108");
        expect(getLatestVersion("verified", { manifestRoot })).toBe("2.1.108");
    });

    it("returns null when manifests or index files are missing or invalid", () => {
        writeManifestIndex(manifestRoot, "candidate", [], null);
        writeManifestIndex(manifestRoot, "verified", [], null);
        writeFileSync(join(manifestRoot, "verified", "claude-code", "index.json"), "{not-json", "utf-8");

        expect(loadCandidateManifest("2.1.999", { manifestRoot })).toBeNull();
        expect(loadVerifiedManifest("2.1.999", { manifestRoot })).toBeNull();
        expect(loadManifestIndex("verified", { manifestRoot })).toBeNull();
        expect(getLatestVersion("candidate", { manifestRoot })).toBeNull();
    });

    it("caches previously loaded manifests", () => {
        const manifest = createCandidateManifest("2.1.109");
        writeCandidateManifest(manifestRoot, manifest);

        const firstLoad = loadCandidateManifest("2.1.109", { manifestRoot });
        writeFileSync(
            join(manifestRoot, "candidate", "claude-code", "2.1.109.json"),
            JSON.stringify({ invalid: true }, null, 2),
            "utf-8",
        );

        const secondLoad = loadCandidateManifest("2.1.109", { manifestRoot });
        expect(firstLoad).toEqual(secondLoad);
        expect(secondLoad?.version).toBe("2.1.109");
    });

    it("treats missing manifest files (ENOENT) as null without throwing", () => {
        expect(() => loadCandidateManifest("2.9.999", { manifestRoot })).not.toThrow();
        expect(() => loadVerifiedManifest("2.9.999", { manifestRoot })).not.toThrow();
        expect(loadCandidateManifest("2.9.999", { manifestRoot })).toBeNull();
        expect(loadVerifiedManifest("2.9.999", { manifestRoot })).toBeNull();
    });
});
