/**
 * Slash-command router safety tests
 *
 * Locks the observable contract of /anthropic slash commands:
 * - parseCommandArgs() argument parsing with quote support
 * - stripAnsi() ANSI escape code removal
 * - handleAnthropicSlashCommand() routing dispatch to correct handlers
 * - Command response format (heading patterns, message structure)
 *
 * These tests will fail if extraction changes routing or argument behavior.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
    parseCommandArgs,
    stripAnsi,
    ANTHROPIC_COMMAND_HANDLED,
    handleAnthropicSlashCommand,
    type CommandDeps,
} from "../../../src/commands/router.js";
import { DEFAULT_SIGNATURE_PROFILE_ID, TOOL_SEARCH_SIGNATURE_PROFILE_ID } from "../../../src/profiles/index.js";

// ---------------------------------------------------------------------------
// Pure helpers — no mocks needed
// ---------------------------------------------------------------------------

describe("parseCommandArgs — argument parsing", () => {
    it("returns empty array for empty string", () => {
        expect(parseCommandArgs("")).toEqual([]);
    });

    it("returns empty array for whitespace-only string", () => {
        expect(parseCommandArgs("   ")).toEqual([]);
    });

    it("splits simple space-separated args", () => {
        expect(parseCommandArgs("list")).toEqual(["list"]);
        expect(parseCommandArgs("switch 2")).toEqual(["switch", "2"]);
        expect(parseCommandArgs("betas add my-beta")).toEqual(["betas", "add", "my-beta"]);
    });

    it("handles double-quoted strings", () => {
        expect(parseCommandArgs('a b "c d"')).toEqual(["a", "b", "c d"]);
    });

    it("handles single-quoted strings", () => {
        expect(parseCommandArgs("a 'c d'")).toEqual(["a", "c d"]);
    });

    it("handles escaped quotes inside strings", () => {
        expect(parseCommandArgs('"hello \\"world\\""')).toEqual(['hello "world"']);
    });

    it("handles mixed quoted and unquoted args", () => {
        expect(parseCommandArgs('files upload "my file.pdf" --account 1')).toEqual([
            "files",
            "upload",
            "my file.pdf",
            "--account",
            "1",
        ]);
    });
});

describe("stripAnsi — ANSI escape code removal", () => {
    it("returns plain text unchanged", () => {
        expect(stripAnsi("hello world")).toBe("hello world");
    });

    it("strips color codes", () => {
        expect(stripAnsi("\x1b[32mgreen\x1b[0m")).toBe("green");
    });

    it("strips bold and dim codes", () => {
        expect(stripAnsi("\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m")).toBe("bold dim");
    });

    it("handles string with no ANSI codes", () => {
        expect(stripAnsi("Account #1 (alice@example.com)")).toBe("Account #1 (alice@example.com)");
    });

    it("handles empty string", () => {
        expect(stripAnsi("")).toBe("");
    });
});

describe("ANTHROPIC_COMMAND_HANDLED constant", () => {
    it("exports the expected sentinel value", () => {
        expect(ANTHROPIC_COMMAND_HANDLED).toBe("__ANTHROPIC_COMMAND_HANDLED__");
    });
});

// ---------------------------------------------------------------------------
// Slash command routing — mock dependencies
// ---------------------------------------------------------------------------

vi.mock("../../../src/storage.js", () => ({
    loadAccounts: vi.fn(),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
    createDefaultStats: vi.fn(() => ({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        lastReset: Date.now(),
    })),
}));

vi.mock("../../../src/config.js", () => ({
    loadConfigFresh: vi.fn(() => ({
        account_selection_strategy: "sticky",
        signature_profile: DEFAULT_SIGNATURE_PROFILE_ID,
        signature_emulation: { enabled: true, prompt_compaction: "minimal" },
        override_model_limits: { enabled: false },
        idle_refresh: { enabled: false },
        debug: false,
        toasts: { quiet: false },
        custom_betas: [],
    })),
    saveConfig: vi.fn(),
}));

vi.mock("../../../src/env.js", () => ({
    isTruthyEnv: vi.fn(() => false),
}));

vi.mock("../../../src/commands/oauth-flow.js", () => ({
    startSlashOAuth: vi.fn(),
    completeSlashOAuth: vi.fn(),
}));

import { loadAccounts } from "../../../src/storage.js";
import { saveConfig, loadConfigFresh } from "../../../src/config.js";
import { startSlashOAuth, completeSlashOAuth } from "../../../src/commands/oauth-flow.js";

const mockLoadAccounts = loadAccounts as Mock;
const mockSaveConfig = saveConfig as Mock;
const mockLoadConfigFresh = loadConfigFresh as Mock;
const mockStartSlashOAuth = startSlashOAuth as Mock;
const mockCompleteSlashOAuth = completeSlashOAuth as Mock;

function createMockDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
    return {
        sendCommandMessage: vi.fn().mockResolvedValue(undefined),
        accountManager: null,
        runCliCommand: vi.fn().mockResolvedValue({ code: 0, stdout: "OK", stderr: "" }),
        config: {
            account_selection_strategy: "sticky",
            signature_profile: DEFAULT_SIGNATURE_PROFILE_ID,
            failure_ttl_seconds: 3600,
            debug: false,
            signature_emulation: {
                enabled: true,
                fetch_claude_code_version_on_startup: false,
                prompt_compaction: "minimal",
                sanitize_system_prompt: false,
            },
            override_model_limits: { enabled: false, context: 1_000_000, output: 0 },
            custom_betas: [],
            health_score: {
                initial: 70,
                success_reward: 1,
                rate_limit_penalty: -10,
                failure_penalty: -20,
                recovery_rate_per_hour: 2,
                min_usable: 50,
                max_score: 100,
            },
            token_bucket: {
                max_tokens: 50,
                regeneration_rate_per_minute: 6,
                initial_tokens: 50,
            },
            toasts: { quiet: false, debounce_seconds: 30 },
            headers: {},
            idle_refresh: {
                enabled: false,
                window_minutes: 60,
                min_interval_minutes: 30,
            },
            cc_credential_reuse: {
                enabled: false,
                auto_detect: false,
                prefer_over_oauth: false,
            },
        },
        fileAccountMap: new Map(),
        initialAccountPinned: false,
        pendingSlashOAuth: new Map(),
        reloadAccountManagerFromDisk: vi.fn().mockResolvedValue(undefined),
        persistOpenCodeAuth: vi.fn().mockResolvedValue(undefined),
        refreshAccountTokenSingleFlight: vi.fn().mockResolvedValue("access-token"),
        ...overrides,
    };
}

describe("handleAnthropicSlashCommand — routing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLoadAccounts.mockResolvedValue(null);
    });

    it("defaults to 'list' when no arguments provided", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "", sessionID: "sess-1" }, deps);
        expect(deps.runCliCommand).toHaveBeenCalledWith(["list"]);
    });

    it("routes 'usage' to CLI list command", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "usage", sessionID: "sess-1" }, deps);
        expect(deps.runCliCommand).toHaveBeenCalledWith(["list"]);
        expect(deps.sendCommandMessage).toHaveBeenCalled();
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("▣ Anthropic");
    });

    it("routes 'config' to config display", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "config", sessionID: "sess-1" }, deps);
        expect(deps.sendCommandMessage).toHaveBeenCalled();
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("▣ Anthropic Config");
        expect(msg).toContain("strategy:");
        expect(msg).toContain("profile:");
        expect(msg).toContain("emulation:");
    });

    it("routes 'profile' to signature profile display", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "profile", sessionID: "sess-1" }, deps);
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("▣ Anthropic Profile");
        expect(msg).toContain(DEFAULT_SIGNATURE_PROFILE_ID);
    });

    it("routes 'profile <name>' to saveConfig", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand(
            {
                command: "anthropic",
                arguments: `profile ${TOOL_SEARCH_SIGNATURE_PROFILE_ID}`,
                sessionID: "sess-1",
            },
            deps,
        );
        expect(mockSaveConfig).toHaveBeenCalledWith({
            signature_profile: TOOL_SEARCH_SIGNATURE_PROFILE_ID,
        });
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain(TOOL_SEARCH_SIGNATURE_PROFILE_ID);
    });

    it("rejects unknown profile names in slash command", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand(
            {
                command: "anthropic",
                arguments: "profile cc-does-not-exist",
                sessionID: "sess-1",
            },
            deps,
        );
        expect(mockSaveConfig).not.toHaveBeenCalled();
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("Unknown signature profile");
    });

    it("routes 'set' without args to usage message", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "set", sessionID: "sess-1" }, deps);
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("▣ Anthropic Set");
        expect(msg).toContain("Usage:");
    });

    it("routes 'set debug on' to saveConfig", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand(
            { command: "anthropic", arguments: "set debug on", sessionID: "sess-1" },
            deps,
        );
        expect(mockSaveConfig).toHaveBeenCalledWith({ debug: true });
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("debug = on");
    });

    it("routes 'set emulation off' to saveConfig", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand(
            {
                command: "anthropic",
                arguments: "set emulation off",
                sessionID: "sess-1",
            },
            deps,
        );
        expect(mockSaveConfig).toHaveBeenCalledWith({
            signature_emulation: { enabled: false },
        });
    });

    it("routes 'set strategy round-robin' to saveConfig", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand(
            {
                command: "anthropic",
                arguments: "set strategy round-robin",
                sessionID: "sess-1",
            },
            deps,
        );
        expect(mockSaveConfig).toHaveBeenCalledWith({
            account_selection_strategy: "round-robin",
        });
    });

    it("rejects invalid strategy in set command by throwing", async () => {
        const deps = createMockDeps();
        await expect(
            handleAnthropicSlashCommand(
                {
                    command: "anthropic",
                    arguments: "set strategy banana",
                    sessionID: "sess-1",
                },
                deps,
            ),
        ).rejects.toThrow("Invalid strategy");
    });

    it("routes 'betas' to beta list display", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "betas", sessionID: "sess-1" }, deps);
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("▣ Anthropic Betas");
        expect(msg).toContain("Preset betas");
    });

    it("routes 'betas add' without beta name to usage", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "betas add", sessionID: "sess-1" }, deps);
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("Usage:");
    });

    it("routes 'betas add <beta>' to saveConfig with beta appended", async () => {
        mockLoadConfigFresh.mockReturnValue({
            account_selection_strategy: "sticky",
            custom_betas: [],
        });
        const deps = createMockDeps();
        await handleAnthropicSlashCommand(
            {
                command: "anthropic",
                arguments: "betas add web-search-2025-03-05",
                sessionID: "sess-1",
            },
            deps,
        );
        expect(mockSaveConfig).toHaveBeenCalledWith({
            custom_betas: ["web-search-2025-03-05"],
        });
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("Added: web-search-2025-03-05");
    });

    it("routes 'betas add' with duplicate beta to already-added message", async () => {
        mockLoadConfigFresh.mockReturnValue({
            account_selection_strategy: "sticky",
            custom_betas: ["web-search-2025-03-05"],
        });
        const deps = createMockDeps();
        await handleAnthropicSlashCommand(
            {
                command: "anthropic",
                arguments: "betas add web-search-2025-03-05",
                sessionID: "sess-1",
            },
            deps,
        );
        expect(mockSaveConfig).not.toHaveBeenCalled();
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("already added");
    });

    it("routes 'betas remove <beta>' to saveConfig with beta removed", async () => {
        mockLoadConfigFresh.mockReturnValue({
            account_selection_strategy: "sticky",
            custom_betas: ["web-search-2025-03-05", "compact-2026-01-12"],
        });
        const deps = createMockDeps();
        await handleAnthropicSlashCommand(
            {
                command: "anthropic",
                arguments: "betas remove web-search-2025-03-05",
                sessionID: "sess-1",
            },
            deps,
        );
        expect(mockSaveConfig).toHaveBeenCalledWith({
            custom_betas: ["compact-2026-01-12"],
        });
    });

    it("routes 'manage' to manage-not-available message", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "manage", sessionID: "sess-1" }, deps);
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("interactive-only");
    });

    it("routes 'login' to startSlashOAuth", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "login", sessionID: "sess-1" }, deps);
        expect(mockStartSlashOAuth).toHaveBeenCalledWith("sess-1", "login", undefined, expect.any(Object));
    });

    it("routes 'login complete <code>' to completeSlashOAuth", async () => {
        mockCompleteSlashOAuth.mockResolvedValue({
            ok: true,
            message: "Account added.",
        });
        const deps = createMockDeps();
        await handleAnthropicSlashCommand(
            {
                command: "anthropic",
                arguments: "login complete mycode#mystate",
                sessionID: "sess-1",
            },
            deps,
        );
        expect(mockCompleteSlashOAuth).toHaveBeenCalledWith("sess-1", "mycode#mystate", expect.any(Object));
    });

    it("routes 'login complete' without code to error message", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand(
            {
                command: "anthropic",
                arguments: "login complete",
                sessionID: "sess-1",
            },
            deps,
        );
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("Missing code");
    });

    it("routes 'reauth' without number to error message", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "reauth", sessionID: "sess-1" }, deps);
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("Provide an account number");
    });

    it("routes 'reauth 1' to startSlashOAuth with index", async () => {
        mockLoadAccounts.mockResolvedValue({
            version: 1,
            accounts: [{ email: "a@test.com", enabled: true, refreshToken: "t1" }],
            activeIndex: 0,
        });
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "reauth 1", sessionID: "sess-1" }, deps);
        expect(mockStartSlashOAuth).toHaveBeenCalledWith("sess-1", "reauth", 0, expect.any(Object));
    });

    it("forces --force on destructive commands (remove, logout)", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "remove 1", sessionID: "sess-1" }, deps);
        const cliArgs = (deps.runCliCommand as Mock).mock.calls[0][0] as string[];
        expect(cliArgs).toContain("--force");
    });

    it("forces --force on logout command", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "logout 1", sessionID: "sess-1" }, deps);
        const cliArgs = (deps.runCliCommand as Mock).mock.calls[0][0] as string[];
        expect(cliArgs).toContain("--force");
    });

    it("files command without accountManager returns error", async () => {
        const deps = createMockDeps({ accountManager: null });
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "files list", sessionID: "sess-1" }, deps);
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("No accounts configured");
    });

    it("passes unknown commands through to CLI", async () => {
        const deps = createMockDeps();
        (deps.runCliCommand as Mock).mockResolvedValue({
            code: 0,
            stdout: "Custom output",
            stderr: "",
        });
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "stats", sessionID: "sess-1" }, deps);
        expect(deps.runCliCommand).toHaveBeenCalledWith(["stats"]);
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("Custom output");
    });

    it("reports error heading when CLI returns non-zero code", async () => {
        const deps = createMockDeps();
        (deps.runCliCommand as Mock).mockResolvedValue({
            code: 1,
            stdout: "",
            stderr: "Something failed",
        });
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "refresh 1", sessionID: "sess-1" }, deps);
        const msg = (deps.sendCommandMessage as Mock).mock.calls[0][1] as string;
        expect(msg).toContain("▣ Anthropic (error)");
        expect(msg).toContain("Something failed");
    });

    it("calls reloadAccountManagerFromDisk after CLI commands", async () => {
        const deps = createMockDeps();
        await handleAnthropicSlashCommand({ command: "anthropic", arguments: "switch 1", sessionID: "sess-1" }, deps);
        expect(deps.reloadAccountManagerFromDisk).toHaveBeenCalled();
    });
});
