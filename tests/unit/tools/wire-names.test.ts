import { describe, expect, it } from "vitest";

import { detectLegacyDoublePrefix, toInternalToolName, toWireToolName } from "../../../src/tools/wire-names.js";

describe("wire tool names", () => {
    it("maps native-equivalent internal tools to Claude-native wire names", () => {
        expect(toWireToolName("bash")).toBe("Bash");
        expect(toWireToolName("read")).toBe("Read");
        expect(toWireToolName("glob")).toBe("Glob");
        expect(toWireToolName("grep")).toBe("Grep");
        expect(toWireToolName("edit")).toBe("Edit");
        expect(toWireToolName("write")).toBe("Write");
        expect(toWireToolName("skill")).toBe("Skill");
    });

    it("maps non-native tools to reversible PascalCase aliases", () => {
        expect(toWireToolName("codesearch")).toBe("Codesearch");
        expect(toWireToolName("lsp_goto_definition")).toBe("LspGotoDefinition");
        expect(toWireToolName("background_output")).toBe("BackgroundOutput");
    });

    it("maps wire names back to internal names", () => {
        expect(toInternalToolName("Bash")).toBe("bash");
        expect(toInternalToolName("Read")).toBe("read");
        expect(toInternalToolName("Codesearch")).toBe("codesearch");
        expect(toInternalToolName("LspGotoDefinition")).toBe("lsp_goto_definition");
    });

    it("preserves special wire names and legacy mcp-prefixed responses", () => {
        expect(toWireToolName("tool_search_tool_regex")).toBe("tool_search_tool_regex");
        expect(toWireToolName("advisor")).toBe("advisor");
        expect(toInternalToolName("tool_search_tool_regex")).toBe("tool_search_tool_regex");
        expect(toInternalToolName("advisor")).toBe("advisor");
        expect(toInternalToolName("mcp_codesearch")).toBe("codesearch");
    });

    it("still detects legacy double prefixes", () => {
        expect(detectLegacyDoublePrefix("mcp_mcp_read_file")).toBe(true);
        expect(detectLegacyDoublePrefix("mcp_read_file")).toBe(false);
    });
});
