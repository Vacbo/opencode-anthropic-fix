import type { CCCredential } from "./cc-credentials.js";
import type { ManagedAccount } from "./accounts.js";
import type { AccountMetadata } from "./storage.js";

type CCAccountSource = "cc-keychain" | "cc-file";

export type AccountIdentity =
  | { kind: "oauth"; email: string }
  | { kind: "cc"; source: CCAccountSource; label: string }
  | { kind: "legacy"; refreshToken: string };

type IdentityAccount = ManagedAccount | AccountMetadata;

function isCCAccountSource(source: IdentityAccount["source"]): source is CCAccountSource {
  return source === "cc-keychain" || source === "cc-file";
}

function isAccountIdentity(value: unknown): value is AccountIdentity {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "oauth":
      return typeof candidate.email === "string" && candidate.email.length > 0;
    case "cc":
      return isCCAccountSource(candidate.source as IdentityAccount["source"]) && typeof candidate.label === "string";
    case "legacy":
      return typeof candidate.refreshToken === "string" && candidate.refreshToken.length > 0;
    default:
      return false;
  }
}

export function resolveIdentity(account: IdentityAccount): AccountIdentity {
  if (isAccountIdentity(account.identity)) {
    return account.identity;
  }

  if (account.source === "oauth" && account.email) {
    return { kind: "oauth", email: account.email };
  }

  if (isCCAccountSource(account.source) && account.label) {
    return { kind: "cc", source: account.source, label: account.label };
  }

  return { kind: "legacy", refreshToken: account.refreshToken };
}

export function resolveIdentityFromCCCredential(cred: CCCredential): AccountIdentity {
  return {
    kind: "cc",
    source: cred.source,
    label: cred.label,
  };
}

export function resolveIdentityFromOAuthExchange(result: { email?: string; refresh: string }): AccountIdentity {
  if (result.email) {
    return {
      kind: "oauth",
      email: result.email,
    };
  }

  return {
    kind: "legacy",
    refreshToken: result.refresh,
  };
}

export function identitiesMatch(a: AccountIdentity, b: AccountIdentity): boolean {
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case "oauth": {
      return a.email === (b as Extract<AccountIdentity, { kind: "oauth" }>).email;
    }
    case "cc": {
      const ccIdentity = b as Extract<AccountIdentity, { kind: "cc" }>;
      return a.source === ccIdentity.source && a.label === ccIdentity.label;
    }
    case "legacy": {
      return a.refreshToken === (b as Extract<AccountIdentity, { kind: "legacy" }>).refreshToken;
    }
  }
}

export function findByIdentity<T extends IdentityAccount>(accounts: T[], id: AccountIdentity): T | null {
  for (const account of accounts) {
    if (identitiesMatch(resolveIdentity(account), id)) {
      return account;
    }
  }

  return null;
}

export function serializeIdentity(id: AccountIdentity): string {
  switch (id.kind) {
    case "oauth":
      return `oauth:${id.email}`;
    case "cc":
      return `cc:${id.source}:${id.label}`;
    case "legacy":
      return "legacy:redacted";
  }
}
