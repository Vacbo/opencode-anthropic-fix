// ---------------------------------------------------------------------------
// Request body transformation
// ---------------------------------------------------------------------------

import { CLAUDE_CODE_IDENTITY_STRING, KNOWN_IDENTITY_STRINGS } from "../constants.js";
import { buildSystemPromptBlocks } from "../system-prompt/builder.js";
import { normalizeSystemTextBlocks } from "../system-prompt/normalize.js";
import { normalizeThinkingBlock } from "../thinking.js";
import type { RuntimeContext, SignatureConfig } from "../types.js";
import { buildRequestMetadata } from "./metadata.js";

export function transformRequestBody(
  body: string | undefined,
  signature: SignatureConfig,
  runtime: RuntimeContext,
  relocateThirdPartyPrompts = true,
  sanitizeSystemPrompt = false,
  debugLog?: (...args: unknown[]) => void,
): string | undefined {
  if (!body || typeof body !== "string") return body;

  const TOOL_PREFIX = "mcp_";

  try {
    const parsed = JSON.parse(body);
    if (Object.hasOwn(parsed, "betas")) {
      delete parsed.betas;
    }
    // Normalize thinking block for adaptive (Opus 4.6) vs manual (older models).
    if (Object.hasOwn(parsed, "thinking")) {
      parsed.thinking = normalizeThinkingBlock(parsed.thinking, parsed.model || "");
    }
    const hasThinking = parsed.thinking && typeof parsed.thinking === "object" && parsed.thinking.type === "enabled";
    if (hasThinking) {
      delete parsed.temperature;
    } else if (!Object.hasOwn(parsed, "temperature")) {
      parsed.temperature = 1;
    }

    // Sanitize system prompt and inject Claude Code identity/billing blocks.
    const allSystemBlocks = buildSystemPromptBlocks(
      normalizeSystemTextBlocks(parsed.system),
      signature,
      parsed.messages,
      sanitizeSystemPrompt,
    );

    if (signature.enabled && relocateThirdPartyPrompts) {
      // Keep CC blocks in system. Move blocks with third-party identifiers
      // into messages to avoid system prompt content detection.
      const THIRD_PARTY_MARKERS =
        /sisyphus|ohmyclaude|oh\s*my\s*claude|morph[_ ]|\.sisyphus\/|ultrawork|autopilot mode|ohmy|SwarmMode|\bomc\b|\bomo\b/i;

      const ccBlocks: typeof allSystemBlocks = [];
      const extraBlocks: typeof allSystemBlocks = [];
      for (const block of allSystemBlocks) {
        const isBilling = block.text.startsWith("x-anthropic-billing-header:");
        const isIdentity = block.text === CLAUDE_CODE_IDENTITY_STRING || KNOWN_IDENTITY_STRINGS.has(block.text);
        const hasThirdParty = THIRD_PARTY_MARKERS.test(block.text);

        if (isBilling || isIdentity || !hasThirdParty) {
          ccBlocks.push(block);
        } else {
          extraBlocks.push(block);
        }
      }
      parsed.system = ccBlocks;

      // Inject extra blocks as <system-instructions> in the first user message
      if (extraBlocks.length > 0 && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
        const extraText = extraBlocks.map((b) => b.text).join("\n\n");
        const wrapped = `<system-instructions>\n${extraText}\n</system-instructions>`;
        const firstMsg = parsed.messages[0];
        if (firstMsg && firstMsg.role === "user") {
          if (typeof firstMsg.content === "string") {
            firstMsg.content = `${wrapped}\n\n${firstMsg.content}`;
          } else if (Array.isArray(firstMsg.content)) {
            firstMsg.content.unshift({ type: "text", text: wrapped });
          }
        } else {
          // No user message first — prepend a new user message
          parsed.messages.unshift({
            role: "user",
            content: wrapped,
          });
        }
      }
    } else {
      parsed.system = allSystemBlocks;
    }

    if (signature.enabled) {
      const currentMetadata =
        parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
          ? parsed.metadata
          : {};
      parsed.metadata = {
        ...currentMetadata,
        ...buildRequestMetadata({
          persistentUserId: runtime.persistentUserId,
          accountId: runtime.accountId,
          sessionId: runtime.sessionId,
        }),
      };
    }

    // Add prefix to tools definitions
    if (parsed.tools && Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool: Record<string, unknown>) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }));
    }
    // Add prefix to tool_use blocks in messages
    if (parsed.messages && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((msg: Record<string, unknown>) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block: Record<string, unknown>) => {
            if (block.type === "tool_use" && block.name) {
              return {
                ...block,
                name: `${TOOL_PREFIX}${block.name}`,
              };
            }
            return block;
          });
        }
        return msg;
      });
    }
    return JSON.stringify(parsed);
  } catch (err) {
    debugLog?.("body parse failed:", (err as Error).message);
    return body;
  }
}
