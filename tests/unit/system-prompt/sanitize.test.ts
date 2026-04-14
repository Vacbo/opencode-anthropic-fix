/**
 * Regex word-boundary regression tests (Task 9 from quality-refactor plan)
 *
 * Verifies that sanitization regexes use \b word boundaries so they don't
 * create false positive matches inside compound words.
 */

import { describe, it, expect } from "vitest";

import { sanitizeSystemText } from "../../../src/system-prompt/sanitize.js";

describe("sanitizeSystemText word boundaries", () => {
    it("replaces the PascalCase word 'OpenCode' with 'Claude Code'", () => {
        const result = sanitizeSystemText("Run OpenCode first", true);
        expect(result).not.toContain("OpenCode");
        expect(result).toContain("Claude Code");
    });

    it("replaces the lowercase word 'opencode' with 'Claude'", () => {
        // Per sanitize.ts, /\bopencode\b/gi → "Claude" (not "Claude Code")
        const result = sanitizeSystemText("use opencode here", true);
        expect(result).not.toContain("opencode");
        expect(result).toContain("Claude");
    });

    it("does NOT replace 'myopencode' (word boundary on left)", () => {
        const result = sanitizeSystemText("the myopencode binary", true);
        expect(result).toContain("myopencode");
    });

    it("does NOT replace 'opencoder' (word boundary on right)", () => {
        const result = sanitizeSystemText("known as opencoder", true);
        expect(result).toContain("opencoder");
    });

    it("does NOT replace 'preopencode' (word boundary on both sides)", () => {
        const result = sanitizeSystemText("run preopencode first", true);
        expect(result).toContain("preopencode");
    });

    it("handles mixed content correctly", () => {
        const result = sanitizeSystemText("use opencode inside myopencode directory", true);
        // Standalone "opencode" becomes "Claude"
        expect(result).toContain("Claude");
        // "myopencode" is preserved because of word boundary
        expect(result).toContain("myopencode");
    });

    it("preserves text when enabled=false", () => {
        const result = sanitizeSystemText("use opencode here", false);
        expect(result).toContain("opencode");
    });

    it("replaces 'Sisyphus' with 'Claude Code Agent'", () => {
        const result = sanitizeSystemText("from the Sisyphus agent", true);
        expect(result).not.toContain("Sisyphus");
        expect(result).toContain("Claude Code Agent");
    });

    it("replaces 'morph_edit' with 'edit' at word boundaries", () => {
        const result = sanitizeSystemText("call morph_edit tool", true);
        expect(result).not.toContain("morph_edit");
        expect(result).toContain("edit");
    });

    // ---------------------------------------------------------------------
    // Regressions for the hyphen/slash word boundary fix.
    // The previous regex used \b which treats `-` and `/` as word boundaries,
    // so `opencode-anthropic-fix` and `/Users/.../opencode/dist` were getting
    // rewritten in place. The new regex uses negative lookarounds for
    // [\w\-/] on both sides so these forms survive verbatim.
    // ---------------------------------------------------------------------

    it("does NOT rewrite 'opencode-anthropic-fix' (hyphen on the right)", () => {
        const result = sanitizeSystemText("Loaded opencode-anthropic-fix from disk", true);
        expect(result).toContain("opencode-anthropic-fix");
        expect(result).not.toContain("Claude-anthropic-fix");
    });

    it("does NOT rewrite 'pre-opencode' (hyphen on the left)", () => {
        const result = sanitizeSystemText("the pre-opencode hook fired", true);
        expect(result).toContain("pre-opencode");
    });

    it("does NOT corrupt path-like strings containing /opencode/", () => {
        const input = "Working dir: /Users/rmk/projects/opencode-auth/src";
        const result = sanitizeSystemText(input, true);
        expect(result).toBe(input);
    });

    it("does NOT corrupt deep paths with multiple opencode segments", () => {
        const input = "/home/user/.config/opencode/plugin/opencode-anthropic-auth-plugin.js";
        const result = sanitizeSystemText(input, true);
        expect(result).toBe(input);
    });

    it("does NOT rewrite the PascalCase form inside hyphenated identifiers", () => {
        const result = sanitizeSystemText("the OpenCode-Plugin loader", true);
        expect(result).toContain("OpenCode-Plugin");
        expect(result).not.toContain("Claude Code-Plugin");
    });

    it("still rewrites a standalone PascalCase 'OpenCode' next to a hyphenated form", () => {
        const result = sanitizeSystemText("OpenCode loaded opencode-anthropic-fix", true);
        expect(result).toContain("Claude Code loaded");
        expect(result).toContain("opencode-anthropic-fix");
    });

    it("defaults to enabled=false (no second arg means no rewriting)", () => {
        const result = sanitizeSystemText("use OpenCode and opencode and Sisyphus and morph_edit");
        expect(result).toBe("use OpenCode and opencode and Sisyphus and morph_edit");
    });

    it("explicit enabled=false preserves text verbatim", () => {
        const input = "Path: /Users/rmk/projects/opencode-anthropic-fix";
        const result = sanitizeSystemText(input, false);
        expect(result).toBe(input);
    });

    it("explicit enabled=true rewrites the standalone forms", () => {
        const result = sanitizeSystemText("use opencode for tasks", true);
        expect(result).toContain("Claude");
        expect(result).not.toContain("opencode");
    });
});
