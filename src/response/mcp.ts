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

function stripMcpPrefixFromToolUseBlock(block: unknown): boolean {
    if (!block || typeof block !== "object") return false;

    const parsedBlock = block as Record<string, unknown>;
    if (parsedBlock.type !== "tool_use" || typeof parsedBlock.name !== "string") {
        return false;
    }

    if (!parsedBlock.name.startsWith("mcp_")) {
        return false;
    }

    parsedBlock.name = parsedBlock.name.slice(4);
    return true;
}

function stripMcpPrefixFromContentBlocks(content: unknown): boolean {
    if (!Array.isArray(content)) return false;

    let modified = false;
    for (const block of content) {
        modified = stripMcpPrefixFromToolUseBlock(block) || modified;
    }

    return modified;
}

function stripMcpPrefixFromMessages(messages: unknown): boolean {
    if (!Array.isArray(messages)) return false;

    let modified = false;
    for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        modified = stripMcpPrefixFromContentBlocks((message as Record<string, unknown>).content) || modified;
    }

    return modified;
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
    modified = stripMcpPrefixFromToolUseBlock(p.content_block) || modified;

    // message_start: { message: { content: [{ type: "tool_use", name: "mcp_..." }] } }
    if (p.message && typeof p.message === "object") {
        modified = stripMcpPrefixFromContentBlocks((p.message as Record<string, unknown>).content) || modified;
    }

    // Top-level content array (non-streaming responses forwarded through SSE)
    modified = stripMcpPrefixFromContentBlocks(p.content) || modified;

    return modified;
}

export function stripMcpPrefixFromJsonBody(body: string): string {
    try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        let modified = false;

        modified = stripMcpPrefixFromContentBlocks(parsed.content) || modified;
        modified = stripMcpPrefixFromMessages(parsed.messages) || modified;
        if (parsed.message && typeof parsed.message === "object") {
            modified = stripMcpPrefixFromContentBlocks((parsed.message as Record<string, unknown>).content) || modified;
        }

        return modified ? JSON.stringify(parsed) : body;
    } catch {
        return body;
    }
}
