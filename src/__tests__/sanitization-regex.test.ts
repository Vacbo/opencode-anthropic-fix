/**
 * Regex word-boundary regression tests (Task 9 from quality-refactor plan)
 *
 * Verifies that sanitization regexes use \b word boundaries so they don't
 * create false positive matches inside compound words.
 */

import { describe, it, expect } from "vitest";

import { sanitizeSystemText } from "../system-prompt/sanitize.js";

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
});
