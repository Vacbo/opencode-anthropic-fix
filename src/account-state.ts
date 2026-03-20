import type { AccountMetadata, AccountStorage } from "./storage.js";

/**
 * Reset transient account tracking fields.
 */
export function resetAccountTracking(account: AccountMetadata): void {
  account.rateLimitResetTimes = {};
  account.consecutiveFailures = 0;
  account.lastFailureTime = null;
}

/**
 * Normalize active index after removing one account.
 */
export function adjustActiveIndexAfterRemoval(storage: AccountStorage, removedIndex: number): void {
  if (storage.accounts.length === 0) {
    storage.activeIndex = 0;
    return;
  }

  if (storage.activeIndex >= storage.accounts.length) {
    storage.activeIndex = storage.accounts.length - 1;
    return;
  }

  if (storage.activeIndex > removedIndex) {
    storage.activeIndex -= 1;
  }
}

export interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
  email?: string;
}

/**
 * Apply OAuth credentials to an existing account record.
 */
export function applyOAuthCredentials(account: AccountMetadata, credentials: OAuthCredentials): void {
  account.refreshToken = credentials.refresh;
  account.access = credentials.access;
  account.expires = credentials.expires;
  account.token_updated_at = Date.now();
  if (credentials.email) {
    account.email = credentials.email;
  }
}
