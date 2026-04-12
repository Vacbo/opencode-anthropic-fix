import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { getStoragePath } from "./storage.js";

const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_BACKOFF_MS = 50;
const DEFAULT_STALE_LOCK_MS = 90_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLockPath(accountId: string): string {
  const hash = createHash("sha1").update(accountId).digest("hex").slice(0, 24);
  return join(dirname(getStoragePath()), "locks", `refresh-${hash}.lock`);
}

export interface RefreshLockResult {
  acquired: boolean;
  lockPath: string | null;
  owner: string | null;
  lockInode: bigint | null;
}

export interface AcquireLockOptions {
  timeoutMs?: number;
  backoffMs?: number;
  staleMs?: number;
}

/**
 * Try to acquire a per-account cross-process lock.
 */
export async function acquireRefreshLock(
  accountId: string,
  options: AcquireLockOptions = {},
): Promise<RefreshLockResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? DEFAULT_LOCK_BACKOFF_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const lockPath = getLockPath(accountId);
  const lockDir = dirname(lockPath);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const owner = randomBytes(12).toString("hex");

  await fs.mkdir(lockDir, { recursive: true });

  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), owner }), "utf-8");
        const stat = await handle.stat({ bigint: true });
        return { acquired: true, lockPath, owner, lockInode: stat.ino };
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      try {
        const stat = await fs.stat(lockPath, { bigint: true });
        if (Date.now() - Number(stat.mtimeMs) > staleMs) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch {
        // Lock may have been released concurrently; retry.
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const jitter = Math.floor(Math.random() * 25);
      await delay(Math.min(remaining, backoffMs + jitter));
    }
  }

  return { acquired: false, lockPath: null, owner: null, lockInode: null };
}

export type ReleaseLockInput =
  | {
      lockPath: string | null;
      owner?: string | null;
      lockInode?: bigint | null;
    }
  | string
  | null;

/**
 * Release a lock acquired by acquireRefreshLock.
 */
export async function releaseRefreshLock(lock: ReleaseLockInput): Promise<void> {
  const lockPath = typeof lock === "string" || lock === null ? lock : lock.lockPath;
  const owner = typeof lock === "object" && lock ? lock.owner || null : null;
  const lockInode = typeof lock === "object" && lock ? (lock.lockInode ?? null) : null;

  if (!lockPath) return;

  // Ownership-safe release: avoid deleting a lock that another process
  // acquired after ours became stale.
  if (owner) {
    try {
      const content = await fs.readFile(lockPath, "utf-8");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || parsed.owner !== owner) {
        return;
      }

      if (lockInode) {
        const stat = await fs.stat(lockPath, { bigint: true });
        if (stat.ino !== lockInode) {
          return;
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      // If unreadable/corrupt, fail closed to avoid deleting another
      // process's lock when ownership cannot be verified.
      return;
    }
  }

  try {
    await fs.unlink(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}
