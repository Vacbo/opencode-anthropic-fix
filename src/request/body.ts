// ---------------------------------------------------------------------------
// Request body transformation
// ---------------------------------------------------------------------------

import { CLAUDE_CODE_IDENTITY_STRING, KNOWN_IDENTITY_STRINGS } from "../constants.js";
import { buildSystemPromptBlocks } from "../system-prompt/builder.js";
import { normalizeSystemTextBlocks } from "../system-prompt/normalize.js";
import { normalizeThinkingBlock } from "../thinking.js";
import type { RuntimeContext, SignatureConfig } from "../types.js";
import { buildRequestMetadata } from "./metadata.js";

const TOOL_PREFIX = "mcp_";

function getBodyType(body: unknown): string {
  if (body === null) return "null";
  return typeof body;
}

function getInvalidBodyError(body: unknown): TypeError {
  return new TypeError(
    `opencode-anthropic-auth: expected string body, got ${getBodyType(body)}. This plugin does not support stream bodies. Please file a bug with the OpenCode version.`,
  );
}

export function validateBodyType(body: unknown, throwOnInvalid = false): body is string {
  if (body === undefined || body === null) {
    return false;
  }

  if (typeof body === "string") {
    return true;
  }

  if (throwOnInvalid) {
    throw getInvalidBodyError(body);
  }

  return false;
}

export function cloneBodyForRetry(body: string): string {
  validateBodyType(body, true);
  return body;
}

export function detectDoublePrefix(name: string): boolean {
  return name.startsWith(`${TOOL_PREFIX}${TOOL_PREFIX}`);
}

export function extractToolNamesFromBody(body: string): string[] {
  const parsed = JSON.parse(body) as {
    tools?: Array<{ name?: unknown }>;
    messages?: Array<{ content?: unknown }>;
  };
  const names: string[] = [];

  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (typeof tool?.name === "string") {
        names.push(tool.name);
      }
    }
  }

  if (Array.isArray(parsed.messages)) {
    for (const message of parsed.messages) {
      if (!Array.isArray(message?.content)) {
        continue;
      }

      for (const block of message.content) {
        if (
          block &&
          typeof block === "object" &&
          "type" in block &&
          block.type === "tool_use" &&
          "name" in block &&
          typeof block.name === "string"
        ) {
          names.push(block.name);
        }
      }
    }
  }

  return names;
}

function prefixToolDefinitionName(name: unknown): unknown {
  if (typeof name !== "string") {
    return name;
  }

  if (detectDoublePrefix(name)) {
    throw new TypeError(`Double tool prefix detected: ${TOOL_PREFIX}${TOOL_PREFIX}`);
  }

  return `${TOOL_PREFIX}${name}`;
}

function prefixToolUseName(
  name: unknown,
  literalToolNames: ReadonlySet<string>,
  debugLog?: (...args: unknown[]) => void,
): unknown {
  if (typeof name !== "string") {
    return name;
  }

  if (detectDoublePrefix(name)) {
    throw new TypeError(`Double tool prefix detected in tool_use block: ${name}`);
  }

  if (!name.startsWith(TOOL_PREFIX)) {
    return `${TOOL_PREFIX}${name}`;
  }

  if (literalToolNames.has(name)) {
    return `${TOOL_PREFIX}${name}`;
  }

  debugLog?.("prevented double-prefix drift for tool_use block", { name });
  return name;
}

export function transformRequestBody(
  body: string | undefined,
  signature: SignatureConfig,
  runtime: RuntimeContext,
  relocateThirdPartyPrompts = true,
  debugLog?: (...args: unknown[]) => void,
): string | undefined {
  if (body === undefined || body === null) return body;
  validateBodyType(body, true);

  try {
    const parsed = JSON.parse(body) as Record<string, unknown> & {
      tools?: Array<Record<string, unknown>>;
      messages?: Array<Record<string, unknown>>;
      thinking?: unknown;
      model?: string;
      metadata?: Record<string, unknown>;
      system?: unknown[] | undefined;
    };
    const parsedMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const literalToolNames = new Set<string>(
      Array.isArray(parsed.tools)
        ? parsed.tools
            .map((tool: Record<string, unknown>) => tool.name)
            .filter((name: unknown): name is string => typeof name === "string")
        : [],
    );

    if (Object.hasOwn(parsed, "betas")) {
      delete parsed.betas;
    }
    // Normalize thinking block for adaptive (Opus 4.6) vs manual (older models).
    if (Object.hasOwn(parsed, "thinking")) {
      parsed.thinking = normalizeThinkingBlock(parsed.thinking as unknown, parsed.model || "");
    }
    const hasThinking =
      parsed.thinking &&
      typeof parsed.thinking === "object" &&
      (parsed.thinking as { type?: string }).type === "enabled";
    if (hasThinking) {
      delete parsed.temperature;
    } else if (!Object.hasOwn(parsed, "temperature")) {
      parsed.temperature = 1;
    }

    // Sanitize system prompt and inject Claude Code identity/billing blocks.
    const allSystemBlocks = buildSystemPromptBlocks(
      normalizeSystemTextBlocks(parsed.system),
      signature,
      parsedMessages,
    );

    if (signature.enabled && relocateThirdPartyPrompts) {
      // Keep CC blocks in system. Move blocks with third-party identifiers
      // into messages to avoid system prompt content detection.
      const THIRD_PARTY_MARKERS =
        /sisyphus|ohmyclaude|oh\s*my\s*claude|morph[_ ]|\.sisyphus\/|ultrawork|autopilot mode|\bohmy\b|SwarmMode|\bomc\b|\bomo\b/i;

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
        name: prefixToolDefinitionName(tool.name),
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
                name: prefixToolUseName(block.name, literalToolNames, debugLog),
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
    if (err instanceof SyntaxError) {
      debugLog?.("body parse failed:", err.message);
      return body;
    }

    throw err;
  }
}
