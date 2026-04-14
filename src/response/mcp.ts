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

function stripMcpPrefix(value: string): string | null {
    return value.startsWith("mcp_") ? value.slice(4) : null;
}

function stripMcpPrefixFromToolNameField(block: Record<string, unknown>, field: "name" | "tool_name"): boolean {
    if (typeof block[field] !== "string") {
        return false;
    }

    const strippedName = stripMcpPrefix(block[field]);
    if (!strippedName) {
        return false;
    }

    block[field] = strippedName;
    return true;
}

function stripMcpPrefixFromToolUseBlock(block: unknown): boolean {
    if (!block || typeof block !== "object") return false;

    const parsedBlock = block as Record<string, unknown>;
    if (parsedBlock.type !== "tool_use" && parsedBlock.type !== "server_tool_use") {
        return false;
    }

    return stripMcpPrefixFromToolNameField(parsedBlock, "name");
}

function stripMcpPrefixFromToolReferenceBlock(block: unknown): boolean {
    if (!block || typeof block !== "object") return false;

    const parsedBlock = block as Record<string, unknown>;
    if (parsedBlock.type !== "tool_reference") {
        return false;
    }

    return stripMcpPrefixFromToolNameField(parsedBlock, "tool_name");
}

function stripMcpPrefixFromToolSearchToolResultBlock(block: unknown): boolean {
    if (!block || typeof block !== "object") return false;

    const parsedBlock = block as Record<string, unknown>;
    if (parsedBlock.type !== "tool_search_tool_result") {
        return false;
    }

    const content = parsedBlock.content;
    if (!content || typeof content !== "object") {
        return false;
    }

    const toolReferences = (content as Record<string, unknown>).tool_references;
    if (!Array.isArray(toolReferences)) {
        return false;
    }

    let modified = false;
    for (const toolReference of toolReferences) {
        modified = stripMcpPrefixFromToolReferenceBlock(toolReference) || modified;
    }

    return modified;
}

function stripMcpPrefixFromContentBlock(block: unknown): boolean {
    return (
        stripMcpPrefixFromToolUseBlock(block) ||
        stripMcpPrefixFromToolReferenceBlock(block) ||
        stripMcpPrefixFromToolSearchToolResultBlock(block)
    );
}

function stripMcpPrefixFromContentBlocks(content: unknown): boolean {
    if (!Array.isArray(content)) return false;

    let modified = false;
    for (const block of content) {
        modified = stripMcpPrefixFromContentBlock(block) || modified;
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

    // content_block_start: { content_block: { type: "tool_use" | "server_tool_use" | ... } }
    modified = stripMcpPrefixFromContentBlock(p.content_block) || modified;

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
