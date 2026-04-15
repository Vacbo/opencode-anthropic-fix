import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUserAgent, getClaudeEntrypoint } from "../../../src/headers/user-agent.js";
import { RequestProfileResolver } from "../../../src/request/profile-resolver.js";
import {
    createCandidateManifest,
    writeCandidateManifest,
    writeManifestIndex,
} from "../fingerprint/manifest-fixtures.ts";

describe("request/profile-resolver", () => {
    let manifestRoot = "";
    let resolver: RequestProfileResolver;

    beforeEach(() => {
        manifestRoot = mkdtempSync(join(tmpdir(), "request-profile-resolver-"));
        resolver = new RequestProfileResolver({ manifestRoot });
    });

    afterEach(() => {
        rmSync(manifestRoot, { recursive: true, force: true });
    });

    it("normalizes fallback profiles with the requested CLI version", () => {
        const profile = resolver.getRequestProfile({ version: "2.1.120", forceRefresh: true });

        expect(profile.manifestSource).toBe("fallback");
        expect(profile.version).toBe("2.1.120");
        expect(profile.billing.ccVersion.value).toBe("2.1.120");
        expect(profile.headers.userAgent.value).toBe(buildUserAgent("2.1.120"));
        expect(profile.headers.xApp.value).toBe("cli");
        expect(profile.billing.ccEntrypoint.value).toBe(getClaudeEntrypoint());
        expect(profile.transport.defaultHeaders.value["content-type"]).toBe("application/json");
    });

    it("keeps manifest-provided runtime values when a candidate exists", () => {
        const candidate = createCandidateManifest("2.1.108");
        candidate.headers.xStainlessHeaders.value["x-manifest-header"] = "enabled";
        candidate.metadata.deviceLinkage.value = "candidate-device-linkage";

        writeCandidateManifest(manifestRoot, candidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.108"]);

        const profile = resolver.refreshProfile({ version: "2.1.108" });
        expect(profile.manifestSource).toBe("candidate");
        expect(profile.billing.ccVersion.value).toBe("2.1.108");
        expect(profile.headers.userAgent.value).toBe(buildUserAgent("2.1.108"));
        expect(profile.headers.xStainlessHeaders.value["x-manifest-header"]).toBe("enabled");
        expect(profile.metadata.deviceLinkage.value).toBe("candidate-device-linkage");
    });

    it("refreshes cached runtime profiles when manifests change", () => {
        const firstCandidate = createCandidateManifest("2.1.108");
        firstCandidate.metadata.deviceLinkage.value = "first";
        writeCandidateManifest(manifestRoot, firstCandidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.108"]);

        expect(
            resolver.getRequestProfile({ version: "2.1.108", forceRefresh: true }).metadata.deviceLinkage.value,
        ).toBe("first");

        const nextCandidate = createCandidateManifest("2.1.109");
        nextCandidate.metadata.deviceLinkage.value = "second";
        writeCandidateManifest(manifestRoot, nextCandidate);
        writeManifestIndex(manifestRoot, "candidate", ["2.1.108", "2.1.109"], "2.1.109");

        expect(resolver.refreshProfile().metadata.deviceLinkage.value).toBe("second");
    });
});
