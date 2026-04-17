import { describe, expect, it } from "vitest";
import { buildSystemPromptBlocks } from "../../../src/system-prompt/builder.js";
import type { SignatureConfig, SystemBlock } from "../../../src/types.js";

const MESSAGES = [{ role: "user", content: "hi" }];

function makeSignature(overrides: Partial<SignatureConfig> = {}): SignatureConfig {
    return {
        enabled: true,
        claudeCliVersion: "2.1.112",
        sanitizeSystemPrompt: true,
        promptCompactionMode: "off",
        ...overrides,
    } as SignatureConfig;
}

describe("buildSystemPromptBlocks - CC 2.1.112 parity", () => {
    it("emits the new Claude Agent SDK identity string (capture 2026-04-17 confirms CC sends this on Haiku 4.5)", () => {
        const incomingSystem: SystemBlock[] = [{ type: "text", text: "Custom downstream block" }];
        const blocks = buildSystemPromptBlocks(incomingSystem, makeSignature(), MESSAGES);
        const identityBlock = blocks.find(
            (b) => b.text === "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        );
        expect(identityBlock).toBeDefined();
    });

    it("does NOT emit the old 'You are Claude Code' identity string", () => {
        const blocks = buildSystemPromptBlocks([{ type: "text", text: "Custom" }], makeSignature(), MESSAGES);
        const oldIdentityBlock = blocks.find(
            (b) => b.text === "You are Claude Code, Anthropic's official CLI for Claude.",
        );
        expect(oldIdentityBlock).toBeUndefined();
    });

    it("emits cache_control with ttl: '1h' on the identity block (matches CC 2.1.112 capture)", () => {
        const blocks = buildSystemPromptBlocks([{ type: "text", text: "Custom" }], makeSignature(), MESSAGES);
        const identityBlock = blocks.find(
            (b) => b.text === "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        );
        expect(identityBlock?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    });

    it("places billing first, identity second, downstream third (CC ordering)", () => {
        const incomingSystem: SystemBlock[] = [
            { type: "text", text: "Downstream block 1" },
            { type: "text", text: "Downstream block 2" },
        ];
        const blocks = buildSystemPromptBlocks(incomingSystem, makeSignature(), MESSAGES);
        expect(blocks.length).toBeGreaterThanOrEqual(3);
        expect(blocks[0].text).toMatch(/^x-anthropic-billing-header:/);
        expect(blocks[1].text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
        expect(blocks[2].text).toBe("Downstream block 1");
    });

    it("strips the OLD identity string if it sneaks in via incoming system blocks (compatibility)", () => {
        const incomingSystem: SystemBlock[] = [
            { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
            { type: "text", text: "downstream content" },
        ];
        const blocks = buildSystemPromptBlocks(incomingSystem, makeSignature(), MESSAGES);
        const oldOccurrences = blocks.filter(
            (b) => b.text === "You are Claude Code, Anthropic's official CLI for Claude.",
        ).length;
        expect(oldOccurrences).toBe(0);
    });

    it("strips the NEW identity string if duplicated in incoming blocks (no double-emission)", () => {
        const incomingSystem: SystemBlock[] = [
            { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
            { type: "text", text: "downstream content" },
        ];
        const blocks = buildSystemPromptBlocks(incomingSystem, makeSignature(), MESSAGES);
        const occurrences = blocks.filter(
            (b) => b.text === "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        ).length;
        expect(occurrences).toBe(1);
    });
});
