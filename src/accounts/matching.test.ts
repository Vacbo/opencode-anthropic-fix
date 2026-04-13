/**
 * Direct unit tests for accounts/matching.ts
 *
 * Tests identity resolution, managed account creation, matching,
 * reindexing, and storage-to-memory account updating.
 */

import { describe, expect, it } from "vitest";

import type { AccountIdentity } from "../account-identity.js";
import type { ManagedAccount } from "../accounts.js";
import type { AccountMetadata } from "../storage.js";
import {
    createManagedAccount,
    findMatchingManagedAccount,
    reindexManagedAccounts,
    resolveManagedAccountIdentity,
    updateManagedAccountFromStorage,
} from "./matching.js";

// ---------------------------------------------------------------------------
// resolveManagedAccountIdentity
// ---------------------------------------------------------------------------

describe("resolveManagedAccountIdentity", () => {
    it("returns provided identity when present", () => {
        const identity: AccountIdentity = { kind: "oauth", email: "a@b.com" };
        const result = resolveManagedAccountIdentity({
            refreshToken: "tok",
            identity,
        });
        expect(result).toEqual(identity);
    });

    it("returns cc identity for cc-keychain source with label", () => {
        const result = resolveManagedAccountIdentity({
            refreshToken: "tok",
            source: "cc-keychain",
            label: "my-label",
        });
        expect(result).toEqual({
            kind: "cc",
            source: "cc-keychain",
            label: "my-label",
        });
    });

    it("returns cc identity for cc-file source with label", () => {
        const result = resolveManagedAccountIdentity({
            refreshToken: "tok",
            source: "cc-file",
            label: "file-label",
        });
        expect(result).toEqual({
            kind: "cc",
            source: "cc-file",
            label: "file-label",
        });
    });

    it("returns oauth identity when email is provided", () => {
        const result = resolveManagedAccountIdentity({
            refreshToken: "tok",
            email: "user@test.com",
        });
        expect(result).toEqual({
            kind: "oauth",
            email: "user@test.com",
        });
    });

    it("returns legacy identity as fallback", () => {
        const result = resolveManagedAccountIdentity({
            refreshToken: "my-refresh-token",
        });
        expect(result).toEqual({
            kind: "legacy",
            refreshToken: "my-refresh-token",
        });
    });

    it("prefers explicit identity over email", () => {
        const identity: AccountIdentity = { kind: "legacy", refreshToken: "x" };
        const result = resolveManagedAccountIdentity({
            refreshToken: "tok",
            email: "user@test.com",
            identity,
        });
        expect(result).not.toBeUndefined();
        expect(result!.kind).toBe("legacy");
    });

    it("prefers cc source over email when source is cc-keychain", () => {
        const result = resolveManagedAccountIdentity({
            refreshToken: "tok",
            email: "user@test.com",
            source: "cc-keychain",
            label: "cc-label",
        });
        expect(result).not.toBeUndefined();
        expect(result!.kind).toBe("cc");
    });
});

// ---------------------------------------------------------------------------
// createManagedAccount
// ---------------------------------------------------------------------------

describe("createManagedAccount", () => {
    it("creates account with minimal fields", () => {
        const account = createManagedAccount({
            index: 0,
            refreshToken: "refresh-abc123xyz",
        });

        expect(account.index).toBe(0);
        expect(account.refreshToken).toBe("refresh-abc123xyz");
        expect(account.enabled).toBe(true);
        expect(account.consecutiveFailures).toBe(0);
        expect(account.lastFailureTime).toBeNull();
        expect(account.source).toBe("oauth");
        expect(account.id).toContain("refresh-abc1");
    });

    it("creates account with full override fields", () => {
        const now = 1000;
        const account = createManagedAccount({
            id: "custom-id",
            index: 2,
            email: "test@example.com",
            refreshToken: "tok",
            access: "access-tok",
            expires: 9999,
            enabled: false,
            consecutiveFailures: 3,
            lastFailureTime: 500,
            source: "oauth",
            now,
        });

        expect(account.id).toBe("custom-id");
        expect(account.index).toBe(2);
        expect(account.email).toBe("test@example.com");
        expect(account.access).toBe("access-tok");
        expect(account.expires).toBe(9999);
        expect(account.enabled).toBe(false);
        expect(account.consecutiveFailures).toBe(3);
        expect(account.lastFailureTime).toBe(500);
    });

    it("copies rateLimitResetTimes instead of sharing reference", () => {
        const times = { "429": 5000 };
        const account = createManagedAccount({
            index: 0,
            refreshToken: "tok",
            rateLimitResetTimes: times,
        });

        times["429"] = 9999;
        expect(account.rateLimitResetTimes["429"]).toBe(5000);
    });

    it("assigns cc source when identity is cc", () => {
        const account = createManagedAccount({
            index: 0,
            refreshToken: "tok",
            source: "cc-keychain",
            label: "my-cc-label",
        });

        expect(account.source).toBe("cc-keychain");
        expect(account.label).toBe("my-cc-label");
        expect(account.identity?.kind).toBe("cc");
    });
});

// ---------------------------------------------------------------------------
// findMatchingManagedAccount
// ---------------------------------------------------------------------------

describe("findMatchingManagedAccount", () => {
    function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
        return createManagedAccount({
            index: 0,
            refreshToken: "default-token",
            now: 1000,
            ...overrides,
        });
    }

    it("finds by id", () => {
        const a = makeAccount({ id: "match-id" });
        const b = makeAccount({ id: "other-id", refreshToken: "tok2" });
        const result = findMatchingManagedAccount([a, b], { id: "match-id" });
        expect(result).toBe(a);
    });

    it("finds by identity", () => {
        const identity: AccountIdentity = { kind: "oauth", email: "user@x.com" };
        const a = makeAccount({ email: "user@x.com", identity });
        const result = findMatchingManagedAccount([a], { identity });
        expect(result).toBe(a);
    });

    it("finds by refreshToken as fallback", () => {
        const a = makeAccount({ refreshToken: "my-token-abcdef" });
        const result = findMatchingManagedAccount([a], { refreshToken: "my-token-abcdef" });
        expect(result).toBe(a);
    });

    it("returns null when no match", () => {
        const a = makeAccount({ id: "no-match" });
        const result = findMatchingManagedAccount([a], { id: "different" });
        expect(result).toBeNull();
    });

    it("returns null for empty accounts array", () => {
        const result = findMatchingManagedAccount([], { id: "x" });
        expect(result).toBeNull();
    });

    it("prefers id match over identity match", () => {
        const identity: AccountIdentity = { kind: "oauth", email: "user@x.com" };
        const a = makeAccount({ id: "id-match", email: "other@x.com" });
        const b = makeAccount({ id: "other", email: "user@x.com", identity, refreshToken: "tok2" });
        const result = findMatchingManagedAccount([a, b], { id: "id-match", identity });
        expect(result).toBe(a);
    });
});

// ---------------------------------------------------------------------------
// reindexManagedAccounts
// ---------------------------------------------------------------------------

describe("reindexManagedAccounts", () => {
    it("reassigns sequential indices starting from 0", () => {
        const accounts = [
            createManagedAccount({ index: 5, refreshToken: "a" }),
            createManagedAccount({ index: 10, refreshToken: "b" }),
            createManagedAccount({ index: 0, refreshToken: "c" }),
        ];

        reindexManagedAccounts(accounts);

        expect(accounts[0].index).toBe(0);
        expect(accounts[1].index).toBe(1);
        expect(accounts[2].index).toBe(2);
    });

    it("handles empty array", () => {
        const accounts: ManagedAccount[] = [];
        reindexManagedAccounts(accounts);
        expect(accounts).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// updateManagedAccountFromStorage
// ---------------------------------------------------------------------------

describe("updateManagedAccountFromStorage", () => {
    function makeExisting(): ManagedAccount {
        return createManagedAccount({
            id: "existing-id",
            index: 0,
            email: "old@test.com",
            refreshToken: "old-token",
            access: "old-access",
            expires: 1000,
            source: "oauth",
        });
    }

    function makeStorageAccount(overrides: Partial<AccountMetadata> = {}): AccountMetadata {
        return {
            id: "storage-id",
            refreshToken: "new-token",
            token_updated_at: 2000,
            addedAt: 2000,
            lastUsed: 3000,
            enabled: true,
            rateLimitResetTimes: {},
            consecutiveFailures: 0,
            lastFailureTime: null,
            stats: {
                requests: 10,
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                lastReset: 1000,
            },
            ...overrides,
        };
    }

    it("updates index from parameter", () => {
        const existing = makeExisting();
        updateManagedAccountFromStorage(existing, makeStorageAccount(), 5);
        expect(existing.index).toBe(5);
    });

    it("updates refreshToken from storage", () => {
        const existing = makeExisting();
        updateManagedAccountFromStorage(existing, makeStorageAccount({ refreshToken: "updated-tok" }), 0);
        expect(existing.refreshToken).toBe("updated-tok");
    });

    it("preserves email from existing when storage has none", () => {
        const existing = makeExisting();
        updateManagedAccountFromStorage(existing, makeStorageAccount(), 0);
        expect(existing.email).toBe("old@test.com");
    });

    it("updates email from storage when provided", () => {
        const existing = makeExisting();
        updateManagedAccountFromStorage(existing, makeStorageAccount({ email: "new@test.com" }), 0);
        expect(existing.email).toBe("new@test.com");
    });

    it("copies rateLimitResetTimes (not reference)", () => {
        const existing = makeExisting();
        const times = { "429": 9999 };
        updateManagedAccountFromStorage(existing, makeStorageAccount({ rateLimitResetTimes: times }), 0);

        times["429"] = 0;
        expect(existing.rateLimitResetTimes["429"]).toBe(9999);
    });

    it("updates enabled status", () => {
        const existing = makeExisting();
        updateManagedAccountFromStorage(existing, makeStorageAccount({ enabled: false }), 0);
        expect(existing.enabled).toBe(false);
    });
});
