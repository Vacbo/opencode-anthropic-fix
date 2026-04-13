// ---------------------------------------------------------------------------
// System prompt sanitization helpers
// ---------------------------------------------------------------------------

import { CLAUDE_CODE_IDENTITY_STRING } from "../constants.js";
import type { PromptCompactionMode } from "../types.js";

/**
 * Optionally rewrite OpenCode/OhMyClaude/Sisyphus/Morph identifiers in system
 * prompt text. Disabled by default — the plugin's primary defense is to
 * relocate non-Claude-Code blocks into the user message wrapper instead of
 * scrubbing strings in place. Sanitization is opt-in via the
 * `sanitize_system_prompt` config flag for users who want both defenses.
 *
 * Word-boundary lookarounds reject hyphens and slashes on either side so the
 * regex does not corrupt file paths, package names, or repo identifiers like
 * `opencode-anthropic-fix` or `/path/to/opencode/dist`.
 */
export function sanitizeSystemText(text: string, enabled = false): string {
    if (!enabled) return text;
    return text
        .replace(/(?<![\w\-/])OpenCode(?![\w\-/])/g, "Claude Code")
        .replace(/(?<![\w\-/])opencode(?![\w\-/])/gi, "Claude")
        .replace(/OhMyClaude\s*Code/gi, "Claude Code")
        .replace(/OhMyClaudeCode/gi, "Claude Code")
        .replace(/(?<![\w\-/])Sisyphus(?![\w\-/])/g, "Claude Code Agent")
        .replace(/(?<![\w\-/])Morph\s+plugin(?![\w\-/])/gi, "edit plugin")
        .replace(/(?<![\w\-/])morph_edit(?![\w\-/])/g, "edit")
        .replace(/(?<![\w\-/])morph_/g, "")
        .replace(/(?<![\w\-/])OhMyClaude(?![\w\-/])/gi, "Claude");
}

export function compactSystemText(text: string, mode: PromptCompactionMode): string {
    const withoutDuplicateIdentityPrefix = text.startsWith(`${CLAUDE_CODE_IDENTITY_STRING}\n`)
        ? text.slice(CLAUDE_CODE_IDENTITY_STRING.length).trimStart()
        : text;

    if (mode === "off") {
        return withoutDuplicateIdentityPrefix.trim();
    }

    const compacted = withoutDuplicateIdentityPrefix.replace(/<example>[\s\S]*?<\/example>/gi, "\n");

    const dedupedLines: string[] = [];
    let prevNormalized = "";
    for (const line of compacted.split("\n")) {
        const normalized = line.trim();
        if (normalized && normalized === prevNormalized) continue;
        dedupedLines.push(line);
        prevNormalized = normalized;
    }

    return dedupedLines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
