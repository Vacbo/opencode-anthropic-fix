/**
 * Debug gating behavior tests (Tasks 2-5, 11-12 from quality-refactor plan)
 *
 * Verifies that console output from the proxy subsystem respects the debug flag
 * and that silent error swallowing has been removed. These are SOURCE-CODE GREP
 * tests — we verify the plumbing exists without spawning subprocesses.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, "..");
const bunFetchSource = readFileSync(join(SRC_ROOT, "bun-fetch.ts"), "utf8");
const bunProxySource = readFileSync(join(SRC_ROOT, "bun-proxy.ts"), "utf8");

describe("debug gating in bun-fetch.ts (Task 2/4)", () => {
    it("threads OPENCODE_ANTHROPIC_DEBUG env var", () => {
        expect(bunFetchSource).toContain("OPENCODE_ANTHROPIC_DEBUG");
    });

    it("gates /tmp debug dump behind debug flag if any /tmp writes exist", () => {
        const hasTmpWrite = /writeFileSync\s*\(\s*["']\/tmp\/opencode/.test(bunFetchSource);
        if (hasTmpWrite) {
            expect(bunFetchSource).toMatch(/if\s*\(\s*(debug|resolveDebug)[^)]*\)|(debug|resolveDebug)\s*&&/);
        } else {
            expect(hasTmpWrite).toBe(false);
        }
    });

    it("does not register an uncaughtException handler (Task 12)", () => {
        expect(bunFetchSource).not.toContain("uncaughtException");
    });

    it("does not register an unhandledRejection handler (Task 12)", () => {
        expect(bunFetchSource).not.toContain("unhandledRejection");
    });
});

describe("debug gating in bun-proxy.ts (Task 3)", () => {
    it("references OPENCODE_ANTHROPIC_DEBUG for request logging", () => {
        expect(bunProxySource).toContain("OPENCODE_ANTHROPIC_DEBUG");
    });

    it("uses AbortSignal-based timeout handling on upstream fetch (Task 11)", () => {
        expect(bunProxySource).toMatch(/AbortSignal\.(timeout|any)/);
    });

    it("emits BUN_PROXY_PORT IPC ungated (parent must always detect port)", () => {
        expect(bunProxySource).toContain("BUN_PROXY_PORT");
    });
});

describe("silent error swallowing fixes (Task 5)", () => {
    it("accounts.ts saveToDisk catch logs the error", () => {
        const source = readFileSync(join(SRC_ROOT, "accounts.ts"), "utf8");
        expect(source).not.toMatch(/saveToDisk\(\)\s*\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/);
    });

    it("token-refresh.ts has no '.catch(() => undefined)' patterns", () => {
        const source = readFileSync(join(SRC_ROOT, "token-refresh.ts"), "utf8");
        expect(source).not.toMatch(/\.catch\(\s*\(\)\s*=>\s*undefined\s*\)/);
    });

    it("request/body.ts JSON parse catch binds the error parameter", () => {
        const source = readFileSync(join(SRC_ROOT, "request", "body.ts"), "utf8");
        expect(source).not.toMatch(/catch\s*\{\s*return\s+body\s*;?\s*\}/);
    });

    it("request/metadata.ts extractFileIds catch binds the error parameter", () => {
        const source = readFileSync(join(SRC_ROOT, "request", "metadata.ts"), "utf8");
        expect(source).not.toMatch(/catch\s*\{\s*return\s+\[\]\s*;?\s*\}/);
    });
});
