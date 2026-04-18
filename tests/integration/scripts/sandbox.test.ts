import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(currentFilePath), "..", "..", "..");
const sandboxScriptPath = join(projectRoot, "scripts", "sandbox.ts");
const sandboxRoot = join(projectRoot, ".sandbox-test");

function runSandbox(command: string, args: string[] = []): { stdout: string; stderr: string; status: number } {
    try {
        const stdout = execFileSync("bun", [sandboxScriptPath, command, ...args], {
            cwd: projectRoot,
            encoding: "utf8",
            env: { ...process.env, SANDBOX_ROOT: sandboxRoot },
        });
        return { stdout, stderr: "", status: 0 };
    } catch (error) {
        const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
        return {
            stdout: String(err.stdout ?? ""),
            stderr: String(err.stderr ?? ""),
            status: err.status ?? 1,
        };
    }
}

describe("dev sandbox lifecycle", () => {
    beforeAll(() => {
        rmSync(sandboxRoot, { recursive: true, force: true });
    }, 30_000);

    afterAll(() => {
        rmSync(sandboxRoot, { recursive: true, force: true });
    }, 30_000);

    it("up creates plugin, CLI, and data directories in isolation", () => {
        const result = runSandbox("up");
        expect(result.status).toBe(0);

        const pluginEntry = join(sandboxRoot, "config", "opencode", "plugin", "opencode-anthropic-auth-plugin.js");
        const cliBinary = join(sandboxRoot, "bin", "opencode-anthropic-auth");
        const dataDir = join(sandboxRoot, "data");

        expect(existsSync(pluginEntry)).toBe(true);
        expect(existsSync(cliBinary)).toBe(true);
        expect(existsSync(dataDir)).toBe(true);
    }, 120_000);

    it("plugin and CLI are COPIES, not symlinks", () => {
        const pluginEntry = join(sandboxRoot, "config", "opencode", "plugin", "opencode-anthropic-auth-plugin.js");
        const cliBinary = join(sandboxRoot, "bin", "opencode-anthropic-auth");

        expect(lstatSync(pluginEntry).isSymbolicLink()).toBe(false);
        expect(lstatSync(cliBinary).isSymbolicLink()).toBe(false);
        expect(lstatSync(pluginEntry).isFile()).toBe(true);
        expect(lstatSync(cliBinary).isFile()).toBe(true);
    });

    it("up does not mutate the user's live ~/.config/opencode plugin dir", () => {
        const liveDir = join(homedir(), ".config", "opencode", "plugin");
        if (!existsSync(liveDir)) {
            expect(existsSync(liveDir)).toBe(false);
            return;
        }

        const liveMtimeMs = statSync(liveDir).mtimeMs;
        const sandboxMtimeMs = statSync(sandboxRoot).mtimeMs;
        // +1 ms tolerance for filesystems with coarse mtime resolution (HFS+, some NFS).
        expect(liveMtimeMs).toBeLessThanOrEqual(sandboxMtimeMs + 1);
    });

    it("reinstall preserves sandbox-scoped state (accounts, configs)", () => {
        const accountsPath = join(sandboxRoot, "config", "opencode", "anthropic-accounts.json");
        const sentinelContent = JSON.stringify({ version: 99, note: "sandbox-test" });

        mkdirSync(dirname(accountsPath), { recursive: true });
        writeFileSync(accountsPath, sentinelContent, "utf8");

        const result = runSandbox("reinstall");
        expect(result.status).toBe(0);

        expect(readFileSync(accountsPath, "utf8")).toBe(sentinelContent);
    }, 120_000);

    it("down removes the sandbox tree", () => {
        const result = runSandbox("down");
        expect(result.status).toBe(0);
        expect(existsSync(sandboxRoot)).toBe(false);
    });

    it("status reports absence after down", () => {
        const result = runSandbox("status");
        expect(result.status).toBe(0);
        expect(result.stdout.toLowerCase()).toContain("not installed");
    });
});
