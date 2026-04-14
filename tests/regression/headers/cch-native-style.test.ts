import { describe, expect, it } from "vitest";

import { buildAnthropicBillingHeader } from "../../../src/headers/billing.js";
import { CCH_PLACEHOLDER, computeNativeStyleCch, replaceNativeStyleCch, xxHash64 } from "../../../src/headers/cch.js";
import { transformRequestBody } from "../../../src/request/body.js";

describe("native-style cch", () => {
    it("matches independently verified xxHash64 reference values", () => {
        expect(xxHash64(new TextEncoder().encode(""))).toBe(0x6e798575d82647edn);
        expect(xxHash64(new TextEncoder().encode("a"))).toBe(0x8404a7f0a8a6bcaen);
        expect(xxHash64(new TextEncoder().encode("hello"))).toBe(0x95ab2f66e009922an);
    });

    it("derives the expected 5-char cch from independently verified vectors", () => {
        expect(computeNativeStyleCch("")).toBe("647ed");
        expect(computeNativeStyleCch("cch=00000")).toBe("1d7f8");
        expect(
            computeNativeStyleCch("x-anthropic-billing-header: cc_version=2.1.101.0e7; cc_entrypoint=cli; cch=00000;"),
        ).toBe("101fb");
    });

    it("replaces the placeholder in a serialized body", () => {
        const serialized =
            '{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.101.0e7; cc_entrypoint=cli; cch=00000;"}],"messages":[{"role":"user","content":"Reply with the single word: OK"}]}';

        expect(replaceNativeStyleCch(serialized)).toContain("cch=0ca30");
        expect(replaceNativeStyleCch(serialized)).not.toContain(`cch=${CCH_PLACEHOLDER}`);
    });

    it("leaves strings without the placeholder unchanged", () => {
        const serialized = '{"system":[{"type":"text","text":"no billing block here"}]}';
        expect(replaceNativeStyleCch(serialized)).toBe(serialized);
    });
});

describe("billing header placeholder + transformRequestBody replacement", () => {
    const signature = {
        enabled: true,
        claudeCliVersion: "2.1.101",
        promptCompactionMode: "minimal" as const,
        sanitizeSystemPrompt: false,
    };
    const runtime = {
        persistentUserId: "0".repeat(64),
        accountId: "acct-1",
        sessionId: "session-1",
    };

    it("buildAnthropicBillingHeader emits the native placeholder", () => {
        process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "true";
        const header = buildAnthropicBillingHeader("2.1.101", [{ role: "user", content: "Hello world from a test" }]);
        expect(header).toContain(`cch=${CCH_PLACEHOLDER};`);
    });

    it("transformRequestBody replaces the placeholder after serialization", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-5",
            max_tokens: 1024,
            stream: false,
            messages: [{ role: "user", content: "Reply with the single word: OK" }],
            system: "You are a helpful assistant.",
        });

        const transformed = transformRequestBody(body, signature, runtime);
        expect(transformed).toBeDefined();
        expect(transformed).not.toContain(`cch=${CCH_PLACEHOLDER}`);

        const actualCch = transformed?.match(/cch=([0-9a-f]{5})/)?.[1];
        const placeholderBody = transformed?.replace(/cch=[0-9a-f]{5}/, `cch=${CCH_PLACEHOLDER}`);

        expect(actualCch).toBeDefined();
        expect(placeholderBody).toBeDefined();
        expect(actualCch).toBe(computeNativeStyleCch(placeholderBody!));
        expect(transformed).toBe(replaceNativeStyleCch(placeholderBody!));
    });
});
