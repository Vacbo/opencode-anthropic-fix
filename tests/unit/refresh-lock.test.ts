import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const baseDir = join(tmpdir(), `opencode-refresh-lock-test-${process.pid}`);
const storagePath = join(baseDir, "anthropic-accounts.json");
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_LOCK_MS = 90_000;

vi.mock("../../src/storage.js", () => ({
    getStoragePath: () => storagePath,
}));

import { acquireRefreshLock, releaseRefreshLock } from "../../src/refresh-lock.js";

describe("refresh-lock", () => {
    beforeEach(async () => {
        await fs.rm(baseDir, { recursive: true, force: true });
        await fs.mkdir(baseDir, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(baseDir, { recursive: true, force: true });
    });

    it("does not release lock with mismatched owner", async () => {
        const lock = await acquireRefreshLock("acc-1");
        expect(lock.acquired).toBe(true);
        expect(lock.lockPath).toBeTruthy();
        const lockPath = lock.lockPath!;

        await releaseRefreshLock({ lockPath, owner: "wrong-owner" });

        await expect(fs.stat(lockPath)).resolves.toBeTruthy();

        await releaseRefreshLock(lock);
        await expect(fs.stat(lockPath)).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("acquires a new lock after stale lock timeout", async () => {
        const first = await acquireRefreshLock("acc-2", {
            timeoutMs: 50,
            staleMs: 10_000,
        });
        expect(first.acquired).toBe(true);
        const firstLockPath = first.lockPath!;

        const old = Date.now() / 1000 - 120;
        await fs.utimes(firstLockPath, old, old);

        const second = await acquireRefreshLock("acc-2", {
            timeoutMs: 200,
            backoffMs: 5,
            staleMs: 20,
        });
        expect(second.acquired).toBe(true);
        expect(second.owner).not.toBe(first.owner);

        await releaseRefreshLock(second);
    });

    it("returns not acquired when lock remains busy", async () => {
        const first = await acquireRefreshLock("acc-3", { timeoutMs: 50 });
        expect(first.acquired).toBe(true);

        const second = await acquireRefreshLock("acc-3", {
            timeoutMs: 30,
            backoffMs: 5,
            staleMs: DEFAULT_STALE_LOCK_MS,
        });
        expect(second.acquired).toBe(false);

        await releaseRefreshLock(first);
    });

    it("stale reaper does NOT steal a lock held for 60s", async () => {
        const first = await acquireRefreshLock("acc-stable-refresh", {
            timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
        });
        expect(first.acquired).toBe(true);
        expect(first.lockPath).toBeTruthy();
        const firstLockPath = first.lockPath!;

        const sixtySecondsAgo = Date.now() / 1000 - 60;
        await fs.utimes(firstLockPath, sixtySecondsAgo, sixtySecondsAgo);

        const second = await acquireRefreshLock("acc-stable-refresh", {
            timeoutMs: 30,
            backoffMs: 5,
            staleMs: DEFAULT_STALE_LOCK_MS,
        });
        expect(second.acquired).toBe(false);

        await expect(fs.stat(firstLockPath)).resolves.toBeTruthy();
        await releaseRefreshLock(first);
    });

    it("does not release when inode changed even if owner matches", async () => {
        const first = await acquireRefreshLock("acc-4");
        expect(first.acquired).toBe(true);
        const firstLockPath = first.lockPath!;
        const originalLockInode = first.lockInode;
        expect(originalLockInode).not.toBeNull();

        // Keep the same owner text but pass a deliberately mismatched inode. This
        // tests the safety check directly without relying on filesystem-specific
        // inode allocation behavior, which can aggressively recycle inode numbers
        // on Linux CI runners.
        await fs.writeFile(firstLockPath, JSON.stringify({ owner: first.owner, createdAt: Date.now() }), {
            encoding: "utf-8",
            mode: 0o600,
        });

        await releaseRefreshLock({
            lockPath: firstLockPath,
            owner: first.owner,
            lockInode: originalLockInode! + 1n,
        });

        await expect(fs.stat(firstLockPath)).resolves.toBeTruthy();

        await fs.unlink(firstLockPath);
    });
});
