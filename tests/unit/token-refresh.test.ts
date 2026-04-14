import { execSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred, nextTick } from "../helpers/deferred.js";
import { createRefreshHelpers } from "../../src/refresh-helpers.js";

vi.mock("node:child_process", () => ({
    execSync: vi.fn(),
}));

vi.mock("../../src/cc-credentials.js", () => ({
    readCCCredentials: vi.fn(),
    readCCCredentialsFromFile: vi.fn(),
}));

vi.mock("../../src/oauth.js", () => ({
    refreshToken: vi.fn(),
}));

vi.mock("../../src/refresh-lock.js", () => ({
    acquireRefreshLock: vi.fn().mockResolvedValue({
        acquired: true,
        lockPath: null,
        owner: null,
        lockInode: null,
    }),
    releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/storage.js", () => ({
    loadAccounts: vi.fn().mockResolvedValue(null),
}));

import type { ManagedAccount } from "../../src/accounts.js";
import type { CCCredential } from "../../src/cc-credentials.js";
import { readCCCredentials, readCCCredentialsFromFile } from "../../src/cc-credentials.js";
import { refreshToken } from "../../src/oauth.js";
import { applyDiskAuthIfFresher, refreshAccountToken } from "../../src/token-refresh.js";

const mockExecSync = execSync as Mock;
const mockReadCCCredentials = readCCCredentials as Mock;
const mockReadCCCredentialsFromFile = readCCCredentialsFromFile as Mock;
const mockRefreshToken = refreshToken as Mock;

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
    return {
        id: "acct-1",
        index: 0,
        email: "user@example.com",
        refreshToken: "refresh-old",
        access: "access-old",
        expires: Date.now() - 60_000,
        tokenUpdatedAt: 0,
        addedAt: Date.now() - 120_000,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            lastReset: 0,
        },
        source: "oauth",
        ...overrides,
    };
}

function makeCredential(overrides: Partial<CCCredential> = {}): CCCredential {
    return {
        accessToken: "access-fresh",
        refreshToken: "refresh-fresh",
        expiresAt: Date.now() + 3600_000,
        subscriptionType: "max",
        source: "cc-file",
        label: "/mock-home/.claude/.credentials.json",
        ...overrides,
    };
}

describe("refreshAccountToken", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.spyOn(Date, "now").mockReturnValue(new Date("2026-03-25T12:00:00Z").getTime());
    });

    it("re-reads keychain-backed CC accounts without calling OAuth HTTP refresh", async () => {
        const account = makeAccount({
            source: "cc-keychain",
            refreshToken: "refresh-old",
            access: "access-old",
            expires: Date.now() - 1_000,
        });

        mockReadCCCredentials.mockReturnValue([
            makeCredential({
                source: "cc-keychain",
                label: "Claude Code-credentials",
                refreshToken: "refresh-old",
            }),
        ]);

        const client = {
            auth: {
                set: vi.fn().mockResolvedValue(undefined),
            },
        };

        await expect(refreshAccountToken(account, client)).resolves.toBe("access-fresh");

        expect(mockReadCCCredentials).toHaveBeenCalledTimes(1);
        expect(mockReadCCCredentialsFromFile).not.toHaveBeenCalled();
        expect(mockRefreshToken).not.toHaveBeenCalled();
        expect(account.access).toBe("access-fresh");
        expect(account.refreshToken).toBe("refresh-old");
        expect(account.expires).toBe(Date.now() + 3600_000);
        expect(client.auth.set).toHaveBeenCalledWith({
            path: { id: "anthropic" },
            body: {
                type: "oauth",
                refresh: "refresh-old",
                access: "access-fresh",
                expires: Date.now() + 3600_000,
            },
        });
    });

    it("invokes the claude CLI for expired file-backed CC accounts before re-reading", async () => {
        const account = makeAccount({
            source: "cc-file",
            refreshToken: "refresh-old",
            access: "access-old",
            expires: Date.now() - 1_000,
        });

        mockReadCCCredentialsFromFile
            .mockReturnValueOnce(
                makeCredential({
                    source: "cc-file",
                    refreshToken: "refresh-old",
                    accessToken: "access-stale",
                    expiresAt: Date.now() - 5_000,
                }),
            )
            .mockReturnValueOnce(
                makeCredential({
                    source: "cc-file",
                    refreshToken: "refresh-new",
                    accessToken: "access-new",
                    expiresAt: Date.now() + 7_200_000,
                }),
            );

        mockExecSync.mockImplementation((command: string) => {
            if (command === "which claude") return "/usr/local/bin/claude\n";
            if (command === "/usr/local/bin/claude -p . --model haiku") return "";
            throw new Error(`unexpected command: ${command}`);
        });

        await expect(refreshAccountToken(account, {})).resolves.toBe("access-new");

        expect(mockReadCCCredentialsFromFile).toHaveBeenCalledTimes(2);
        expect(mockReadCCCredentials).not.toHaveBeenCalled();
        expect(mockRefreshToken).not.toHaveBeenCalled();
        expect(mockExecSync).toHaveBeenNthCalledWith(1, "which claude", {
            encoding: "utf-8",
            timeout: 5000,
        });
        expect(mockExecSync).toHaveBeenNthCalledWith(2, "/usr/local/bin/claude -p . --model haiku", {
            encoding: "utf-8",
            timeout: 60000,
        });
        expect(account.access).toBe("access-new");
        expect(account.refreshToken).toBe("refresh-new");
    });

    it("keeps OAuth-backed accounts on the existing HTTP refresh path", async () => {
        const account = makeAccount({
            source: "oauth",
            refreshToken: "oauth-refresh",
            access: "oauth-access",
            expires: Date.now() - 1_000,
        });

        mockRefreshToken.mockResolvedValue({
            access_token: "oauth-access-new",
            expires_in: 1800,
            refresh_token: "oauth-refresh-new",
        });

        await expect(refreshAccountToken(account, {})).resolves.toBe("oauth-access-new");

        expect(mockRefreshToken).toHaveBeenCalledWith("oauth-refresh", {
            signal: expect.any(AbortSignal),
        });
        expect(mockReadCCCredentials).not.toHaveBeenCalled();
        expect(mockReadCCCredentialsFromFile).not.toHaveBeenCalled();
        expect(account.access).toBe("oauth-access-new");
        expect(account.refreshToken).toBe("oauth-refresh-new");
    });

    it("fails cleanly when the claude binary is unavailable for CC refresh", async () => {
        const account = makeAccount({
            source: "cc-file",
            refreshToken: "refresh-old",
            expires: Date.now() - 1_000,
        });

        mockReadCCCredentialsFromFile.mockReturnValue(
            makeCredential({
                source: "cc-file",
                refreshToken: "refresh-old",
                accessToken: "access-stale",
                expiresAt: Date.now() - 5_000,
            }),
        );
        mockExecSync.mockImplementation((command: string) => {
            if (command === "which claude") {
                throw new Error("not found");
            }
            throw new Error(`unexpected command: ${command}`);
        });

        await expect(refreshAccountToken(account, {})).rejects.toThrow("CC credential refresh failed");

        expect(mockRefreshToken).not.toHaveBeenCalled();
        expect(mockExecSync).toHaveBeenCalledTimes(1);
        expect(mockExecSync).toHaveBeenCalledWith("which claude", {
            encoding: "utf-8",
            timeout: 5000,
        });
    });

    it("reuses the first foreground retry after an idle refresh rejection", async () => {
        const idleRefresh = createDeferred<{
            access_token: string;
            expires_in: number;
            refresh_token?: string;
        }>();
        const foregroundRefresh = createDeferred<{
            access_token: string;
            expires_in: number;
            refresh_token?: string;
        }>();
        const idleFailure = new Error("idle refresh failed");
        const foregroundFailure = new Error("foreground refresh failed");
        mockRefreshToken
            .mockImplementationOnce(() => idleRefresh.promise)
            .mockImplementationOnce(() => foregroundRefresh.promise)
            .mockRejectedValueOnce(new Error("duplicate foreground refresh"));
        const accountManager = {
            saveToDisk: vi.fn().mockResolvedValue(undefined),
            requestSaveToDisk: vi.fn(),
            getEnabledAccounts: vi.fn().mockReturnValue([]),
        };
        const account = makeAccount();
        const helpers = createRefreshHelpers({
            client: {},
            config: {
                idle_refresh: {
                    enabled: true,
                    window_minutes: 10,
                    min_interval_minutes: 1,
                },
            } as never,
            getAccountManager: () => accountManager as never,
            debugLog: vi.fn(),
        });
        const idleCall = helpers.refreshAccountTokenSingleFlight(account, "idle").catch((error) => error);
        await nextTick();
        await nextTick();

        const foregroundCallA = helpers.refreshAccountTokenSingleFlight(account, "foreground").catch((error) => error);
        const foregroundCallB = helpers.refreshAccountTokenSingleFlight(account, "foreground").catch((error) => error);
        await nextTick();

        idleRefresh.reject(idleFailure);
        await expect(idleCall).resolves.toBe(idleFailure);
        await nextTick();

        expect(mockRefreshToken).toHaveBeenCalledTimes(2);

        foregroundRefresh.reject(foregroundFailure);

        await expect(foregroundCallA).resolves.toBe(foregroundFailure);
        await expect(foregroundCallB).resolves.toBe(foregroundFailure);
    });

    it("does not adopt older expired-fallback disk auth when only access differs", () => {
        const currentTime = Date.now();
        const account = makeAccount({
            refreshToken: "refresh-current",
            access: "access-current",
            expires: currentTime - 1_000,
            tokenUpdatedAt: currentTime,
        });

        const adopted = applyDiskAuthIfFresher(
            account,
            {
                refreshToken: "refresh-current",
                access: "access-stale",
                expires: currentTime + 60_000,
                tokenUpdatedAt: currentTime - 60_000,
            },
            { allowExpiredFallback: true },
        );

        expect(adopted).toBe(false);
        expect(account.refreshToken).toBe("refresh-current");
        expect(account.access).toBe("access-current");
        expect(account.tokenUpdatedAt).toBe(currentTime);
    });
});
