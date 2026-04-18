import { afterEach, describe, expect, it } from "vitest";
import { buildAnthropicBetaHeader } from "../../../src/betas.js";
import { clearLongContextExclusions, recordLongContextExclusion } from "../../../src/request/long-context-retry.js";

describe("buildAnthropicBetaHeader — long context exclusions", () => {
    afterEach(() => {
        clearLongContextExclusions();
    });

    it("omits context-1m-2025-08-07 after it has been excluded for the model", () => {
        const withBeta = buildAnthropicBetaHeader(
            "",
            true,
            "claude-opus-4-6",
            "anthropic",
            ["context-1m-2025-08-07"],
            "sticky",
            "/v1/messages",
            false,
        );
        expect(withBeta.split(",")).toContain("context-1m-2025-08-07");

        recordLongContextExclusion("claude-opus-4-6", "context-1m-2025-08-07");

        const withoutBeta = buildAnthropicBetaHeader(
            "",
            true,
            "claude-opus-4-6",
            "anthropic",
            ["context-1m-2025-08-07"],
            "sticky",
            "/v1/messages",
            false,
        );
        expect(withoutBeta.split(",")).not.toContain("context-1m-2025-08-07");
    });

    it("exclusions do not leak across models", () => {
        recordLongContextExclusion("claude-opus-4-6", "context-1m-2025-08-07");

        const other = buildAnthropicBetaHeader(
            "",
            true,
            "claude-opus-4-7",
            "anthropic",
            ["context-1m-2025-08-07"],
            "sticky",
            "/v1/messages",
            false,
        );
        expect(other.split(",")).toContain("context-1m-2025-08-07");
    });

    it("omits interleaved-thinking-2025-05-14 after it has been excluded", () => {
        recordLongContextExclusion("claude-opus-4-6", "interleaved-thinking-2025-05-14");

        const header = buildAnthropicBetaHeader(
            "",
            true,
            "claude-opus-4-6",
            "anthropic",
            undefined,
            "sticky",
            "/v1/messages",
            false,
        );
        expect(header.split(",")).not.toContain("interleaved-thinking-2025-05-14");
    });
});
