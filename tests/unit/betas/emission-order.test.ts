import { describe, expect, it } from "vitest";
import { buildAnthropicBetaHeader } from "../../../src/betas.js";

const HAIKU = "claude-haiku-4-5-20251001";

const EXPECTED_HAIKU_ORDER = [
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "claude-code-20250219",
    "advisor-tool-2026-03-01",
];

describe("anthropic-beta emission order (Haiku 4.5, signature-enabled, first-party OAuth)", () => {
    it("emits betas in the exact order CC 2.1.113 emits them for minimal-hi", () => {
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
        expect(header.split(",")).toEqual(EXPECTED_HAIKU_ORDER);
    });

    it("is deterministic across repeated calls with identical inputs", () => {
        const outputs = Array.from({ length: 10 }, () =>
            buildAnthropicBetaHeader("", true, HAIKU, "anthropic", undefined, "sticky", "/v1/messages", false),
        );
        const unique = new Set(outputs);
        expect(unique.size).toBe(1);
    });
});
