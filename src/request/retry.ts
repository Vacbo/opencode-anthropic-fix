import { parseRetryAfterHeader, parseRetryAfterMsHeader, parseShouldRetryHeader } from "../backoff.js";

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterFraction: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 8000,
  jitterFraction: 0.25,
};

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function calculateRetryDelay(attempt: number, config: RetryConfig): number {
  const delay = Math.min(config.initialDelayMs * Math.pow(2, attempt), config.maxDelayMs);
  const jitter = 1 - Math.random() * config.jitterFraction;
  return Math.round(delay * jitter);
}

export function shouldRetryStatus(status: number, shouldRetryHeader: boolean | null): boolean {
  if (shouldRetryHeader === true) return true;
  if (shouldRetryHeader === false) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  config: Partial<RetryConfig> = {},
): Promise<Response> {
  const resolvedConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

  for (let attempt = 0; ; attempt++) {
    const response = await doFetch();

    if (response.ok) {
      return response;
    }

    const shouldRetryHeader = parseShouldRetryHeader(response);
    const shouldRetry = shouldRetryStatus(response.status, shouldRetryHeader);

    if (!shouldRetry || attempt >= resolvedConfig.maxRetries) {
      return response;
    }

    const delayMs =
      parseRetryAfterMsHeader(response) ??
      parseRetryAfterHeader(response) ??
      calculateRetryDelay(attempt, resolvedConfig);

    await waitFor(delayMs);
  }
}
