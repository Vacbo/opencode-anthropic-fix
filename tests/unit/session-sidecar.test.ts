import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
    execFileSync: execFileSyncMock,
}));

describe("session-sidecar payload builder", () => {
    afterEach(() => {
        execFileSyncMock.mockReset();
        vi.resetModules();
    });

    it("builds a minimal non-repo payload without git sources or outcomes", async () => {
        execFileSyncMock.mockImplementation(() => {
            throw new Error("not a git repo");
        });

        const { buildCodeSessionPayload, buildCodeSessionTitle, resetSessionSidecarCacheForTests } =
            await import("../../src/session-sidecar.js");
        resetSessionSidecarCacheForTests();

        const payload = buildCodeSessionPayload(JSON.stringify({ model: "claude-opus-4-6[1m]" }), "chat-one");

        expect(payload).toEqual({
            title: buildCodeSessionTitle("chat-one"),
            bridge: {},
            config: {
                cwd: process.cwd(),
                model: "claude-opus-4-6[1m]",
            },
        });
        expect(String(payload.title)).toMatch(/^[a-z0-9-]+-[a-z]+-[a-z]+$/);
    });

    it("includes git sources/outcomes for repo payloads and normalizes github ssh remotes", async () => {
        execFileSyncMock.mockImplementation((_, args: string[]) => {
            if (args.join(" ") === "remote get-url origin") {
                return "git@github.com:Vacbo/opencode-anthropic-fix.git\n";
            }
            if (args.join(" ") === "rev-parse --abbrev-ref HEAD") {
                return "master\n";
            }
            throw new Error(`unexpected git args: ${args.join(" ")}`);
        });

        const { buildCodeSessionPayload, buildCodeSessionTitle, resetSessionSidecarCacheForTests } =
            await import("../../src/session-sidecar.js");
        resetSessionSidecarCacheForTests();

        const payload = buildCodeSessionPayload(JSON.stringify({ model: "claude-opus-4-6[1m]" }), "chat-two") as {
            title: string;
            bridge: Record<string, never>;
            config: Record<string, unknown>;
        };

        expect(payload.title).toBe(buildCodeSessionTitle("chat-two"));
        expect(payload.config).toMatchObject({
            cwd: process.cwd(),
            model: "claude-opus-4-6[1m]",
            sources: [
                {
                    type: "git_repository",
                    url: "git@github.com:Vacbo/opencode-anthropic-fix.git",
                    revision: "master",
                },
            ],
            outcomes: [
                {
                    type: "git_repository",
                    git_info: {
                        type: "github",
                        repo: "Vacbo/opencode-anthropic-fix",
                        branches: ["master"],
                    },
                },
            ],
            reuse_outcome_branches: true,
        });
    });
});
