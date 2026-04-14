import { describe, expect, it } from "vitest";
import type { CCCredential } from "../../src/cc-credentials.js";
import type { ManagedAccount } from "../../src/accounts.js";
import {
    findByIdentity,
    identitiesMatch,
    resolveIdentity,
    resolveIdentityFromCCCredential,
    resolveIdentityFromOAuthExchange,
    serializeIdentity,
    type AccountIdentity,
} from "../../src/account-identity.js";

describe("account-identity", () => {
    const oauthAccount: ManagedAccount = {
        id: "oauth-1",
        index: 0,
        email: "alice@example.com",
        refreshToken: "rt_oauth_123",
        access: "at_oauth_123",
        expires: Date.now() + 3600000,
        tokenUpdatedAt: Date.now(),
        addedAt: Date.now(),
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
            lastReset: Date.now(),
        },
        source: "oauth",
    };

    const ccAccount: ManagedAccount = {
        id: "cc-1",
        index: 1,
        email: undefined,
        label: "Claude Code-credentials:alice@example.com",
        refreshToken: "rt_cc_456",
        access: "at_cc_456",
        expires: Date.now() + 3600000,
        tokenUpdatedAt: Date.now(),
        addedAt: Date.now(),
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
            lastReset: Date.now(),
        },
        source: "cc-keychain",
    };

    const legacyAccount: ManagedAccount = {
        id: "legacy-1",
        index: 2,
        email: undefined,
        refreshToken: "rt_legacy_789",
        access: "at_legacy_789",
        expires: Date.now() + 3600000,
        tokenUpdatedAt: Date.now(),
        addedAt: Date.now(),
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
            lastReset: Date.now(),
        },
        source: undefined,
    };

    const ccCredential: CCCredential = {
        accessToken: "at_cc_456",
        refreshToken: "rt_cc_456",
        expiresAt: Date.now() + 3600000,
        source: "cc-keychain",
        label: "Claude Code-credentials:alice@example.com",
    };

    describe("resolveIdentity", () => {
        it("should resolve OAuth account identity from email", () => {
            const identity = resolveIdentity(oauthAccount);

            expect(identity).toEqual({
                kind: "oauth",
                email: "alice@example.com",
            });
        });

        it("should resolve CC account identity from source+label", () => {
            const identity = resolveIdentity(ccAccount);

            expect(identity).toEqual({
                kind: "cc",
                source: "cc-keychain",
                label: "Claude Code-credentials:alice@example.com",
            });
        });

        it("should resolve legacy identity from refreshToken when no email or source", () => {
            const identity = resolveIdentity(legacyAccount);

            expect(identity).toEqual({
                kind: "legacy",
                refreshToken: "rt_legacy_789",
            });
        });
    });

    describe("exchange helpers", () => {
        it("should resolve CC identity from a Claude Code credential", () => {
            expect(resolveIdentityFromCCCredential(ccCredential)).toEqual({
                kind: "cc",
                source: "cc-keychain",
                label: "Claude Code-credentials:alice@example.com",
            });
        });

        it("should resolve OAuth exchange results with email as OAuth identity", () => {
            expect(resolveIdentityFromOAuthExchange({ email: "alice@example.com", refresh: "rt_oauth_123" })).toEqual({
                kind: "oauth",
                email: "alice@example.com",
            });
        });

        it("should resolve OAuth exchange results without email as legacy identity", () => {
            expect(resolveIdentityFromOAuthExchange({ refresh: "rt_legacy_789" })).toEqual({
                kind: "legacy",
                refreshToken: "rt_legacy_789",
            });
        });
    });

    describe("identitiesMatch", () => {
        it("should match OAuth accounts with same email", () => {
            const identity1: AccountIdentity = { kind: "oauth", email: "alice@example.com" };
            const identity2: AccountIdentity = { kind: "oauth", email: "alice@example.com" };

            expect(identitiesMatch(identity1, identity2)).toBe(true);
        });

        it("should match CC accounts with same source+label", () => {
            const identity1: AccountIdentity = { kind: "cc", source: "cc-keychain", label: "label1" };
            const identity2: AccountIdentity = { kind: "cc", source: "cc-keychain", label: "label1" };

            expect(identitiesMatch(identity1, identity2)).toBe(true);
        });

        it("should not match different identity types", () => {
            const oauthIdentity: AccountIdentity = { kind: "oauth", email: "alice@example.com" };
            const ccIdentity: AccountIdentity = { kind: "cc", source: "cc-keychain", label: "label" };
            const legacyIdentity: AccountIdentity = { kind: "legacy", refreshToken: "rt" };

            expect(identitiesMatch(oauthIdentity, ccIdentity)).toBe(false);
            expect(identitiesMatch(oauthIdentity, legacyIdentity)).toBe(false);
            expect(identitiesMatch(ccIdentity, legacyIdentity)).toBe(false);
        });

        it("should not match different stable key fields", () => {
            expect(
                identitiesMatch(
                    { kind: "oauth", email: "alice@example.com" },
                    { kind: "oauth", email: "bob@example.com" },
                ),
            ).toBe(false);
            expect(
                identitiesMatch(
                    { kind: "cc", source: "cc-keychain", label: "label1" },
                    { kind: "cc", source: "cc-keychain", label: "label2" },
                ),
            ).toBe(false);
        });
    });

    describe("findByIdentity", () => {
        const accounts: ManagedAccount[] = [oauthAccount, ccAccount, legacyAccount];

        it("should find matching accounts by stable identity", () => {
            expect(findByIdentity(accounts, { kind: "oauth", email: "alice@example.com" })).toBe(oauthAccount);
            expect(
                findByIdentity(accounts, {
                    kind: "cc",
                    source: "cc-keychain",
                    label: "Claude Code-credentials:alice@example.com",
                }),
            ).toBe(ccAccount);
            expect(findByIdentity(accounts, { kind: "legacy", refreshToken: "rt_legacy_789" })).toBe(legacyAccount);
            expect(findByIdentity(accounts, { kind: "oauth", email: "unknown@example.com" })).toBeNull();
        });

        it("should serialize identities without leaking secrets", () => {
            expect(serializeIdentity({ kind: "oauth", email: "alice@example.com" })).toBe("oauth:alice@example.com");
            expect(serializeIdentity({ kind: "cc", source: "cc-keychain", label: "label1" })).toBe(
                "cc:cc-keychain:label1",
            );
            expect(serializeIdentity({ kind: "legacy", refreshToken: "secret-refresh-token" })).toBe("legacy:redacted");
        });
    });
});
