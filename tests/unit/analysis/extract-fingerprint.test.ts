import { describe, expect, it } from "vitest";

import { extractBilling, extractHeaders } from "../../../scripts/analysis/extract-fingerprint.ts";

describe("extractHeaders", () => {
    it("prefers a sane Claude CLI user agent over malformed template fragments", () => {
        const fingerprint = extractHeaders(
            [
                "const broken = `claude-cli/${{ISSUES_EXPLAINER:`;",
                'const good = "claude-cli/2.1.110 (external, sdk-cli)";',
            ].join("\n"),
        );

        expect(fingerprint.userAgent.template).toBe("claude-cli/2.1.110 (external, sdk-cli)");
    });

    it("drops malformed stainless header values that are really minified code fragments", () => {
        const fingerprint = extractHeaders(
            ['const helper = "x-stainless-helper";const junk = ")}}function bG7(q){if(tO8(q))return{";'].join("\n"),
        );

        expect(fingerprint.stainlessHeaders["x-stainless-helper"]).toBeNull();
    });

    it("extracts the Bun-binary user agent template literal form when no concrete UA string exists", () => {
        const source = [
            'const q=process.env.CLAUDE_CODE_ENTRYPOINT??"unknown";',
            'const _=`claude-cli/${{VERSION:"2.1.113"}.VERSION}`;',
            'const suffix=" (external, sdk-cli)";',
            "const ua = `${_}${suffix}`;",
        ].join("\n");

        const fingerprint = extractHeaders(source);
        expect(fingerprint.userAgent.template).toBe("claude-cli/2.1.113 (external, sdk-cli)");
    });
});

describe("extractBilling", () => {
    it("extracts the billing template from the Bun-binary template-literal form", () => {
        const source = [
            'const _=`${{VERSION:"2.1.113"}.VERSION}.${H}`;',
            'const q=process.env.CLAUDE_CODE_ENTRYPOINT??"unknown";',
            "const K=uq();",
            'const T=!(K==="bedrock"||K==="anthropicAws"||K==="mantle")?" cch=00000;":"";',
            'const A=$?` cc_workload=${$};`:"";',
            "const z=`x-anthropic-billing-header: cc_version=${_}; cc_entrypoint=${q};${T}${A}`;",
        ].join("\n");

        const billing = extractBilling(source);
        expect(billing.template).toContain("x-anthropic-billing-header");
        expect(billing.template).toContain("cc_version=${_}");
        expect(billing.cch).toBe("cch=00000");
    });

    it("keeps the old direct cch matcher working", () => {
        const billing = extractBilling(
            'const h = "x-anthropic-billing-header: cc_version=2.1.113.abc; cc_entrypoint=sdk-cli; cch=12345;";',
        );
        expect(billing.cch).toBe("cch=12345");
    });
});
