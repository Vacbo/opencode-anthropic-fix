import { describe, expect, it } from "vitest";
import { repairToolPairs } from "../../../src/request/tool-pair-repair.js";

describe("repairToolPairs", () => {
    it("returns messages unchanged when all pairs are valid", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "running" },
                    { type: "tool_use", id: "t_1", name: "Bash", input: { command: "ls" } },
                ],
            },
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "t_1", content: "output" }],
            },
        ];

        const { messages: result, repair } = repairToolPairs(messages);

        expect(result).toEqual(messages);
        expect(repair.removedToolUses).toEqual([]);
        expect(repair.removedToolResults).toEqual([]);
    });

    it("removes an orphaned tool_use block when no matching tool_result exists", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "thinking" },
                    { type: "tool_use", id: "t_orphan", name: "Read", input: {} },
                ],
            },
            { role: "user", content: [{ type: "text", text: "continue" }] },
        ];

        const { messages: result, repair } = repairToolPairs(messages);

        expect(repair.removedToolUses).toEqual(["t_orphan"]);
        expect(repair.removedToolResults).toEqual([]);
        expect(result[0]?.content).toEqual([{ type: "text", text: "thinking" }]);
    });

    it("removes an orphaned tool_result when its tool_use is missing", () => {
        const messages = [
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "t_missing", content: "stale" }],
            },
            { role: "assistant", content: [{ type: "text", text: "noted" }] },
        ];

        const { messages: result, repair } = repairToolPairs(messages);

        expect(repair.removedToolUses).toEqual([]);
        expect(repair.removedToolResults).toEqual(["t_missing"]);
        expect(result).toHaveLength(1);
        expect(result[0]?.content).toEqual([{ type: "text", text: "noted" }]);
    });

    it("drops a message entirely when all its blocks were orphaned", () => {
        const messages = [
            {
                role: "assistant",
                content: [{ type: "tool_use", id: "t_only", name: "Bash", input: {} }],
            },
            { role: "user", content: [{ type: "text", text: "hello" }] },
        ];

        const { messages: result } = repairToolPairs(messages);

        expect(result).toHaveLength(1);
        expect(result[0]?.role).toBe("user");
    });

    it("handles mixed orphans across multiple messages", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "tool_use", id: "t_1", name: "Bash", input: {} },
                    { type: "tool_use", id: "t_2", name: "Read", input: {} },
                ],
            },
            {
                role: "user",
                content: [
                    { type: "tool_result", tool_use_id: "t_1", content: "ok" },
                    { type: "tool_result", tool_use_id: "t_stale", content: "stale" },
                ],
            },
        ];

        const { messages: result, repair } = repairToolPairs(messages);

        expect(repair.removedToolUses.sort()).toEqual(["t_2"]);
        expect(repair.removedToolResults.sort()).toEqual(["t_stale"]);
        const assistantBlocks = result[0]?.content as Array<{ id: string }>;
        expect(assistantBlocks.map((b) => b.id)).toEqual(["t_1"]);
    });

    it("ignores messages with non-array content (string-style)", () => {
        const messages = [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" },
        ];

        const { messages: result, repair } = repairToolPairs(messages);

        expect(result).toEqual(messages);
        expect(repair.removedToolUses).toEqual([]);
        expect(repair.removedToolResults).toEqual([]);
    });

    it("skips tool_use blocks without a string id (malformed input)", () => {
        const messages = [
            {
                role: "assistant",
                content: [{ type: "tool_use", id: 42, name: "X", input: {} }],
            },
        ];

        const { messages: result, repair } = repairToolPairs(messages);

        expect(result).toEqual(messages);
        expect(repair.removedToolUses).toEqual([]);
    });
});
