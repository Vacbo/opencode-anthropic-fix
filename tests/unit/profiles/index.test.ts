import { describe, expect, it } from "vitest";

import { buildAnthropicBetaHeader } from "../../../src/betas.js";
import {
    DEFAULT_SIGNATURE_PROFILE_ID,
    listSignatureProfiles,
    resolveSignatureProfile,
    TOOL_SEARCH_SIGNATURE_PROFILE_ID,
} from "../../../src/profiles/index.js";

describe("signature profiles", () => {
    it("uses the 2.1.107 live default profile by default", () => {
        expect(DEFAULT_SIGNATURE_PROFILE_ID).toBe("cc-2.1.107-live-default-2026-04-14");
        expect(resolveSignatureProfile().id).toBe(DEFAULT_SIGNATURE_PROFILE_ID);
    });

    it("lists the strict default profile and the opt-in Tool Search profile", () => {
        const profiles = listSignatureProfiles();
        expect(profiles.map((profile) => profile.id)).toEqual([
            DEFAULT_SIGNATURE_PROFILE_ID,
            TOOL_SEARCH_SIGNATURE_PROFILE_ID,
        ]);
    });

    it("uses the final Tool Search profile id", () => {
        expect(TOOL_SEARCH_SIGNATURE_PROFILE_ID).toBe("cc-2.1.107-live-tool-search-2026-04-14");
    });

    it("rejects unknown profile names", () => {
        expect(() => resolveSignatureProfile("cc-does-not-exist")).toThrow(/Unknown signature profile/i);
    });

    it("enables Tool Search only on the dedicated opt-in profile", () => {
        expect(resolveSignatureProfile(DEFAULT_SIGNATURE_PROFILE_ID).toolConfig?.toolSearch?.enabled).toBeUndefined();
        expect(resolveSignatureProfile(TOOL_SEARCH_SIGNATURE_PROFILE_ID).toolConfig?.toolSearch?.enabled).toBe(true);
    });

    it("stores the Tool Search beta on the opt-in profile only", () => {
        expect(resolveSignatureProfile(DEFAULT_SIGNATURE_PROFILE_ID).toolConfig?.toolSearch?.beta).toBeUndefined();
        expect(resolveSignatureProfile(TOOL_SEARCH_SIGNATURE_PROFILE_ID).toolConfig?.toolSearch?.beta).toBe(
            "tool_search_tool_regex_20251119",
        );
    });

    it("keeps the default beta fingerprint byte-for-byte unchanged", () => {
        const betas = buildAnthropicBetaHeader(
            "",
            true,
            "claude-haiku-4-5",
            "anthropic",
            undefined,
            undefined,
            "/v1/messages",
            false,
            resolveSignatureProfile(DEFAULT_SIGNATURE_PROFILE_ID),
            false,
        );

        expect(betas).toBe(
            "oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
        );
    });

    it("adds the regex Tool Search beta only when deferred tools are present on non-Haiku models", () => {
        const defaultProfileBetas = buildAnthropicBetaHeader(
            "",
            true,
            "claude-sonnet-4-20250514",
            "anthropic",
            undefined,
            undefined,
            "/v1/messages",
            false,
            resolveSignatureProfile(DEFAULT_SIGNATURE_PROFILE_ID),
            true,
        ).split(",");

        const sonnetBetas = buildAnthropicBetaHeader(
            "",
            true,
            "claude-sonnet-4-20250514",
            "anthropic",
            undefined,
            undefined,
            "/v1/messages",
            false,
            resolveSignatureProfile(TOOL_SEARCH_SIGNATURE_PROFILE_ID),
            true,
        ).split(",");

        const haikuBetas = buildAnthropicBetaHeader(
            "",
            true,
            "claude-haiku-4-5",
            "anthropic",
            undefined,
            undefined,
            "/v1/messages",
            false,
            resolveSignatureProfile(TOOL_SEARCH_SIGNATURE_PROFILE_ID),
            true,
        ).split(",");

        const noDeferredToolBetas = buildAnthropicBetaHeader(
            "",
            true,
            "claude-sonnet-4-20250514",
            "anthropic",
            undefined,
            undefined,
            "/v1/messages",
            false,
            resolveSignatureProfile(TOOL_SEARCH_SIGNATURE_PROFILE_ID),
            false,
        ).split(",");

        expect(defaultProfileBetas).not.toContain("tool_search_tool_regex_20251119");
        expect(sonnetBetas).toContain("tool_search_tool_regex_20251119");
        expect(haikuBetas).not.toContain("tool_search_tool_regex_20251119");
        expect(noDeferredToolBetas).not.toContain("tool_search_tool_regex_20251119");
    });
});
