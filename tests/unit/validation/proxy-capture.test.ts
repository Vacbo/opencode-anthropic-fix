import { describe, expect, it } from "vitest";

import { shouldMitmHost, shouldUseBunRuntime } from "../../../scripts/validation/proxy-capture.ts";

describe("proxy-capture host targeting", () => {
    it("MITMs Anthropic and claude.ai hosts only", () => {
        expect(shouldMitmHost("api.anthropic.com")).toBe(true);
        expect(shouldMitmHost("console.anthropic.com")).toBe(true);
        expect(shouldMitmHost("claude.ai")).toBe(true);
        expect(shouldMitmHost("api.claude.ai")).toBe(false);
        expect(shouldMitmHost("downloads.claude.ai")).toBe(false);

        expect(shouldMitmHost("github.com")).toBe(false);
        expect(shouldMitmHost("registry.npmjs.org")).toBe(false);
        expect(shouldMitmHost("downloads.claude.ai.evil.example")).toBe(false);
    });

    it("requires Bun runtime for parity-sensitive capture", () => {
        expect(shouldUseBunRuntime({ bun: "1.3.12", node: "24.3.0" })).toBe(true);
        expect(shouldUseBunRuntime({ node: "24.3.0" })).toBe(false);
    });
});
