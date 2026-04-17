import { describe, expect, it } from "vitest";
import { buildAnthropicBetaHeader } from "../../src/betas.js";

describe("buildAnthropicBetaHeader on Haiku 4.5 (signature-enabled, first-party OAuth)", () => {
    const HAIKU = "claude-haiku-4-5-20251001";

    it("sends claude-code-20250219 (was excluded by !haiku guard; Phase 1 capture 2026-04-17 proved CC sends it)", () => {
        const header = buildAnthropicBetaHeader(
            "",
            true,
            HAIKU,
            "anthropic",
            undefined,
            "sticky",
            "/v1/messages",
            false,
        );
        expect(header.split(",")).toContain("claude-code-20250219");
    });

    it("sends advisor-tool-2026-03-01 when present in manifest (was excluded by !haiku guard; Phase 1 capture 2026-04-17 proved CC sends it)", () => {
        const header = buildAnthropicBetaHeader(
            "",
            true,
            HAIKU,
            "anthropic",
            undefined,
            "sticky",
            "/v1/messages",
            false,
        );
        expect(header.split(",")).toContain("advisor-tool-2026-03-01");
    });

    it("still sends the baseline betas that are not haiku-gated", () => {
        const header = buildAnthropicBetaHeader(
            "",
            true,
            HAIKU,
            "anthropic",
            undefined,
            "sticky",
            "/v1/messages",
            false,
        );
        const betas = header.split(",");
        expect(betas).toContain("oauth-2025-04-20");
        expect(betas).toContain("interleaved-thinking-2025-05-14");
        expect(betas).toContain("context-management-2025-06-27");
        expect(betas).toContain("prompt-caching-scope-2026-01-05");
    });

    it("matches the observed OG Claude Code 2.1.112 beta set on Haiku 4.5 (2026-04-17 capture)", () => {
        const header = buildAnthropicBetaHeader(
            "",
            true,
            HAIKU,
            "anthropic",
            undefined,
            "sticky",
            "/v1/messages",
            false,
        );
        const betas = new Set(header.split(","));
        const expected = [
            "oauth-2025-04-20",
            "interleaved-thinking-2025-05-14",
            "context-management-2025-06-27",
            "prompt-caching-scope-2026-01-05",
            "claude-code-20250219",
            "advisor-tool-2026-03-01",
        ];
        for (const beta of expected) {
            expect(betas).toContain(beta);
        }
    });
});
