import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    loadHarCaptures,
    normalizeHarEntry,
    parseArgs,
    selectCapture,
} from "../../../scripts/proxyman/normalize-har.ts";

const tempDirs = new Set<string>();

afterEach(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
});

function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.add(dir);
    return dir;
}

describe("proxyman normalize-har", () => {
    it("parses required arguments", () => {
        const parsed = parseArgs(["--har", "/tmp/capture.har", "--scenario", "minimal-hi"]);
        expect(parsed.harPath).toBe("/tmp/capture.har");
        expect(parsed.scenarioId).toBe("minimal-hi");
        expect(parsed.selectLast).toBe(false);
    });

    it("normalizes a HAR entry into a CaptureRecord", () => {
        const capture = normalizeHarEntry({
            startedDateTime: "2026-04-15T17:32:35.000Z",
            request: {
                method: "POST",
                url: "https://api.anthropic.com/v1/messages?beta=true",
                headers: [
                    { name: "User-Agent", value: "claude-cli/2.1.109" },
                    { name: "X-App", value: "cli" },
                ],
                postData: {
                    text: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
                },
            },
        });

        expect(capture.path).toBe("/v1/messages?beta=true");
        expect(capture.headers["user-agent"]).toBe("claude-cli/2.1.109");
        expect((capture.parsedBody as Record<string, unknown>).messages).toBeDefined();
    });

    it("loads HAR captures from disk and selects by scenario prompt", () => {
        const dir = createTempDir("proxyman-har-");
        const harPath = join(dir, "capture.har");

        writeFileSync(
            harPath,
            JSON.stringify({
                log: {
                    entries: [
                        {
                            startedDateTime: "2026-04-15T17:32:35.000Z",
                            request: {
                                method: "POST",
                                url: "https://api.anthropic.com/v1/messages?beta=true",
                                headers: [{ name: "Content-Type", value: "application/json" }],
                                postData: {
                                    text: JSON.stringify({
                                        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
                                    }),
                                },
                            },
                        },
                    ],
                },
            }),
            "utf8",
        );

        const captures = loadHarCaptures(harPath);
        const capture = selectCapture(captures, {
            harPath,
            outPath: undefined,
            scenarioId: "minimal-hi",
            scenarioDir: join(process.cwd(), "scripts/verification/scenarios"),
            hostContains: undefined,
            pathContains: undefined,
            promptContains: undefined,
            selectLast: false,
            help: false,
        });

        expect(capture.path).toBe("/v1/messages?beta=true");
        expect(capture.bodyText).toContain("hi");
    });
});
