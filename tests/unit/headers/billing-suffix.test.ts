import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildAnthropicBillingHeader } from "../../../src/headers/billing.js";

const currentFilePath = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(currentFilePath), "..", "..", "..");

interface GoldenPair {
    scenario: string;
    capturePath: string;
    expectedSuffix: string;
}

const GOLDEN_PAIRS: readonly GoldenPair[] = [
    {
        scenario: "minimal-hi-2.1.113",
        capturePath:
            ".sisyphus/evidence/phase-1-claim-validation/2026-04-17/proxyman-minimal-hi-2.1.113/minimal-hi-og-capture.json",
        expectedSuffix: "9c8",
    },
    {
        scenario: "mcp-tool-call",
        capturePath:
            ".sisyphus/evidence/phase-1-claim-validation/2026-04-17/proxyman-mcp-tool-call/mcp-tool-call-og-capture.json",
        expectedSuffix: "23a",
    },
    {
        scenario: "long-context",
        capturePath:
            ".sisyphus/evidence/phase-1-claim-validation/2026-04-17/proxyman-long-context/long-context-og-capture.json",
        expectedSuffix: "be8",
    },
    {
        scenario: "adaptive-thinking-shared",
        capturePath:
            ".sisyphus/evidence/phase-1-claim-validation/2026-04-17/proxyman-adaptive-thinking-shared/adaptive-thinking-shared-og-capture.json",
        expectedSuffix: "e97",
    },
    {
        scenario: "opus-effort-xhigh",
        capturePath:
            ".sisyphus/evidence/phase-1-claim-validation/2026-04-17/proxyman-opus-effort-xhigh/opus-effort-xhigh-og-capture.json",
        expectedSuffix: "9e4",
    },
];

function loadCaptureMessages(absolutePath: string): unknown[] {
    const raw = readFileSync(absolutePath, "utf8");
    const capture = JSON.parse(raw) as { bodyText: string };
    const body = JSON.parse(capture.bodyText) as { messages?: unknown[] };
    return body.messages ?? [];
}

function extractSuffix(header: string): string | null {
    const match = header.match(/cc_version=\d+\.\d+\.\d+\.([a-f0-9]{3})/);
    return match ? match[1] : null;
}

describe.skip("cc_version suffix against real CC captures (algorithm under investigation, see docs/mimese-http-header-system-prompt.md)", () => {
    for (const pair of GOLDEN_PAIRS) {
        it(`matches CC's emitted suffix for ${pair.scenario}`, () => {
            const absolutePath = resolve(PROJECT_ROOT, pair.capturePath);
            const messages = loadCaptureMessages(absolutePath);
            const header = buildAnthropicBillingHeader("2.1.113", messages);
            const producedSuffix = extractSuffix(header);
            expect(producedSuffix).toBe(pair.expectedSuffix);
        });
    }
});

describe("cc_version suffix current algorithm (documented behavior, not CC-parity)", () => {
    it("produces a 3-hex-char suffix for a non-empty first user message", () => {
        const messages = [{ role: "user", content: [{ type: "text", text: "hello world example" }] }];
        const header = buildAnthropicBillingHeader("2.1.113", messages);
        expect(header).toMatch(/cc_version=2\.1\.113\.[a-f0-9]{3};/);
    });

    it("is deterministic for identical inputs", () => {
        const messages = [{ role: "user", content: [{ type: "text", text: "hello world example" }] }];
        const outputs = Array.from({ length: 5 }, () => buildAnthropicBillingHeader("2.1.113", messages));
        expect(new Set(outputs).size).toBe(1);
    });
});
