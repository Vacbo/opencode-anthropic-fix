export type RateLimitReason = "AUTH_FAILED" | "QUOTA_EXHAUSTED" | "RATE_LIMIT_EXCEEDED";

const QUOTA_EXHAUSTED_BACKOFFS = [60_000, 300_000, 1_800_000, 7_200_000];
const AUTH_FAILED_BACKOFF = 5_000;
const RATE_LIMIT_EXCEEDED_BACKOFF = 30_000;
const MIN_BACKOFF_MS = 2_000;

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
  ];

  return (
    typeSignals.some((signal) => errorType.includes(signal)) ||
    messageSignals.some((signal) => message.includes(signal)) ||
    messageSignals.some((signal) => text.includes(signal))
  );
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
