// ---------------------------------------------------------------------------
// System prompt block builder
// ---------------------------------------------------------------------------

import {
  CLAUDE_CODE_IDENTITY_STRING,
  COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT,
  KNOWN_IDENTITY_STRINGS,
} from "../constants.js";
import { buildAnthropicBillingHeader } from "../headers/billing.js";
import type { SignatureConfig, SystemBlock } from "../types.js";
import { dedupeSystemBlocks, isTitleGeneratorSystemBlocks } from "./normalize.js";
import { compactSystemText, sanitizeSystemText } from "./sanitize.js";

export function buildSystemPromptBlocks(
  system: SystemBlock[],
  signature: SignatureConfig,
  messages: unknown[],
): SystemBlock[] {
  const titleGeneratorRequest = isTitleGeneratorSystemBlocks(system);

  let sanitized: SystemBlock[] = system.map((item) => ({
    ...item,
    text: compactSystemText(sanitizeSystemText(item.text), signature.promptCompactionMode),
  }));

  if (titleGeneratorRequest) {
    sanitized = [{ type: "text", text: COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT }];
  } else if (signature.promptCompactionMode !== "off") {
    sanitized = dedupeSystemBlocks(sanitized);
  }

  if (!signature.enabled) {
    return sanitized;
  }

  const filtered = sanitized.filter(
    (item) => !item.text.startsWith("x-anthropic-billing-header:") && !KNOWN_IDENTITY_STRINGS.has(item.text),
  );

  const blocks: SystemBlock[] = [];
  const billingHeader = buildAnthropicBillingHeader(signature.claudeCliVersion, messages);
  if (billingHeader) {
    blocks.push({ type: "text", text: billingHeader });
  }

  blocks.push({
    type: "text",
    text: CLAUDE_CODE_IDENTITY_STRING,
    cache_control: { type: "ephemeral" },
  });
  blocks.push(...filtered);

  return blocks;
}
