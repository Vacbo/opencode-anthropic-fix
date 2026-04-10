import { describe, expect, it } from "vitest";
import type { ManagedAccount } from "../accounts.js";
import { findByIdentity, identitiesMatch, resolveIdentity, type AccountIdentity } from "../account-identity.js";

describe("account-identity", () => {
  // OAuth account with email
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

  // CC account with source and label (no email)
  const ccAccount: ManagedAccount = {
    id: "cc-1",
    index: 1,
    email: undefined,
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

  // Legacy account with no email, no source (fallback to refreshToken)
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

  describe("resolveIdentity", () => {
    it("should resolve OAuth account identity from email", () => {
      const identity = resolveIdentity(oauthAccount);

      expect(identity).toEqual({
        type: "oauth",
        email: "alice@example.com",
      });
    });

    it("should resolve CC account identity from source+label", () => {
      const identity = resolveIdentity(ccAccount);

      expect(identity).toEqual({
        type: "cc",
        source: "cc-keychain",
        label: "rt_cc_456", // refreshToken as label fallback
      });
    });

    it("should resolve legacy identity from refreshToken when no email or source", () => {
      const identity = resolveIdentity(legacyAccount);

      expect(identity).toEqual({
        type: "legacy",
        refreshToken: "rt_legacy_789",
      });
    });
  });

  describe("identitiesMatch", () => {
    it("should match OAuth accounts with same email", () => {
      const identity1: AccountIdentity = { type: "oauth", email: "alice@example.com" };
      const identity2: AccountIdentity = { type: "oauth", email: "alice@example.com" };

      expect(identitiesMatch(identity1, identity2)).toBe(true);
    });

    it("should not match OAuth accounts with different emails", () => {
      const identity1: AccountIdentity = { type: "oauth", email: "alice@example.com" };
      const identity2: AccountIdentity = { type: "oauth", email: "bob@example.com" };

      expect(identitiesMatch(identity1, identity2)).toBe(false);
    });

    it("should match CC accounts with same source+label", () => {
      const identity1: AccountIdentity = { type: "cc", source: "cc-keychain", label: "label1" };
      const identity2: AccountIdentity = { type: "cc", source: "cc-keychain", label: "label1" };

      expect(identitiesMatch(identity1, identity2)).toBe(true);
    });

    it("should not match CC accounts with different labels", () => {
      const identity1: AccountIdentity = { type: "cc", source: "cc-keychain", label: "label1" };
      const identity2: AccountIdentity = { type: "cc", source: "cc-keychain", label: "label2" };

      expect(identitiesMatch(identity1, identity2)).toBe(false);
    });

    it("should not match CC vs OAuth even with same email", () => {
      const ccIdentity: AccountIdentity = { type: "cc", source: "cc-keychain", label: "alice@example.com" };
      const oauthIdentity: AccountIdentity = { type: "oauth", email: "alice@example.com" };

      expect(identitiesMatch(ccIdentity, oauthIdentity)).toBe(false);
    });

    it("should match legacy accounts with same refreshToken", () => {
      const identity1: AccountIdentity = { type: "legacy", refreshToken: "rt_same" };
      const identity2: AccountIdentity = { type: "legacy", refreshToken: "rt_same" };

      expect(identitiesMatch(identity1, identity2)).toBe(true);
    });

    it("should not match legacy accounts with different refreshTokens", () => {
      const identity1: AccountIdentity = { type: "legacy", refreshToken: "rt_one" };
      const identity2: AccountIdentity = { type: "legacy", refreshToken: "rt_two" };

      expect(identitiesMatch(identity1, identity2)).toBe(false);
    });

    it("should not match different identity types", () => {
      const oauthIdentity: AccountIdentity = { type: "oauth", email: "alice@example.com" };
      const ccIdentity: AccountIdentity = { type: "cc", source: "cc-keychain", label: "label" };
      const legacyIdentity: AccountIdentity = { type: "legacy", refreshToken: "rt" };

      expect(identitiesMatch(oauthIdentity, ccIdentity)).toBe(false);
      expect(identitiesMatch(oauthIdentity, legacyIdentity)).toBe(false);
      expect(identitiesMatch(ccIdentity, legacyIdentity)).toBe(false);
    });
  });

  describe("findByIdentity", () => {
    const accounts: ManagedAccount[] = [oauthAccount, ccAccount, legacyAccount];

    it("should find matching OAuth account by email", () => {
      const targetIdentity: AccountIdentity = { type: "oauth", email: "alice@example.com" };
      const found = findByIdentity(accounts, targetIdentity);

      expect(found).toBe(oauthAccount);
    });

    it("should find matching CC account by source+label", () => {
      const targetIdentity: AccountIdentity = {
        type: "cc",
        source: "cc-keychain",
        label: "rt_cc_456",
      };
      const found = findByIdentity(accounts, targetIdentity);

      expect(found).toBe(ccAccount);
    });

    it("should find matching legacy account by refreshToken", () => {
      const targetIdentity: AccountIdentity = { type: "legacy", refreshToken: "rt_legacy_789" };
      const found = findByIdentity(accounts, targetIdentity);

      expect(found).toBe(legacyAccount);
    });

    it("should return undefined when no match found", () => {
      const targetIdentity: AccountIdentity = { type: "oauth", email: "unknown@example.com" };
      const found = findByIdentity(accounts, targetIdentity);

      expect(found).toBeUndefined();
    });

    it("should return first match when multiple accounts have same identity", () => {
      const duplicateAccount: ManagedAccount = {
        ...oauthAccount,
        id: "oauth-2",
        index: 3,
        refreshToken: "rt_oauth_999",
      };
      const accountsWithDuplicate = [...accounts, duplicateAccount];

      const targetIdentity: AccountIdentity = { type: "oauth", email: "alice@example.com" };
      const found = findByIdentity(accountsWithDuplicate, targetIdentity);

      expect(found).toBe(oauthAccount); // First match
    });
  });
});
