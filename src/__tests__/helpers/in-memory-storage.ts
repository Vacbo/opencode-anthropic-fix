import { vi } from "vitest";
import type { AccountMetadata, AccountStorage } from "../../storage.js";

/**
 * In-memory storage harness for testing account deduplication and
 * concurrent access scenarios without touching the real filesystem.
 */
export interface InMemoryStorage {
  /** Get the current in-memory snapshot (what the test subject sees) */
  snapshot(): AccountStorage;

  /** Replace the in-memory snapshot (simulates loading from disk) */
  setSnapshot(data: AccountStorage): void;

  /**
   * Mutate the "disk" state without affecting the caller's snapshot.
   * This simulates another process writing to the storage file while
   * the test subject holds an in-memory copy.
   */
  mutateDiskOnly(mutator: (disk: AccountStorage) => AccountStorage): void;

  /** Mock implementation of loadAccounts - returns disk state */
  loadAccountsMock: () => Promise<AccountStorage | null>;

  /** Mock implementation of saveAccounts - writes to disk */
  saveAccountsMock: (data: AccountStorage) => Promise<void>;
}

/**
 * Create an in-memory storage harness for testing.
 *
 * @param initial - Optional initial storage state. If not provided, returns null on load.
 * @returns Storage harness with snapshot management and mock functions
 *
 * @example
 * ```ts
 * const storage = createInMemoryStorage({
 *   version: 1,
 *   accounts: [{ refreshToken: "tok1", addedAt: 1000, lastUsed: 0, enabled: true }],
 *   activeIndex: 0,
 * });
 *
 * // Wire up mocks
 * vi.mock("../../storage.js", () => ({
 *   loadAccounts: storage.loadAccountsMock,
 *   saveAccounts: storage.saveAccountsMock,
 *   createDefaultStats: vi.fn((now?: number) => ({
 *     requests: 0,
 *     inputTokens: 0,
 *     outputTokens: 0,
 *     cacheReadTokens: 0,
 *     cacheWriteTokens: 0,
 *     lastReset: now ?? Date.now(),
 *   })),
 * }));
 * ```
 */
export function createInMemoryStorage(initial?: AccountStorage): InMemoryStorage {
  // Internal "disk" state - what loadAccounts would read from filesystem
  let diskState: AccountStorage | null = initial ?? null;

  // Internal "memory" state - what the test subject holds after loading
  let memoryState: AccountStorage | null = diskState;

  return {
    snapshot(): AccountStorage {
      if (memoryState === null) {
        throw new Error("Storage snapshot is null - did you forget to set initial data or call setSnapshot()?");
      }
      // Return deep copy to prevent accidental mutations via references
      return structuredClone(memoryState);
    },

    setSnapshot(data: AccountStorage): void {
      // Update both disk and memory to match
      diskState = structuredClone(data);
      memoryState = structuredClone(data);
    },

    mutateDiskOnly(mutator: (disk: AccountStorage) => AccountStorage): void {
      if (diskState === null) {
        throw new Error("Cannot mutate disk - disk state is null. Set initial data first.");
      }
      // Only mutate disk state, leaving memoryState unchanged
      // This simulates another process writing to the file
      diskState = mutator(structuredClone(diskState));
    },

    loadAccountsMock: vi.fn(async (): Promise<AccountStorage | null> => {
      // Simulate reading from disk - returns current disk state
      return diskState === null ? null : structuredClone(diskState);
    }),

    saveAccountsMock: vi.fn(async (data: AccountStorage): Promise<void> => {
      // Simulate writing to disk - updates disk state
      diskState = structuredClone(data);
    }),
  };
}

/**
 * Helper to create a minimal valid stored account for testing.
 */
export function makeStoredAccount(overrides: Partial<AccountMetadata> & { refreshToken: string }): AccountMetadata {
  const now = Date.now();
  return {
    id: `acct-${Math.random().toString(36).slice(2, 8)}`,
    email: overrides.email,
    refreshToken: overrides.refreshToken,
    access: overrides.access ?? "access-token",
    expires: overrides.expires ?? now + 3600_000,
    addedAt: overrides.addedAt ?? now,
    lastUsed: overrides.lastUsed ?? 0,
    enabled: overrides.enabled ?? true,
    rateLimitResetTimes: overrides.rateLimitResetTimes ?? {},
    consecutiveFailures: overrides.consecutiveFailures ?? 0,
    lastFailureTime: overrides.lastFailureTime ?? null,
    token_updated_at: overrides.token_updated_at ?? 0,
    stats: overrides.stats ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastReset: now,
    },
  };
}

/**
 * Helper to create a valid storage payload from account overrides.
 */
export function makeAccountsData(
  accountOverrides: Array<Partial<AccountMetadata> & { refreshToken: string }>,
  extra: Partial<AccountStorage> = {},
): AccountStorage {
  return {
    version: 1,
    accounts: accountOverrides.map((o, i) =>
      makeStoredAccount({
        addedAt: (i + 1) * 1000,
        ...o,
      }),
    ),
    activeIndex: 0,
    ...extra,
  };
}
