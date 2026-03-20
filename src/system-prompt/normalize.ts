// ---------------------------------------------------------------------------
// System prompt normalization helpers
// ---------------------------------------------------------------------------

import type { SystemBlock } from "../types.js";

export function normalizeSystemTextForComparison(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function dedupeSystemBlocks(system: SystemBlock[]): SystemBlock[] {
  const exactSeen = new Set<string>();
  const exactDeduped: SystemBlock[] = [];

  for (const item of system) {
    const normalized = normalizeSystemTextForComparison(item.text);
    const key = `${item.type}:${normalized}`;
    if (exactSeen.has(key)) continue;
    exactSeen.add(key);
    exactDeduped.push(item);
  }

  const normalizedBlocks = exactDeduped.map((item) => normalizeSystemTextForComparison(item.text));
  return exactDeduped.filter((_, index) => {
    const current = normalizedBlocks[index];
    if (current.length < 80) return true;

    for (let otherIndex = 0; otherIndex < normalizedBlocks.length; otherIndex += 1) {
      if (otherIndex === index) continue;
      const other = normalizedBlocks[otherIndex];
      if (other.length <= current.length + 20) continue;
      if (other.includes(current)) return false;
    }

    return true;
  });
}

export function isTitleGeneratorSystemText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return normalized.includes("you are a title generator") || normalized.includes("generate a brief title");
}

export function isTitleGeneratorSystemBlocks(system: SystemBlock[]): boolean {
  return system.some(
    (item) => item.type === "text" && typeof item.text === "string" && isTitleGeneratorSystemText(item.text),
  );
}

export function normalizeSystemTextBlocks(system: unknown[] | undefined): SystemBlock[] {
  const output: SystemBlock[] = [];
  if (!Array.isArray(system)) return output;

  for (const item of system) {
    if (typeof item === "string") {
      output.push({ type: "text", text: item });
      continue;
    }

    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.text !== "string") continue;

    const normalized: SystemBlock = {
      type: typeof obj.type === "string" ? obj.type : "text",
      text: obj.text,
    };

    if (obj.cache_control && typeof obj.cache_control === "object" && !Array.isArray(obj.cache_control)) {
      normalized.cache_control = obj.cache_control as { type: string };
    } else if (typeof obj.cacheScope === "string" && obj.cacheScope) {
      // Backward compatibility for older shape used by this plugin.
      normalized.cache_control = { type: "ephemeral" };
    }

    output.push(normalized);
  }

  return output;
}
