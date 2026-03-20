// ---------------------------------------------------------------------------
// Response streaming helpers
// ---------------------------------------------------------------------------

import { isAccountSpecificError, parseRateLimitReason } from "../backoff.js";
import type { UsageStats } from "../types.js";
import { stripMcpPrefixFromSSE } from "./mcp.js";

/**
 * Update running usage stats from a parsed SSE event.
 */
export function extractUsageFromSSEEvent(parsed: unknown, stats: UsageStats): void {
  const p = parsed as Record<string, unknown> | null;
  if (!p) return;

  // message_delta: cumulative usage (preferred, overwrites)
  if (p.type === "message_delta" && p.usage) {
    const u = p.usage as Record<string, unknown>;
    if (typeof u.input_tokens === "number") stats.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") stats.outputTokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") stats.cacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") stats.cacheWriteTokens = u.cache_creation_input_tokens;
    return;
  }

  // message_start: initial usage (only set if we haven't seen message_delta yet)
  if (p.type === "message_start") {
    const msg = p.message as Record<string, unknown> | undefined;
    if (msg?.usage) {
      const u = msg.usage as Record<string, unknown>;
      if (stats.inputTokens === 0 && typeof u.input_tokens === "number") {
        stats.inputTokens = u.input_tokens;
      }
      if (stats.cacheReadTokens === 0 && typeof u.cache_read_input_tokens === "number") {
        stats.cacheReadTokens = u.cache_read_input_tokens;
      }
      if (stats.cacheWriteTokens === 0 && typeof u.cache_creation_input_tokens === "number") {
        stats.cacheWriteTokens = u.cache_creation_input_tokens;
      }
    }
  }
}

/**
 * Extract the combined SSE data payload from one event block.
 */
export function getSSEDataPayload(eventBlock: string): string | null {
  if (!eventBlock) return null;

  const dataLines: string[] = [];
  for (const line of eventBlock.split("\n")) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (!payload || payload === "[DONE]") return null;
  return payload;
}

/**
 * Parse one SSE event payload and return account-error details if present.
 */
export function getMidStreamAccountError(parsed: unknown): {
  reason: string;
  invalidateToken: boolean;
} | null {
  const p = parsed as Record<string, unknown> | null;
  if (!p || p.type !== "error" || !p.error) {
    return null;
  }

  const err = p.error as Record<string, unknown>;
  const errorBody = {
    error: {
      type: String(err.type || ""),
      message: String(err.message || ""),
    },
  };

  // Mid-stream errors do not include a reliable HTTP status. Use 400-style
  // body parsing to identify account-specific errors.
  if (!isAccountSpecificError(400, errorBody)) {
    return null;
  }

  const reason = parseRateLimitReason(400, errorBody);

  return {
    reason,
    invalidateToken: reason === "AUTH_FAILED",
  };
}

/**
 * Wrap a response body stream to strip mcp_ prefix from tool names,
 * extract token usage stats from SSE events, and detect mid-stream
 * account-specific errors.
 */
export function transformResponse(
  response: Response,
  onUsage?: ((stats: UsageStats) => void) | null,
  onAccountError?: ((details: { reason: string; invalidateToken: boolean }) => void) | null,
): Response {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const EMPTY_CHUNK = new Uint8Array();

  const stats: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let sseBuffer = "";
  let sseRewriteBuffer = "";
  let accountErrorHandled = false;

  function processSSEBuffer(flush = false): void {
    while (true) {
      const boundary = sseBuffer.indexOf("\n\n");

      if (boundary === -1) {
        if (!flush) return;
        if (!sseBuffer.trim()) {
          sseBuffer = "";
          return;
        }
      }

      const eventBlock = boundary === -1 ? sseBuffer : sseBuffer.slice(0, boundary);
      sseBuffer = boundary === -1 ? "" : sseBuffer.slice(boundary + 2);

      const payload = getSSEDataPayload(eventBlock);
      if (!payload) {
        if (boundary === -1) return;
        continue;
      }

      try {
        const parsed = JSON.parse(payload);

        if (onUsage) {
          extractUsageFromSSEEvent(parsed, stats);
        }

        if (onAccountError && !accountErrorHandled) {
          const details = getMidStreamAccountError(parsed);
          if (details) {
            accountErrorHandled = true;
            onAccountError(details);
          }
        }
      } catch {
        // Ignore malformed event payloads.
      }

      if (boundary === -1) return;
    }
  }

  function rewriteSSEChunk(chunk: string, flush = false): string {
    sseRewriteBuffer += chunk;

    if (!flush) {
      const boundary = sseRewriteBuffer.lastIndexOf("\n");
      if (boundary === -1) return "";
      const complete = sseRewriteBuffer.slice(0, boundary + 1);
      sseRewriteBuffer = sseRewriteBuffer.slice(boundary + 1);
      return stripMcpPrefixFromSSE(complete);
    }

    if (!sseRewriteBuffer) return "";
    const finalText = stripMcpPrefixFromSSE(sseRewriteBuffer);
    sseRewriteBuffer = "";
    return finalText;
  }

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        processSSEBuffer(true);

        const rewrittenTail = rewriteSSEChunk("", true);
        if (rewrittenTail) {
          controller.enqueue(encoder.encode(rewrittenTail));
        }

        if (
          onUsage &&
          (stats.inputTokens > 0 || stats.outputTokens > 0 || stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0)
        ) {
          onUsage(stats);
        }
        controller.close();
        return;
      }

      const text = decoder.decode(value, { stream: true });

      if (onUsage || onAccountError) {
        // Normalize CRLF for parser only; preserve original bytes for passthrough.
        sseBuffer += text.replace(/\r\n/g, "\n");
        processSSEBuffer(false);
      }

      const rewrittenText = rewriteSSEChunk(text, false);
      if (rewrittenText) {
        controller.enqueue(encoder.encode(rewrittenText));
      } else {
        // Keep the pull/read loop progressing when this chunk only extends a
        // partial line buffered for later rewrite.
        controller.enqueue(EMPTY_CHUNK);
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Check whether a response is an SSE event stream.
 */
export function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/event-stream");
}
