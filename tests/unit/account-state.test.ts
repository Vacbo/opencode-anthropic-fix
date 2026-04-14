import { describe, expect, it } from "vitest";

import { adjustActiveIndexAfterRemoval, applyOAuthCredentials, resetAccountTracking } from "../../src/account-state.js";
import { makeAccountsData, makeStoredAccount } from "../helpers/in-memory-storage.js";

describe("resetAccountTracking", () => {
    it("resets rate-limit and failure fields", () => {
        const account = makeStoredAccount({
            refreshToken: "refresh-token",
            rateLimitResetTimes: { anthropic: Date.now() + 60_000 },
            consecutiveFailures: 7,
            lastFailureTime: Date.now(),
        });

        resetAccountTracking(account);

        expect(account.rateLimitResetTimes).toEqual({});
        expect(account.consecutiveFailures).toBe(0);
        expect(account.lastFailureTime).toBeNull();
    });
});

describe("applyOAuthCredentials", () => {
    it("applies refresh/access/expiry and optional email", () => {
        const account = makeStoredAccount({
            refreshToken: "old-refresh",
            access: "old-access",
            expires: 1,
            email: "old@example.com",
        });

        applyOAuthCredentials(account, {
            refresh: "new-refresh",
            access: "new-access",
            expires: 123,
            email: "new@example.com",
        });

        expect(account).toEqual(
            expect.objectContaining({
                refreshToken: "new-refresh",
                access: "new-access",
                expires: 123,
                token_updated_at: expect.any(Number),
                email: "new@example.com",
            }),
        );
    });

    it("preserves existing email when credentials omit email", () => {
        const account = makeStoredAccount({
            refreshToken: "old-refresh",
            access: "old-access",
            expires: 1,
            email: "old@example.com",
        });

        applyOAuthCredentials(account, {
            refresh: "new-refresh",
            access: "new-access",
            expires: 456,
        });

        expect(account.email).toBe("old@example.com");
        expect(account.refreshToken).toBe("new-refresh");
        expect(account.access).toBe("new-access");
        expect(account.expires).toBe(456);
        expect(account.token_updated_at).toEqual(expect.any(Number));
    });
});

describe("adjustActiveIndexAfterRemoval", () => {
    it("resets activeIndex to 0 when no accounts remain", () => {
        const storage = makeAccountsData([], { activeIndex: 3 });
        adjustActiveIndexAfterRemoval(storage, 0);
        expect(storage.activeIndex).toBe(0);
    });

    it("clamps activeIndex when it falls out of range", () => {
        const storage = makeAccountsData(
            [
                { refreshToken: "a", id: "a" },
                { refreshToken: "b", id: "b" },
            ],
            {
                activeIndex: 2,
            },
        );
        adjustActiveIndexAfterRemoval(storage, 0);
        expect(storage.activeIndex).toBe(1);
    });

    it("decrements activeIndex when removed index is before active", () => {
        const storage = makeAccountsData(
            [
                { refreshToken: "a", id: "a" },
                { refreshToken: "b", id: "b" },
                { refreshToken: "c", id: "c" },
            ],
            { activeIndex: 2 },
        );
        adjustActiveIndexAfterRemoval(storage, 0);
        expect(storage.activeIndex).toBe(1);
    });

    it("keeps activeIndex when removed index is after active", () => {
        const storage = makeAccountsData(
            [
                { refreshToken: "a", id: "a" },
                { refreshToken: "b", id: "b" },
                { refreshToken: "c", id: "c" },
            ],
            { activeIndex: 0 },
        );
        adjustActiveIndexAfterRemoval(storage, 2);
        expect(storage.activeIndex).toBe(0);
    });

    it("keeps activeIndex when removed index was the active slot", () => {
        const storage = makeAccountsData(
            [
                { refreshToken: "a", id: "a" },
                { refreshToken: "b", id: "b" },
                { refreshToken: "c", id: "c" },
            ],
            { activeIndex: 1 },
        );
        adjustActiveIndexAfterRemoval(storage, 1);
        expect(storage.activeIndex).toBe(1);
    });
});
