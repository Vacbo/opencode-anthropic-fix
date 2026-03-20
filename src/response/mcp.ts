// ---------------------------------------------------------------------------
// MCP prefix stripping for SSE responses
// ---------------------------------------------------------------------------

/**
 * Strip `mcp_` prefix from tool_use `name` fields in SSE data lines.
 * Only modifies `name` values inside content blocks with `"type": "tool_use"`.
 * Non-JSON lines and text blocks are left untouched.
 */
export function stripMcpPrefixFromSSE(text: string): string {
  return text.replace(/^data:\s*(.+)$/gm, (_match, jsonStr: string) => {
    try {
      const parsed = JSON.parse(jsonStr);
      if (stripMcpPrefixFromParsedEvent(parsed)) {
        return `data: ${JSON.stringify(parsed)}`;
      }
    } catch {
      // Not valid JSON — pass through unchanged.
    }
    return _match;
  });
}

/**
 * Mutate a parsed SSE event object, removing `mcp_` prefix from tool_use
 * name fields. Returns true if any modification was made.
 */
export function stripMcpPrefixFromParsedEvent(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;

  const p = parsed as Record<string, unknown>;
  let modified = false;

  // content_block_start: { content_block: { type: "tool_use", name: "mcp_..." } }
  if (
    p.content_block &&
    typeof p.content_block === "object" &&
    (p.content_block as Record<string, unknown>).type === "tool_use" &&
    typeof (p.content_block as Record<string, unknown>).name === "string" &&
    ((p.content_block as Record<string, unknown>).name as string).startsWith("mcp_")
  ) {
    (p.content_block as Record<string, unknown>).name = (
      (p.content_block as Record<string, unknown>).name as string
    ).slice(4);
    modified = true;
  }

  // message_start: { message: { content: [{ type: "tool_use", name: "mcp_..." }] } }
  if (p.message && Array.isArray((p.message as Record<string, unknown>).content)) {
    for (const block of (p.message as Record<string, unknown>).content as unknown[]) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.name === "string" && b.name.startsWith("mcp_")) {
        b.name = b.name.slice(4);
        modified = true;
      }
    }
  }

  // Top-level content array (non-streaming responses forwarded through SSE)
  if (Array.isArray(p.content)) {
    for (const block of p.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.name === "string" && b.name.startsWith("mcp_")) {
        b.name = b.name.slice(4);
        modified = true;
      }
    }
  }

  return modified;
}
