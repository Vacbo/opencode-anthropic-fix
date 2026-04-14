import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../../src/config.js";
import type { AccountStorage } from "../../../src/storage.js";
import { createInMemoryStorage, makeAccountsData, makeStoredAccount } from "../../helpers/in-memory-storage.js";
import type * as StorageModule from "../../../src/storage.js";

type CCCredential = {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    source: "cc-keychain" | "cc-file";
    label: string;
    subscriptionType?: string;
};

type LoadManagerOptions = {
    ccCredentials?: CCCredential[];
    config?: typeof DEFAULT_CONFIG;
    initialStorage?: AccountStorage;
};

async function loadManager(options: LoadManagerOptions = {}) {
    vi.resetModules();

    const storage = createInMemoryStorage(options.initialStorage);
    const createDefaultStats = vi.fn((now?: number) => ({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        lastReset: now ?? Date.now(),
    }));

    vi.doMock("../../../src/storage.js", async (importOriginal) => {
        const actual = await importOriginal<typeof StorageModule>();
        return {
            ...actual,
            createDefaultStats,
            loadAccounts: storage.loadAccountsMock,
            saveAccounts: storage.saveAccountsMock,
        };
    });

    vi.doMock("../../../src/cc-credentials.js", () => ({
        readCCCredentials: () => options.ccCredentials ?? [],
    }));

    const { AccountManager } = await import("../../../src/accounts.js");
    const manager = await AccountManager.load(options.config ?? DEFAULT_CONFIG, null);
    return { manager, storage };
}

describe("repairCorruptedCCAccounts (load-time heal)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        vi.resetModules();
    });

    it("full heal: cc-born id + matching live credential restores source/label/identity", async () => {
        const corruptedRefresh = "sk-ant-ort01-corrupted-refresh-token-value";
        const initialStorage = makeAccountsData([
            makeStoredAccount({
                id: "cc-cc-keychain-1775606505008:sk-ant-ort01",
                refreshToken: corruptedRefresh,
                access: "sk-ant-corrupted-access",
                source: "oauth",
                identity: { kind: "legacy", refreshToken: corruptedRefresh },
                label: undefined,
                email: undefined,
            }),
        ]);

        const { manager } = await loadManager({
            initialStorage,
            ccCredentials: [
                {
                    refreshToken: corruptedRefresh,
                    accessToken: "sk-ant-corrupted-access",
                    expiresAt: Date.now() + 3_600_000,
                    source: "cc-keychain",
                    label: "Claude Code-credentials",
                    subscriptionType: "max",
                },
            ],
        });

        const snapshot = manager.getAccountsSnapshot();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0]).toMatchObject({
            id: "cc-cc-keychain-1775606505008:sk-ant-ort01",
            source: "cc-keychain",
            label: "Claude Code-credentials",
            identity: {
                kind: "cc",
                source: "cc-keychain",
                label: "Claude Code-credentials",
            },
        });
    });

    it("partial heal: cc-born id with no live credential restores source from id and clears legacy identity", async () => {
        const refresh = "sk-ant-ort01-stale-token";
        const initialStorage = makeAccountsData([
            makeStoredAccount({
                id: "cc-cc-keychain-1775606505008:sk-ant-ort01",
                refreshToken: refresh,
                source: "oauth",
                identity: { kind: "legacy", refreshToken: refresh },
                label: undefined,
            }),
        ]);

        const { manager } = await loadManager({
            initialStorage,
            ccCredentials: [],
        });

        const snapshot = manager.getAccountsSnapshot();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0]?.source).toBe("cc-keychain");
        expect(snapshot[0]?.identity).toBeUndefined();
    });

    it("collapses corrupted cc-born duplicate into healthy cc row on load", async () => {
        const corruptedRefresh = "sk-ant-ort01-old-rotated-token";
        const freshRefresh = "sk-ant-ort01-new-rotated-token";
        const initialStorage = makeAccountsData([
            makeStoredAccount({
                id: "cc-cc-keychain-1775606505008:sk-ant-ort01",
                refreshToken: corruptedRefresh,
                access: "sk-ant-old-access",
                source: "oauth",
                identity: { kind: "legacy", refreshToken: corruptedRefresh },
                label: undefined,
                addedAt: 1775606505008,
                token_updated_at: 1775606505008,
            }),
            makeStoredAccount({
                id: "cc-cc-keychain-1775767359131:sk-ant-ort01",
                refreshToken: freshRefresh,
                access: "sk-ant-new-access",
                source: "cc-keychain",
                label: "Claude Code-credentials",
                identity: {
                    kind: "cc",
                    source: "cc-keychain",
                    label: "Claude Code-credentials",
                },
                addedAt: 1775767359131,
                token_updated_at: 1775767359131,
            }),
        ]);

        const { manager } = await loadManager({
            initialStorage,
            ccCredentials: [
                {
                    refreshToken: freshRefresh,
                    accessToken: "sk-ant-new-access",
                    expiresAt: Date.now() + 3_600_000,
                    source: "cc-keychain",
                    label: "Claude Code-credentials",
                    subscriptionType: "max",
                },
            ],
        });

        const snapshot = manager.getAccountsSnapshot();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0]).toMatchObject({
            source: "cc-keychain",
            label: "Claude Code-credentials",
            refreshToken: freshRefresh,
            identity: {
                kind: "cc",
                source: "cc-keychain",
                label: "Claude Code-credentials",
            },
        });
    });

    it("addAccount() refuses to downgrade a CC row to oauth when called without CC options", async () => {
        const initialStorage = makeAccountsData([
            makeStoredAccount({
                id: "cc-cc-keychain-1775606505008:sk-ant-ort01",
                refreshToken: "cc-refresh-original",
                access: "cc-access-original",
                source: "cc-keychain",
                label: "Claude Code-credentials",
                identity: {
                    kind: "cc",
                    source: "cc-keychain",
                    label: "Claude Code-credentials",
                },
            }),
        ]);

        const { manager } = await loadManager({ initialStorage });

        const result = manager.addAccount(
            "cc-refresh-original",
            "sk-ant-fresh-access",
            Date.now() + 7_200_000,
            undefined,
        );

        expect(result).not.toBeNull();
        const snapshot = manager.getAccountsSnapshot();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0]).toMatchObject({
            source: "cc-keychain",
            label: "Claude Code-credentials",
            access: "sk-ant-fresh-access",
            identity: {
                kind: "cc",
                source: "cc-keychain",
                label: "Claude Code-credentials",
            },
        });
    });

    it("addAccount() with explicit oauth source does NOT downgrade a healthy CC row", async () => {
        const initialStorage = makeAccountsData([
            makeStoredAccount({
                id: "cc-cc-keychain-1775606505008:sk-ant-ort01",
                refreshToken: "cc-refresh",
                source: "cc-keychain",
                label: "Claude Code-credentials",
                identity: {
                    kind: "cc",
                    source: "cc-keychain",
                    label: "Claude Code-credentials",
                },
            }),
        ]);

        const { manager } = await loadManager({ initialStorage });

        manager.addAccount("cc-refresh", "fresh-access", Date.now() + 7_200_000, "alice@example.com", {
            source: "oauth",
        });

        const snapshot = manager.getAccountsSnapshot();
        expect(snapshot[0]?.source).toBe("cc-keychain");
        expect(snapshot[0]?.identity).toMatchObject({ kind: "cc" });
    });

    it("does NOT touch healthy non-CC rows", async () => {
        const initialStorage = makeAccountsData([
            makeStoredAccount({
                id: "1234567890:sk-ant-oauth1",
                refreshToken: "oauth-refresh",
                email: "alice@example.com",
                source: "oauth",
                identity: { kind: "oauth", email: "alice@example.com" },
            }),
        ]);

        const { manager } = await loadManager({ initialStorage });

        const snapshot = manager.getAccountsSnapshot();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0]).toMatchObject({
            source: "oauth",
            email: "alice@example.com",
            identity: { kind: "oauth", email: "alice@example.com" },
        });
    });
});
