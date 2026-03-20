/**
 * Shared type definitions for the CC analysis pipeline.
 */

export interface OAuthFingerprint {
  clientIds: string[];
  scopes: string[];
  endpoints: Record<string, string | string[]>;
  pkce: {
    hasCodeChallenge: boolean;
    hasCodeVerifier: boolean;
    method: string | null;
    s256Confirmed: boolean;
  };
}

export interface HeadersFingerprint {
  userAgent: {
    template?: string;
    hasExternal: boolean;
  };
  sdkVersion: string | null;
  axiosVersion: string | null;
  stainlessHeaders: Record<string, string | null>;
}

export interface BetasFingerprint {
  betas: string[];
  bedrockUnsupported: string[];
  oauthBeta: string | null;
  oauthBetas: string[];
}

export interface BillingFingerprint {
  cch: string | null;
  allCchValues: string[];
  salt: string | null;
  allSalts: string[];
  template: string | null;
  allTemplates: string[];
  hashPositions: Array<{ start: number; end: number }>;
}

export interface Fingerprint {
  version: string;
  extractedAt: string;
  oauth: OAuthFingerprint;
  headers: HeadersFingerprint;
  betas: BetasFingerprint;
  billing: BillingFingerprint;
}

export type DiffSeverity = "HIGH" | "MEDIUM" | "LOW";

export interface DiffChange {
  path: string;
  type: "changed" | "added" | "removed" | "type_changed";
  severity: DiffSeverity;
  old?: unknown;
  new?: unknown;
  values?: unknown[];
}

export interface FingerprintDiff {
  oldVersion: string;
  newVersion: string;
  changes: DiffChange[];
  summary: {
    total: number;
    high: number;
    medium: number;
    low: number;
  };
}
