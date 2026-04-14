/**
 * Unbounded state bounds tests (Task 13 from quality-refactor plan)
 *
 * Verifies cap helpers enforce FIFO eviction and TTL cleanup for
 * long-lived in-memory collections.
 */

import { describe, it, expect } from "vitest";

import { capFileAccountMap, FILE_ACCOUNT_MAP_MAX_SIZE } from "../../../src/commands/router.js";
import {
    pruneExpiredPendingOAuth,
    PENDING_OAUTH_TTL_MS,
    type PendingOAuthEntry,
} from "../../../src/commands/oauth-flow.js";

function makePendingEntry(createdAt: number): PendingOAuthEntry {
    return {
        mode: "login",
        verifier: "test-verifier",
        createdAt,
    };
}

describe("capFileAccountMap FIFO eviction", () => {
    it("exports FILE_ACCOUNT_MAP_MAX_SIZE = 1000", () => {
        expect(FILE_ACCOUNT_MAP_MAX_SIZE).toBe(1000);
    });

    it("caps the map at FILE_ACCOUNT_MAP_MAX_SIZE entries", () => {
        const map = new Map<string, number>();
        for (let i = 0; i < FILE_ACCOUNT_MAP_MAX_SIZE + 100; i++) {
            capFileAccountMap(map, `file_${i}`, i % 5);
        }
        expect(map.size).toBeLessThanOrEqual(FILE_ACCOUNT_MAP_MAX_SIZE);
    });

    it("evicts oldest entries first (FIFO)", () => {
        const map = new Map<string, number>();
        for (let i = 0; i < FILE_ACCOUNT_MAP_MAX_SIZE; i++) {
            capFileAccountMap(map, `file_${i}`, 0);
        }
        capFileAccountMap(map, "file_overflow", 1);
        expect(map.has("file_0")).toBe(false);
        expect(map.has("file_overflow")).toBe(true);
        expect(map.size).toBe(FILE_ACCOUNT_MAP_MAX_SIZE);
    });

    it("updates value of existing key when below cap", () => {
        const map = new Map<string, number>();
        capFileAccountMap(map, "file_a", 1);
        capFileAccountMap(map, "file_a", 2);
        expect(map.get("file_a")).toBe(2);
        expect(map.size).toBe(1);
    });

    it("handles rapid insertion under cap without eviction", () => {
        const map = new Map<string, number>();
        for (let i = 0; i < 500; i++) {
            capFileAccountMap(map, `file_${i}`, 0);
        }
        expect(map.size).toBe(500);
        expect(map.has("file_0")).toBe(true);
        expect(map.has("file_499")).toBe(true);
    });
});

describe("pruneExpiredPendingOAuth TTL cleanup", () => {
    it("exports PENDING_OAUTH_TTL_MS = 10 minutes", () => {
        expect(PENDING_OAUTH_TTL_MS).toBe(10 * 60 * 1000);
    });

    it("removes entries older than TTL", () => {
        const map = new Map<string, PendingOAuthEntry>();
        const now = Date.now();
        map.set("expired", makePendingEntry(now - PENDING_OAUTH_TTL_MS - 1000));
        map.set("fresh", makePendingEntry(now));

        pruneExpiredPendingOAuth(map);

        expect(map.has("expired")).toBe(false);
        expect(map.has("fresh")).toBe(true);
    });

    it("does not remove entries just inside the TTL boundary", () => {
        const map = new Map<string, PendingOAuthEntry>();
        const now = Date.now();
        map.set("boundary", makePendingEntry(now - PENDING_OAUTH_TTL_MS + 1000));

        pruneExpiredPendingOAuth(map);

        expect(map.has("boundary")).toBe(true);
    });

    it("handles empty map without error", () => {
        const map = new Map<string, PendingOAuthEntry>();
        expect(() => pruneExpiredPendingOAuth(map)).not.toThrow();
    });

    it("removes only expired entries, leaves fresh ones", () => {
        const map = new Map<string, PendingOAuthEntry>();
        const now = Date.now();
        map.set("old1", makePendingEntry(now - PENDING_OAUTH_TTL_MS - 5000));
        map.set("old2", makePendingEntry(now - PENDING_OAUTH_TTL_MS - 2000));
        map.set("new1", makePendingEntry(now - 1000));
        map.set("new2", makePendingEntry(now));

        pruneExpiredPendingOAuth(map);

        expect(map.size).toBe(2);
        expect(map.has("new1")).toBe(true);
        expect(map.has("new2")).toBe(true);
    });
});
