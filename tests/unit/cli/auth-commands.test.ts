import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "../../../src/config.js";
import type * as StorageModule from "../../../src/storage.js";

const { logMock, spinnerStart, spinnerStop, spinnerMessage, mockLoad } = vi.hoisted(() => ({
    logMock: {
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        message: vi.fn(),
        step: vi.fn(),
    },
    spinnerStart: vi.fn(),
    spinnerStop: vi.fn(),
    spinnerMessage: vi.fn(),
    mockLoad: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
    confirm: vi.fn(),
    intro: vi.fn(),
    isCancel: vi.fn(() => false),
    spinner: vi.fn(() => ({ start: spinnerStart, stop: spinnerStop, message: spinnerMessage })),
    text: vi.fn(),
    log: logMock,
}));

vi.mock("../../../src/accounts.js", () => ({
    AccountManager: {
        load: mockLoad,
    },
}));

vi.mock("../../../src/config.js", async () => {
    const actual = await vi.importActual<typeof ConfigModule>("../../../src/config.js");
    return {
        ...actual,
        loadConfig: vi.fn(() => actual.DEFAULT_CONFIG),
        CLIENT_ID: actual.CLIENT_ID,
    };
});

vi.mock("../../../src/oauth.js", () => ({
    authorize: vi.fn(),
    exchange: vi.fn(),
    revoke: vi.fn(),
}));

vi.mock("../../../src/storage.js", async () => {
    const actual = await vi.importActual<typeof StorageModule>("../../../src/storage.js");
    return {
        ...actual,
        loadAccounts: vi.fn(),
        saveAccounts: vi.fn(),
    };
});

import { cmdList, cmdStatus } from "../../../src/cli/commands/auth.js";

describe("auth CLI commands", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const fetchMock = vi.fn();
        global.fetch = Object.assign(fetchMock, {
            preconnect: vi.fn(),
        }) as typeof fetch;
    });

    it("cmdList fetches usage and profile for CC-managed accounts and uses profile identity fallback", async () => {
        mockLoad.mockResolvedValue({
            getManagedAccounts: () => [
                {
                    index: 0,
                    email: undefined,
                    label: "Claude Code (Max)",
                    refreshToken: "refresh-token",
                    access: "access-token",
                    expires: Date.now() + 60_000,
                    tokenUpdatedAt: Date.now(),
                    enabled: true,
                    consecutiveFailures: 0,
                    rateLimitResetTimes: {},
                },
            ],
            getCurrentIndex: () => 0,
            saveToDisk: vi.fn().mockResolvedValue(undefined),
        });

        vi.mocked(global.fetch)
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        five_hour: { utilization: 12, resets_at: "2026-04-16T01:00:00Z" },
                        seven_day: { utilization: 24, resets_at: "2026-04-20T01:00:00Z" },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        account: {
                            email: "claude@example.com",
                            display_name: "Claude Example",
                        },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
            );

        const exitCode = await cmdList();

        expect(exitCode).toBe(0);
        expect(global.fetch).toHaveBeenNthCalledWith(
            1,
            "https://api.anthropic.com/api/oauth/usage",
            expect.objectContaining({
                headers: expect.objectContaining({
                    authorization: "Bearer access-token",
                    "anthropic-beta": "oauth-2025-04-20",
                }),
            }),
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            2,
            "https://api.anthropic.com/api/oauth/profile",
            expect.objectContaining({
                headers: expect.objectContaining({
                    authorization: "Bearer access-token",
                    accept: "application/json, text/plain, */*",
                    "user-agent": "axios/1.13.6",
                }),
            }),
        );
        expect(logMock.message).toHaveBeenCalledWith(expect.stringContaining("claude@example.com"));
        expect(logMock.message).not.toHaveBeenCalledWith(expect.stringContaining("quotas: unavailable"));
    });

    it("cmdStatus counts CC-managed accounts from AccountManager", async () => {
        mockLoad.mockResolvedValue({
            getManagedAccounts: () => [
                { enabled: true, rateLimitResetTimes: {}, index: 0 },
                { enabled: true, rateLimitResetTimes: {}, index: 1 },
            ],
            getCurrentIndex: () => 1,
        });

        const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const exitCode = await cmdStatus();

        expect(exitCode).toBe(0);
        expect(consoleSpy).toHaveBeenCalledWith("anthropic: 2 accounts (2 active), strategy: sticky, next: #2");

        consoleSpy.mockRestore();
    });
});
