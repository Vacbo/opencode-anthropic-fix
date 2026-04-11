export type RateLimitReason = "AUTH_FAILED" | "QUOTA_EXHAUSTED" | "RATE_LIMIT_EXCEEDED";

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000];
const AUTH_FAILED_BACKOFF = 5_000;
const RATE_LIMIT_EXCEEDED_BACKOFF = 30_000;
const MIN_BACKOFF_MS = 2_000;
const RETRIABLE_NETWORK_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET"]);
const NON_RETRIABLE_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "APIUserAbortError"]);
const RETRIABLE_NETWORK_ERROR_MESSAGES = [
  "bun proxy upstream error",
  "connection reset by peer",
  "connection reset by server",
  "econnreset",
  "econnrefused",
  "epipe",
  "etimedout",
  "fetch failed",
  "network connection lost",
  "socket hang up",
  "und_err_socket",
];

interface ErrorWithCode extends Error {
  code?: string;
  cause?: unknown;
}

/**
 * Parse the Retry-After header from a response.
 * Supports both seconds (integer) and HTTP-date formats.
 */
export function parseRetryAfterHeader(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;

  // Try as integer (seconds)
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  // Try as HTTP-date
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : null;
  }

  return null;
}

/**
 * Parse the retry-after-ms header from a response (Stainless SDK pattern).
 * Returns the value in milliseconds, rounded to nearest integer.
 */
export function parseRetryAfterMsHeader(response: Response): number | null {
  const header = response.headers.get("retry-after-ms");
  if (!header) return null;

  const ms = parseFloat(header);
  return !isNaN(ms) && ms > 0 ? Math.round(ms) : null;
}

/**
 * Parse the x-should-retry header from a response (Stainless SDK pattern).
 * Returns true for "true", false for "false", null for absent or unrecognized.
 */
export function parseShouldRetryHeader(response: Response): boolean | null {
  const header = response.headers.get("x-should-retry");
  if (header === "true") return true;
  if (header === "false") return false;
  return null; // not present or unrecognized
}

interface ErrorSignals {
  errorType: string;
  message: string;
  text: string;
}

function extractErrorSignals(body: string | object | null | undefined): ErrorSignals {
  let errorType = "";
  let message = "";
  let text = "";

  if (body == null) {
    return { errorType, message, text };
  }

  if (typeof body === "string") {
    text = body.toLowerCase();
    try {
      const parsed = JSON.parse(body);
      errorType = String(parsed?.error?.type || "").toLowerCase();
      message = String(parsed?.error?.message || "").toLowerCase();
    } catch {
      // Not JSON — use raw text only.
    }
    return { errorType, message, text };
  }

  if (typeof body === "object") {
    const b = body as Record<string, unknown>;
    const err = b.error as Record<string, unknown> | undefined;
    errorType = String(err?.type || "").toLowerCase();
    message = String(err?.message || "").toLowerCase();
    try {
      text = JSON.stringify(body).toLowerCase();
    } catch {
      text = "";
    }
  }

  return { errorType, message, text };
}

function bodyHasAccountError(body: string | object | null | undefined): boolean {
  const { errorType, message, text } = extractErrorSignals(body);

  const typeSignals = [
    "rate_limit",
    "quota",
    "billing",
    "permission",
    "authentication",
    "invalid_api_key",
    "insufficient_permissions",
    "invalid_grant",
  ];

  const messageSignals = [
    "rate limit",
    "would exceed",
    "quota",
    "exhausted",
    "credit balance",
    "billing",
    "permission",
    "forbidden",
    "unauthorized",
    "authentication",
    "not authorized",
    // Anthropic returns "We're unable to verify your membership benefits" on 403 when access token is stale
    "membership",
    "unable to verify",
  ];

  return (
    typeSignals.some((signal) => errorType.includes(signal)) ||
    messageSignals.some((signal) => message.includes(signal)) ||
    messageSignals.some((signal) => text.includes(signal))
  );
}

function collectErrorChain(error: unknown): ErrorWithCode[] {
  const queue: unknown[] = [error];
  const visited = new Set<unknown>();
  const chain: ErrorWithCode[] = [];

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (candidate == null || visited.has(candidate)) {
      continue;
    }

    visited.add(candidate);

    if (candidate instanceof Error) {
      const typedCandidate = candidate as ErrorWithCode;
      chain.push(typedCandidate);
      if (typedCandidate.cause !== undefined) {
        queue.push(typedCandidate.cause);
      }
      continue;
    }

    if (typeof candidate === "object" && "cause" in candidate) {
      queue.push((candidate as { cause?: unknown }).cause);
    }
  }

  return chain;
}

/**
 * Check whether an error represents a transient transport/network failure.
 */
export function isRetriableNetworkError(error: unknown): boolean {
  if (typeof error === "string") {
    const text = error.toLowerCase();
    return RETRIABLE_NETWORK_ERROR_MESSAGES.some((signal) => text.includes(signal));
  }

  const chain = collectErrorChain(error);
  if (chain.length === 0) {
    return false;
  }

  for (const candidate of chain) {
    if (NON_RETRIABLE_ERROR_NAMES.has(candidate.name)) {
      return false;
    }

    const code = candidate.code?.toUpperCase();
    if (code && RETRIABLE_NETWORK_ERROR_CODES.has(code)) {
      return true;
    }

    const message = candidate.message.toLowerCase();
    if (RETRIABLE_NETWORK_ERROR_MESSAGES.some((signal) => message.includes(signal))) {
      return true;
    }
  }

  return false;
}

/**
 * Check whether an HTTP response represents an account-specific error
 * that would benefit from switching to a different account.
 */
export function isAccountSpecificError(status: number, body?: string | object | null): boolean {
  // 429 is always account-specific (per-account rate limits)
  if (status === 429) return true;

  // 401 is always account-specific (per-account auth)
  if (status === 401) return true;

  // 400/403 are account-specific only if the body contains relevant language
  if ((status === 400 || status === 403) && body) {
    return bodyHasAccountError(body);
  }

  // Everything else (529, 503, 500, etc.) is service-wide
  return false;
}

/**
 * Parse the rate limit reason from an HTTP status and response body.
 */
export function parseRateLimitReason(status: number, body?: string | object | null): RateLimitReason {
  const { errorType, message, text } = extractErrorSignals(body);

  const authSignals = [
    "authentication",
    "invalid_api_key",
    "invalid api key",
    "invalid_grant",
    "unauthorized",
    "invalid access token",
    "expired token",
    "membership",
  ];

  const isAuthFailure =
    status === 401 ||
    authSignals.some((signal) => errorType.includes(signal)) ||
    authSignals.some((signal) => message.includes(signal)) ||
    authSignals.some((signal) => text.includes(signal));

  if (isAuthFailure) {
    return "AUTH_FAILED";
  }

  if (
    errorType.includes("quota") ||
    errorType.includes("billing") ||
    errorType.includes("permission") ||
    errorType.includes("insufficient_permissions") ||
    message.includes("quota") ||
    message.includes("exhausted") ||
    message.includes("credit balance") ||
    message.includes("billing") ||
    message.includes("permission") ||
    message.includes("forbidden") ||
    text.includes("permission")
  ) {
    return "QUOTA_EXHAUSTED";
  }

  return "RATE_LIMIT_EXCEEDED";
}

/**
 * Calculate backoff duration in milliseconds.
 */
export function calculateBackoffMs(
  reason: RateLimitReason,
  consecutiveFailures: number,
  retryAfterMs?: number | null,
): number {
  // Retry-After header takes precedence
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.max(retryAfterMs, MIN_BACKOFF_MS);
  }

  switch (reason) {
    case "AUTH_FAILED":
      return AUTH_FAILED_BACKOFF;
    case "QUOTA_EXHAUSTED": {
      const index = Math.min(consecutiveFailures, QUOTA_EXHAUSTED_BACKOFFS.length - 1);
      return QUOTA_EXHAUSTED_BACKOFFS[index]!;
    }
    case "RATE_LIMIT_EXCEEDED":
    default:
      return RATE_LIMIT_EXCEEDED_BACKOFF;
  }
}
