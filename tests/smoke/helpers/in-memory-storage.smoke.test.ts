import { describe, expect, it } from "vitest";
import { createInMemoryStorage, makeAccountsData, makeStoredAccount } from "../../helpers/in-memory-storage.js";

describe("in-memory-storage smoke tests", () => {
    it("createInMemoryStorage creates storage with initial data", () => {
        const initial = makeAccountsData([{ refreshToken: "tok1" }]);
        const storage = createInMemoryStorage(initial);

        expect(storage.snapshot()).toEqual(initial);
    });

    it("createInMemoryStorage creates storage with null initial state", async () => {
        const storage = createInMemoryStorage();

        // loadAccountsMock should return null
        const loaded = await storage.loadAccountsMock();
        expect(loaded).toBeNull();

        // snapshot should throw when null
        expect(() => storage.snapshot()).toThrow("Storage snapshot is null");
    });

    it("setSnapshot updates both disk and memory state", async () => {
        const storage = createInMemoryStorage();
        const data = makeAccountsData([{ refreshToken: "tok1" }]);

        storage.setSnapshot(data);

        // Memory should match
        expect(storage.snapshot()).toEqual(data);

        // Disk should match (via loadAccountsMock)
        const loaded = await storage.loadAccountsMock();
        expect(loaded).toEqual(data);
    });

    it("snapshot returns deep copy - mutations don't affect storage", () => {
        const initial = makeAccountsData([{ refreshToken: "tok1", enabled: true }]);
        const storage = createInMemoryStorage(initial);

        const snap = storage.snapshot();
        snap.accounts[0].enabled = false;
        snap.accounts[0].refreshToken = "mutated";

        // Storage should be unchanged
        const snap2 = storage.snapshot();
        expect(snap2.accounts[0].enabled).toBe(true);
        expect(snap2.accounts[0].refreshToken).toBe("tok1");
    });

    it("saveAccountsMock writes to disk state", async () => {
        const storage = createInMemoryStorage();
        const data = makeAccountsData([{ refreshToken: "tok1" }]);

        // Save via mock
        await storage.saveAccountsMock(data);

        // Should be readable via loadAccountsMock
        const loaded = await storage.loadAccountsMock();
        expect(loaded).toEqual(data);
    });

    it("mutateDiskOnly changes disk without affecting caller's snapshot", () => {
        const initial = makeAccountsData([{ refreshToken: "tok1", enabled: true }]);
        const storage = createInMemoryStorage(initial);

        // Get current snapshot (what test subject holds)
        const beforeSnapshot = storage.snapshot();
        expect(beforeSnapshot.accounts[0].enabled).toBe(true);

        // Simulate another process writing to disk
        storage.mutateDiskOnly((disk) => ({
            ...disk,
            accounts: disk.accounts.map((a) => ({ ...a, enabled: false })),
        }));

        // Caller's snapshot should be unchanged
        const afterSnapshot = storage.snapshot();
        expect(afterSnapshot.accounts[0].enabled).toBe(true);

        // But disk state should be changed
        expect(afterSnapshot.accounts[0].enabled).toBe(true); // Still true in memory
    });

    it("mutateDiskOnly affects subsequent loadAccountsMock calls", async () => {
        const initial = makeAccountsData([{ refreshToken: "tok1", enabled: true }]);
        const storage = createInMemoryStorage(initial);

        // Mutate disk
        storage.mutateDiskOnly((disk) => ({
            ...disk,
            accounts: disk.accounts.map((a) => ({ ...a, enabled: false })),
        }));

        // Load should see the mutated state
        const loaded = await storage.loadAccountsMock();
        expect(loaded?.accounts[0].enabled).toBe(false);
    });

    it("mutateDiskOnly throws when disk state is null", () => {
        const storage = createInMemoryStorage();

        expect(() =>
            storage.mutateDiskOnly((disk) => ({
                ...disk,
                accounts: [],
            })),
        ).toThrow("Cannot mutate disk - disk state is null");
    });

    it("makeStoredAccount creates valid account with defaults", () => {
        const account = makeStoredAccount({ refreshToken: "my-token" });

        expect(account.refreshToken).toBe("my-token");
        expect(account.id).toMatch(/^acct-/);
        expect(account.enabled).toBe(true);
        expect(account.consecutiveFailures).toBe(0);
        expect(account.lastFailureTime).toBeNull();
        expect(account.stats.requests).toBe(0);
        expect(account.addedAt).toBeGreaterThan(0);
    });

    it("makeStoredAccount applies overrides", () => {
        const account = makeStoredAccount({
            refreshToken: "tok1",
            enabled: false,
            consecutiveFailures: 5,
            email: "test@example.com",
        });

        expect(account.refreshToken).toBe("tok1");
        expect(account.enabled).toBe(false);
        expect(account.consecutiveFailures).toBe(5);
        expect(account.email).toBe("test@example.com");
    });

    it("makeAccountsData creates storage with multiple accounts", () => {
        const data = makeAccountsData([
            { refreshToken: "tok1", email: "a@test.com" },
            { refreshToken: "tok2", email: "b@test.com" },
        ]);

        expect(data.version).toBe(1);
        expect(data.activeIndex).toBe(0);
        expect(data.accounts).toHaveLength(2);
        expect(data.accounts[0].refreshToken).toBe("tok1");
        expect(data.accounts[1].refreshToken).toBe("tok2");
        expect(data.accounts[0].addedAt).toBe(1000);
        expect(data.accounts[1].addedAt).toBe(2000);
    });

    it("makeAccountsData accepts extra storage fields", () => {
        const data = makeAccountsData([{ refreshToken: "tok1" }], {
            activeIndex: 2,
        });

        expect(data.activeIndex).toBe(2);
    });

    it("storage mocks are vi.fn() instances", () => {
        const storage = createInMemoryStorage();

        expect(storage.loadAccountsMock).toBeDefined();
        expect(storage.saveAccountsMock).toBeDefined();
    });
});
