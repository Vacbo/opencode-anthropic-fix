// Characterization tests for resolveBetaShortcut (src/betas.ts).
//
// The plan attributed this helper to env.ts, but `rg` confirms it lives in
// betas.ts. Pinning its behavior here so the beta alias contract survives any
// future reshuffle between betas.ts, env.ts, and the slash-command handlers.

import { describe, expect, it } from "vitest";
import { resolveBetaShortcut } from "../../src/betas.js";
import { BETA_SHORTCUTS } from "../../src/constants.js";

describe("resolveBetaShortcut", () => {
    it("returns empty string for undefined", () => {
        expect(resolveBetaShortcut(undefined)).toBe("");
    });

    it("returns empty string for empty input", () => {
        expect(resolveBetaShortcut("")).toBe("");
    });

    it("resolves every registered shortcut alias (case-insensitive)", () => {
        for (const [alias, fullName] of BETA_SHORTCUTS) {
            expect(resolveBetaShortcut(alias)).toBe(fullName);
            expect(resolveBetaShortcut(alias.toUpperCase())).toBe(fullName);
        }
    });

    it("trims surrounding whitespace before lookup", () => {
        expect(resolveBetaShortcut("  1m  ")).toBe("context-1m-2025-08-07");
    });

    it("passes through unknown values verbatim after trim", () => {
        expect(resolveBetaShortcut("unknown-beta-2026-99-99")).toBe("unknown-beta-2026-99-99");
        expect(resolveBetaShortcut("  custom-beta  ")).toBe("custom-beta");
    });

    it("preserves case for non-matching input", () => {
        expect(resolveBetaShortcut("Custom-Beta")).toBe("Custom-Beta");
    });
});
