type Block = { type?: unknown; id?: unknown; tool_use_id?: unknown; [key: string]: unknown };
type Message = { role?: unknown; content?: unknown; [key: string]: unknown };

function isToolUseBlock(block: unknown): block is Block & { id: string } {
    if (block == null || typeof block !== "object") return false;
    const b = block as Block;
    return b.type === "tool_use" && typeof b.id === "string";
}

function isToolResultBlock(block: unknown): block is Block & { tool_use_id: string } {
    if (block == null || typeof block !== "object") return false;
    const b = block as Block;
    return b.type === "tool_result" && typeof b.tool_use_id === "string";
}

function blockArray(content: unknown): Block[] | null {
    return Array.isArray(content) ? (content as Block[]) : null;
}

export interface RepairResult {
    removedToolUses: string[];
    removedToolResults: string[];
}

export function repairToolPairs(
    messages: Message[],
): { messages: Message[]; repair: RepairResult } {
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    for (const message of messages) {
        const blocks = blockArray(message?.content);
        if (!blocks) continue;
        for (const block of blocks) {
            if (isToolUseBlock(block)) toolUseIds.add(block.id);
            else if (isToolResultBlock(block)) toolResultIds.add(block.tool_use_id);
        }
    }

    const orphanedUses = new Set<string>();
    const orphanedResults = new Set<string>();

    for (const id of toolUseIds) {
        if (!toolResultIds.has(id)) orphanedUses.add(id);
    }
    for (const id of toolResultIds) {
        if (!toolUseIds.has(id)) orphanedResults.add(id);
    }

    if (orphanedUses.size === 0 && orphanedResults.size === 0) {
        return { messages, repair: { removedToolUses: [], removedToolResults: [] } };
    }

    const repaired: Message[] = [];
    for (const message of messages) {
        const blocks = blockArray(message?.content);
        if (!blocks) {
            repaired.push(message);
            continue;
        }

        const keptBlocks = blocks.filter((block) => {
            if (isToolUseBlock(block) && orphanedUses.has(block.id)) return false;
            if (isToolResultBlock(block) && orphanedResults.has(block.tool_use_id)) return false;
            return true;
        });

        if (keptBlocks.length === 0) continue;
        repaired.push({ ...message, content: keptBlocks });
    }

    return {
        messages: repaired,
        repair: {
            removedToolUses: [...orphanedUses],
            removedToolResults: [...orphanedResults],
        },
    };
}
