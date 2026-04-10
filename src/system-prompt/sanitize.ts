// ---------------------------------------------------------------------------
// System prompt sanitization helpers
// ---------------------------------------------------------------------------

import { CLAUDE_CODE_IDENTITY_STRING } from "../constants.js";
import type { PromptCompactionMode } from "../types.js";

export function sanitizeSystemText(text: string, enabled = true): string {
  if (!enabled) return text;
  return text
    .replace(/\bOpenCode\b/g, "Claude Code")
    .replace(/\bopencode\b/gi, "Claude")
    .replace(/OhMyClaude\s*Code/gi, "Claude Code")
    .replace(/OhMyClaudeCode/gi, "Claude Code")
    .replace(/\bSisyphus\b/g, "Claude Code Agent")
    .replace(/\bMorph\s+plugin\b/gi, "edit plugin")
    .replace(/\bmorph_edit\b/g, "edit")
    .replace(/\bmorph_/g, "")
    .replace(/\bOhMyClaude\b/gi, "Claude");
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
