import { describe, expect, it } from "vitest";

import { extractHeaders } from "../../../scripts/analysis/extract-fingerprint.ts";

describe("extractHeaders", () => {
    it("prefers a sane Claude CLI user agent over malformed template fragments", () => {
        const fingerprint = extractHeaders([
            'const broken = `claude-cli/${{ISSUES_EXPLAINER:`;',
            'const good = "claude-cli/2.1.110 (external, sdk-cli)";',
        ].join("\n"));

        expect(fingerprint.userAgent.template).toBe("claude-cli/2.1.110 (external, sdk-cli)");
    });

    it("drops malformed stainless header values that are really minified code fragments", () => {
        const fingerprint = extractHeaders([
            'const helper = "x-stainless-helper";const junk = ")}}function bG7(q){if(tO8(q))return{";',
        ].join("\n"));

        expect(fingerprint.stainlessHeaders["x-stainless-helper"]).toBeNull();
    });
});
