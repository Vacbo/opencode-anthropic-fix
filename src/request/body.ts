// ---------------------------------------------------------------------------
// Request body transformation
// ---------------------------------------------------------------------------

import { buildSystemPromptBlocks } from "../system-prompt/builder.js";
import { normalizeSystemTextBlocks } from "../system-prompt/normalize.js";
import { normalizeThinkingBlock } from "../thinking.js";
import type { RuntimeContext, SignatureConfig } from "../types.js";
import { buildRequestMetadata } from "./metadata.js";

export function transformRequestBody(
  body: string | undefined,
  signature: SignatureConfig,
  runtime: RuntimeContext,
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

    // Sanitize system prompt and optionally inject Claude Code identity/billing blocks.
    parsed.system = buildSystemPromptBlocks(normalizeSystemTextBlocks(parsed.system), signature, parsed.messages);

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
  } catch {
    // ignore parse errors
    return body;
  }
}
