import { describe, expect, it } from "vitest";

import { transformRequestBody } from "../../../src/request/body.js";
import { stripMcpPrefixFromJsonBody } from "../../../src/response/mcp.js";
import type { RuntimeContext, SignatureConfig } from "../../../src/types.js";

const mockRuntime: RuntimeContext = {
    persistentUserId: "user-123",
    accountId: "acc-456",
    sessionId: "sess-789",
};

const mockSignature: SignatureConfig = {
    enabled: true,
    claudeCliVersion: "2.1.110",
    promptCompactionMode: "minimal",
};

describe("wire tool naming compatibility", () => {
    it("emits Claude-native names for native-equivalent tools and PascalCase aliases for others", () => {
        const body = JSON.stringify({
            model: "claude-opus-4-6",
            messages: [{ role: "user", content: "hi" }],
            tools: [
                { name: "bash", description: "bash" },
                { name: "read", description: "read" },
                { name: "codesearch", description: "codesearch" },
                { name: "lsp_goto_definition", description: "lsp" },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.tools.map((tool: { name: string }) => tool.name)).toEqual([
            "Bash",
            "Read",
            "Codesearch",
            "LspGotoDefinition",
        ]);
    });

    it("maps tool_use names back to internal opencode names in JSON responses", () => {
        const responseBody = JSON.stringify({
            content: [
                {
                    type: "tool_use",
                    name: "Bash",
                    input: { command: "pwd" },
                },
                {
                    type: "tool_use",
                    name: "Codesearch",
                    input: { query: "x" },
                },
            ],
        });

        const transformed = JSON.parse(stripMcpPrefixFromJsonBody(responseBody));

        expect(transformed.content[0].name).toBe("bash");
        expect(transformed.content[1].name).toBe("codesearch");
    });
});
