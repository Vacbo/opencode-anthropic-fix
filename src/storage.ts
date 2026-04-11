import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AccountIdentity } from "./account-identity.js";
import { findByIdentity } from "./account-identity.js";
import { getConfigDir } from "./config.js";

export interface AccountStats {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastReset: number;
}

export interface AccountMetadata {
  id: string;
  email?: string;
  identity?: AccountIdentity;
  label?: string;
  refreshToken: string;
  access?: string;
  expires?: number;
  token_updated_at: number;
  addedAt: number;
  lastUsed: number;
  enabled: boolean;
  rateLimitResetTimes: Record<string, number>;
  consecutiveFailures: number;
  lastFailureTime: number | null;
  lastSwitchReason?: string;
  stats: AccountStats;
  source?: "cc-keychain" | "cc-file" | "oauth";
}

export interface AccountStorage {
  version: number;
  accounts: AccountMetadata[];
  activeIndex: number;
}

export type StoredAccountMatchCandidate = Pick<
  AccountMetadata,
  "id" | "email" | "identity" | "label" | "refreshToken" | "addedAt" | "source"
>;

const CURRENT_VERSION = 1;

/**
 * Create a fresh stats object.
 */
export function createDefaultStats(now?: number): AccountStats {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastReset: now ?? Date.now(),
  };
}

function validateStats(raw: unknown, now: number): AccountStats {
  if (!raw || typeof raw !== "object") return createDefaultStats(now);
  const s = raw as Record<string, unknown>;
  const safeNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    requests: safeNum(s.requests),
    inputTokens: safeNum(s.inputTokens),
    outputTokens: safeNum(s.outputTokens),
    cacheReadTokens: safeNum(s.cacheReadTokens),
    cacheWriteTokens: safeNum(s.cacheWriteTokens),
    lastReset: typeof s.lastReset === "number" && Number.isFinite(s.lastReset) ? s.lastReset : now,
  };
}

const GITIGNORE_ENTRIES = [".gitignore", "anthropic-accounts.json", "anthropic-accounts.json.*.tmp"];

/**
 * Get the path to the accounts storage file.
 */
export function getStoragePath(): string {
  return join(getConfigDir(), "anthropic-accounts.json");
}

/**
 * Ensure .gitignore in the config directory includes our files.
 */
export function ensureGitignore(configDir: string): void {
  const gitignorePath = join(configDir, ".gitignore");
  try {
    let content = "";
    let existingLines: string[] = [];

    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, "utf-8");
      existingLines = content.split("\n").map((line) => line.trim());
    }

    const missingEntries = GITIGNORE_ENTRIES.filter((entry) => !existingLines.includes(entry));

    if (missingEntries.length === 0) return;

    if (content === "") {
      writeFileSync(gitignorePath, missingEntries.join("\n") + "\n", "utf-8");
    } else {
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, suffix + missingEntries.join("\n") + "\n", "utf-8");
    }
  } catch {
    // Ignore gitignore errors
  }
}

/**
 * Deduplicate accounts by refresh token, keeping the most recently used.
 */
export function deduplicateByRefreshToken(accounts: AccountMetadata[]): AccountMetadata[] {
  const tokenMap = new Map<string, AccountMetadata>();

  for (const acc of accounts) {
    if (!acc.refreshToken) continue;
    const existing = tokenMap.get(acc.refreshToken);
    if (!existing || (acc.lastUsed || 0) > (existing.lastUsed || 0)) {
      tokenMap.set(acc.refreshToken, acc);
    }
  }

  return Array.from(tokenMap.values());
}

function validateAccount(raw: unknown, now: number): AccountMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const acc = raw as Record<string, unknown>;

  if (typeof acc.refreshToken !== "string" || !acc.refreshToken) return null;

  const addedAt = typeof acc.addedAt === "number" && Number.isFinite(acc.addedAt) ? acc.addedAt : now;

  const id = typeof acc.id === "string" && acc.id ? acc.id : `${addedAt}:${(acc.refreshToken as string).slice(0, 12)}`;

  return {
    id,
    email: typeof acc.email === "string" ? acc.email : undefined,
    identity: isAccountIdentity(acc.identity) ? acc.identity : undefined,
    label: typeof acc.label === "string" ? acc.label : undefined,
    refreshToken: acc.refreshToken as string,
    access: typeof acc.access === "string" ? acc.access : undefined,
    expires: typeof acc.expires === "number" && Number.isFinite(acc.expires) ? acc.expires : undefined,
    token_updated_at:
      typeof acc.token_updated_at === "number" && Number.isFinite(acc.token_updated_at)
        ? acc.token_updated_at
        : typeof acc.tokenUpdatedAt === "number" && Number.isFinite(acc.tokenUpdatedAt)
          ? (acc.tokenUpdatedAt as number)
          : addedAt,
    addedAt,
    lastUsed: typeof acc.lastUsed === "number" && Number.isFinite(acc.lastUsed) ? acc.lastUsed : 0,
    enabled: acc.enabled !== false,
    rateLimitResetTimes:
      acc.rateLimitResetTimes && typeof acc.rateLimitResetTimes === "object" && !Array.isArray(acc.rateLimitResetTimes)
        ? (acc.rateLimitResetTimes as Record<string, number>)
        : {},
    consecutiveFailures:
      typeof acc.consecutiveFailures === "number" ? Math.max(0, Math.floor(acc.consecutiveFailures)) : 0,
    lastFailureTime: typeof acc.lastFailureTime === "number" ? acc.lastFailureTime : null,
    lastSwitchReason: typeof acc.lastSwitchReason === "string" ? acc.lastSwitchReason : undefined,
    stats: validateStats(acc.stats, now),
    source: acc.source === "cc-keychain" || acc.source === "cc-file" || acc.source === "oauth" ? acc.source : undefined,
  };
}

function isAccountIdentity(value: unknown): value is AccountIdentity {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "oauth":
      return typeof candidate.email === "string" && candidate.email.length > 0;
    case "cc":
      return (
        (candidate.source === "cc-keychain" || candidate.source === "cc-file") && typeof candidate.label === "string"
      );
    case "legacy":
      return typeof candidate.refreshToken === "string" && candidate.refreshToken.length > 0;
    default:
      return false;
  }
}

function resolveStoredIdentity(candidate: StoredAccountMatchCandidate): AccountIdentity {
  if (isAccountIdentity(candidate.identity)) {
    return candidate.identity;
  }

  if (candidate.source === "oauth" && candidate.email) {
    return { kind: "oauth", email: candidate.email };
  }

  if ((candidate.source === "cc-keychain" || candidate.source === "cc-file") && candidate.label) {
    return {
      kind: "cc",
      source: candidate.source,
      label: candidate.label,
    };
  }

  return { kind: "legacy", refreshToken: candidate.refreshToken };
}

function resolveTokenUpdatedAt(account: Pick<AccountMetadata, "token_updated_at" | "addedAt">): number {
  return typeof account.token_updated_at === "number" && Number.isFinite(account.token_updated_at)
    ? account.token_updated_at
    : account.addedAt;
}

function clampActiveIndex(accounts: AccountMetadata[], activeIndex: number): number {
  if (accounts.length === 0) {
    return 0;
  }

  return Math.max(0, Math.min(activeIndex, accounts.length - 1));
}

export function findStoredAccountMatch(
  accounts: AccountMetadata[],
  candidate: StoredAccountMatchCandidate,
): AccountMetadata | null {
  const byId = accounts.find((account) => account.id === candidate.id);
  if (byId) {
    return byId;
  }

  const byIdentity = findByIdentity(accounts, resolveStoredIdentity(candidate));
  if (byIdentity) {
    return byIdentity;
  }

  const byAddedAt = accounts.filter((account) => account.addedAt === candidate.addedAt);
  if (byAddedAt.length === 1) {
    return byAddedAt[0]!;
  }

  const byRefreshToken = accounts.find((account) => account.refreshToken === candidate.refreshToken);
  if (byRefreshToken) {
    return byRefreshToken;
  }

  return byAddedAt[0] ?? null;
}

export function mergeAccountWithFresherAuth(
  account: AccountMetadata,
  diskMatch: AccountMetadata | null,
): AccountMetadata {
  const memoryTokenUpdatedAt = resolveTokenUpdatedAt(account);
  const diskTokenUpdatedAt = diskMatch ? resolveTokenUpdatedAt(diskMatch) : 0;

  if (!diskMatch || diskTokenUpdatedAt <= memoryTokenUpdatedAt) {
    return {
      ...account,
      token_updated_at: memoryTokenUpdatedAt,
    };
  }

  return {
    ...account,
    refreshToken: diskMatch.refreshToken,
    access: diskMatch.access,
    expires: diskMatch.expires,
    token_updated_at: diskTokenUpdatedAt,
  };
}

export function unionAccountsWithDisk(storage: AccountStorage, disk: AccountStorage | null): AccountStorage {
  if (!disk || storage.accounts.length === 0) {
    return {
      ...storage,
      activeIndex: clampActiveIndex(storage.accounts, storage.activeIndex),
    };
  }

  const activeAccountId = storage.accounts[storage.activeIndex]?.id ?? null;
  const matchedDiskAccounts = new Set<AccountMetadata>();
  const mergedAccounts = storage.accounts.map((account) => {
    const diskMatch = findStoredAccountMatch(disk.accounts, account);
    if (diskMatch) {
      matchedDiskAccounts.add(diskMatch);
    }

    return mergeAccountWithFresherAuth(account, diskMatch);
  });

  const diskOnlyAccounts = disk.accounts.filter((account) => !matchedDiskAccounts.has(account));
  const accounts = [...mergedAccounts, ...diskOnlyAccounts];
  const activeIndex = activeAccountId ? accounts.findIndex((account) => account.id === activeAccountId) : -1;

  return {
    ...storage,
    accounts,
    activeIndex: activeIndex >= 0 ? activeIndex : clampActiveIndex(accounts, storage.activeIndex),
  };
}

/**
 * Load accounts from disk.
 */
export async function loadAccounts(): Promise<AccountStorage | null> {
  const storagePath = getStoragePath();

  try {
    const content = await fs.readFile(storagePath, "utf-8");
    const data = JSON.parse(content);

    if (!data || typeof data !== "object" || !Array.isArray(data.accounts)) {
      return null;
    }

    if (data.version !== CURRENT_VERSION) {
      // eslint-disable-next-line no-console -- operator diagnostic: storage version mismatch before migration attempt
      console.warn(
        `Storage version mismatch: ${String(data.version)} vs ${CURRENT_VERSION}. Attempting best-effort migration.`,
      );
    }

    const now = Date.now();
    const accounts = data.accounts
      .map((raw: unknown) => validateAccount(raw, now))
      .filter((acc: AccountMetadata | null): acc is AccountMetadata => acc !== null);

    const deduped = deduplicateByRefreshToken(accounts);

    let activeIndex = typeof data.activeIndex === "number" && Number.isFinite(data.activeIndex) ? data.activeIndex : 0;

    if (deduped.length > 0) {
      activeIndex = Math.max(0, Math.min(activeIndex, deduped.length - 1));
    } else {
      activeIndex = 0;
    }

    return {
      version: CURRENT_VERSION,
      accounts: deduped,
      activeIndex,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return null;
  }
}

/**
 * Save accounts to disk atomically.
 */
export async function saveAccounts(storage: AccountStorage): Promise<void> {
  const storagePath = getStoragePath();
  const configDir = dirname(storagePath);

  await fs.mkdir(configDir, { recursive: true });
  ensureGitignore(configDir);

  let storageToWrite = {
    ...storage,
    activeIndex: clampActiveIndex(storage.accounts, storage.activeIndex),
  };

  // Merge auth fields against disk by freshness to avoid stale-process clobber.
  try {
    const disk = await loadAccounts();
    storageToWrite = unionAccountsWithDisk(storageToWrite, disk);
  } catch {
    // If merge read fails, continue with caller-provided storage payload.
  }

  const tempPath = `${storagePath}.${randomBytes(6).toString("hex")}.tmp`;
  const content = JSON.stringify(storageToWrite, null, 2);

  try {
    await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tempPath, storagePath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Clear all accounts from disk.
 */
export async function clearAccounts(): Promise<void> {
  const storagePath = getStoragePath();
  try {
    await fs.unlink(storagePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}
