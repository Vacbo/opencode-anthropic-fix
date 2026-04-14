/**
 * Direct unit tests for accounts/persistence.ts
 *
 * Tests account loading from storage, auth fallback merging,
 * bootstrap account creation, storage preparation, and reconciliation.
 */

import { describe, expect, it } from "vitest";

import type { ManagedAccount } from "../../../src/accounts.js";
import type { AccountMetadata, AccountStorage } from "../../../src/storage.js";
import { createManagedAccount } from "../../../src/accounts/matching.js";
import {
    createBootstrapAccountFromFallback,
    loadManagedAccountsFromStorage,
    mergeAuthFallbackIntoAccounts,
    prepareStorageForSave,
    reconcileManagedAccountsWithStorage,
    type AuthFallback,
} from "../../../src/accounts/persistence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStoredAccount(overrides: Partial<AccountMetadata> = {}, idx = 0): AccountMetadata {
    return {
        id: `acct-${idx}`,
        refreshToken: `refresh-${idx}`,
        token_updated_at: (idx + 1) * 1000,
        addedAt: (idx + 1) * 1000,
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
        ...overrides,
    };
}

function makeStorage(accountOverrides: Partial<AccountMetadata>[] = [{}], activeIndex = 0): AccountStorage {
    return {
        version: 1,
        accounts: accountOverrides.map((o, i) => makeStoredAccount(o, i)),
        activeIndex,
    };
}

function makeManagedAccount(overrides: Partial<Parameters<typeof createManagedAccount>[0]> = {}): ManagedAccount {
    return createManagedAccount({
        index: 0,
        refreshToken: "managed-refresh",
        now: 5000,
        ...overrides,
    });
}

// ---------------------------------------------------------------------------
// loadManagedAccountsFromStorage
// ---------------------------------------------------------------------------

describe("loadManagedAccountsFromStorage", () => {
    it("loads accounts from storage with correct indices", () => {
        const storage = makeStorage([{ email: "a@b.com" }, { email: "c@d.com" }]);
        const { accounts, currentIndex } = loadManagedAccountsFromStorage(storage);

        expect(accounts).toHaveLength(2);
        expect(accounts[0].index).toBe(0);
        expect(accounts[0].email).toBe("a@b.com");
        expect(accounts[1].index).toBe(1);
        expect(accounts[1].email).toBe("c@d.com");
        expect(currentIndex).toBe(0);
    });

    it("clamps activeIndex to valid range", () => {
        const storage = makeStorage([{}], 99);
        const { currentIndex } = loadManagedAccountsFromStorage(storage);
        expect(currentIndex).toBe(0);
    });

    it("returns -1 for empty accounts", () => {
        const storage: AccountStorage = { version: 1, accounts: [], activeIndex: 0 };
        const { accounts, currentIndex } = loadManagedAccountsFromStorage(storage);
        expect(accounts).toHaveLength(0);
        expect(currentIndex).toBe(-1);
    });

    it("preserves enabled/disabled state", () => {
        const storage = makeStorage([{ enabled: true }, { enabled: false }]);
        const { accounts } = loadManagedAccountsFromStorage(storage);
        expect(accounts[0].enabled).toBe(true);
        expect(accounts[1].enabled).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// mergeAuthFallbackIntoAccounts
// ---------------------------------------------------------------------------

describe("mergeAuthFallbackIntoAccounts", () => {
    it("does nothing with empty accounts array", () => {
        const accounts: ManagedAccount[] = [];
        mergeAuthFallbackIntoAccounts(accounts, { refresh: "tok" });
        expect(accounts).toHaveLength(0);
    });

    it("does nothing when fallback does not match any account", () => {
        const accounts = [makeManagedAccount({ refreshToken: "existing-token" })];
        const origAccess = accounts[0].access;

        mergeAuthFallbackIntoAccounts(accounts, {
            refresh: "completely-different-token",
            access: "new-access",
            expires: Date.now() + 60_000,
        });

        expect(accounts[0].access).toBe(origAccess);
    });

    it("adopts fresh fallback credentials when they match and are fresher", () => {
        const futureExpiry = Date.now() + 120_000;
        const accounts = [makeManagedAccount({ refreshToken: "shared-token", access: undefined, expires: undefined })];

        mergeAuthFallbackIntoAccounts(accounts, {
            refresh: "shared-token",
            access: "fresh-access",
            expires: futureExpiry,
        });

        expect(accounts[0].access).toBe("fresh-access");
        expect(accounts[0].expires).toBe(futureExpiry);
    });

    it("does not overwrite with expired fallback", () => {
        const accounts = [
            makeManagedAccount({
                refreshToken: "shared-token",
                access: "current-access",
                expires: Date.now() + 60_000,
            }),
        ];

        mergeAuthFallbackIntoAccounts(accounts, {
            refresh: "shared-token",
            access: "stale-access",
            expires: Date.now() - 1000, // expired
        });

        expect(accounts[0].access).toBe("current-access");
    });
});

// ---------------------------------------------------------------------------
// createBootstrapAccountFromFallback
// ---------------------------------------------------------------------------

describe("createBootstrapAccountFromFallback", () => {
    it("creates a managed account from auth fallback", () => {
        const now = 10_000;
        const fallback: AuthFallback = {
            refresh: "bootstrap-refresh",
            access: "bootstrap-access",
            expires: 99_000,
        };

        const account = createBootstrapAccountFromFallback(fallback, now);

        expect(account.refreshToken).toBe("bootstrap-refresh");
        expect(account.access).toBe("bootstrap-access");
        expect(account.expires).toBe(99_000);
        expect(account.index).toBe(0);
        expect(account.enabled).toBe(true);
        expect(account.source).toBe("oauth");
        expect(account.addedAt).toBe(now);
    });

    it("generates id from now + refresh prefix", () => {
        const account = createBootstrapAccountFromFallback({ refresh: "abcdef123456789" }, 5000);
        expect(account.id).toContain("5000:");
        expect(account.id).toContain("abcdef123456");
    });
});

// ---------------------------------------------------------------------------
// prepareStorageForSave
// ---------------------------------------------------------------------------

describe("prepareStorageForSave", () => {
    it("converts managed accounts back to storage format", () => {
        const accounts = [
            makeManagedAccount({ id: "a1", email: "a@b.com", refreshToken: "tok-a" }),
            makeManagedAccount({ id: "a2", email: "c@d.com", refreshToken: "tok-b", index: 1 }),
        ];

        const result = prepareStorageForSave({
            accounts,
            currentIndex: 0,
            statsDeltas: new Map(),
            diskData: null,
        });

        expect(result.storage.version).toBe(1);
        expect(result.storage.accounts).toHaveLength(2);
        expect(result.storage.accounts[0].id).toBe("a1");
        expect(result.storage.accounts[1].id).toBe("a2");
        expect(result.storage.activeIndex).toBe(0);
    });

    it("preserves active index by matching account id", () => {
        const accounts = [
            makeManagedAccount({ id: "first", refreshToken: "tok1" }),
            makeManagedAccount({ id: "second", refreshToken: "tok2", index: 1 }),
        ];

        const result = prepareStorageForSave({
            accounts,
            currentIndex: 1,
            statsDeltas: new Map(),
            diskData: null,
        });

        expect(result.storage.activeIndex).toBe(1);
    });

    it("returns persisted state map keyed by account id", () => {
        const accounts = [makeManagedAccount({ id: "test-id", refreshToken: "tok" })];

        const result = prepareStorageForSave({
            accounts,
            currentIndex: 0,
            statsDeltas: new Map(),
            diskData: null,
        });

        expect(result.persistedStateById.has("test-id")).toBe(true);
        const state = result.persistedStateById.get("test-id")!;
        expect(state.refreshToken).toBe("tok");
    });

    it("filters out disabled accounts with no disk match", () => {
        const accounts = [
            makeManagedAccount({ id: "enabled-id", refreshToken: "tok1", enabled: true }),
            makeManagedAccount({ id: "disabled-id", refreshToken: "tok2", enabled: false, index: 1 }),
        ];

        const result = prepareStorageForSave({
            accounts,
            currentIndex: 0,
            statsDeltas: new Map(),
            diskData: null,
        });

        expect(result.storage.accounts).toHaveLength(1);
        expect(result.storage.accounts[0].id).toBe("enabled-id");
    });
});

// ---------------------------------------------------------------------------
// reconcileManagedAccountsWithStorage
// ---------------------------------------------------------------------------

describe("reconcileManagedAccountsWithStorage", () => {
    it("matches existing accounts by id", () => {
        const existing = makeManagedAccount({ id: "acct-0", refreshToken: "refresh-0" });
        const stored = makeStorage([{ id: "acct-0", refreshToken: "refresh-0", email: "updated@test.com" }]);

        const result = reconcileManagedAccountsWithStorage({
            accounts: [existing],
            stored,
            currentIndex: 0,
            statsDeltaIds: [],
        });

        expect(result.accounts).toHaveLength(1);
        expect(result.accounts[0].email).toBe("updated@test.com");
    });

    it("adds new accounts from storage not in memory", () => {
        const existing = makeManagedAccount({ id: "acct-0", refreshToken: "refresh-0" });
        const stored = makeStorage([{ id: "acct-0" }, { id: "acct-new", email: "new@test.com" }]);

        const result = reconcileManagedAccountsWithStorage({
            accounts: [existing],
            stored,
            currentIndex: 0,
            statsDeltaIds: [],
        });

        expect(result.accounts.length).toBeGreaterThanOrEqual(2);
        expect(result.shouldRebuildTrackers).toBe(true);
    });

    it("disables memory-only accounts not found in storage", () => {
        const inMemory = makeManagedAccount({ id: "orphan", refreshToken: "orphan-tok" });
        const stored = makeStorage([{ id: "different", refreshToken: "diff-tok" }]);

        const result = reconcileManagedAccountsWithStorage({
            accounts: [inMemory],
            stored,
            currentIndex: 0,
            statsDeltaIds: [],
        });

        const orphan = result.accounts.find((a) => a.id === "orphan");
        expect(orphan?.enabled).toBe(false);
    });

    it("returns -1 currentIndex when no enabled accounts remain", () => {
        const stored: AccountStorage = { version: 1, accounts: [], activeIndex: 0 };

        const result = reconcileManagedAccountsWithStorage({
            accounts: [],
            stored,
            currentIndex: -1,
            statsDeltaIds: [],
        });

        expect(result.currentIndex).toBe(-1);
    });

    it("identifies stale delta ids no longer in reconciled set", () => {
        const stored = makeStorage([{ id: "acct-0" }]);
        const existing = makeManagedAccount({ id: "acct-0", refreshToken: "refresh-0" });

        const result = reconcileManagedAccountsWithStorage({
            accounts: [existing],
            stored,
            currentIndex: 0,
            statsDeltaIds: ["acct-0", "stale-id-1", "stale-id-2"],
        });

        expect(result.staleDeltaIds).toContain("stale-id-1");
        expect(result.staleDeltaIds).toContain("stale-id-2");
        expect(result.staleDeltaIds).not.toContain("acct-0");
    });
});
