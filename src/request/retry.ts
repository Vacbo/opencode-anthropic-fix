import {
    isRetriableNetworkError,
    parseRetryAfterHeader,
    parseRetryAfterMsHeader,
    parseShouldRetryHeader,
} from "../backoff.js";

export interface RetryConfig {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    jitterFraction: number;
}

export interface RetryAttemptContext {
    attempt: number;
    forceFreshConnection: boolean;
}

export interface RetryOptions extends Partial<RetryConfig> {
    shouldRetryError?: (error: unknown) => boolean;
    shouldRetryResponse?: (response: Response) => boolean;
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
    doFetch: (context: RetryAttemptContext) => Promise<Response>,
    options: RetryOptions = {},
): Promise<Response> {
    const resolvedConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...options };
    const shouldRetryError = options.shouldRetryError ?? isRetriableNetworkError;
    const shouldRetryResponse =
        options.shouldRetryResponse ??
        ((response: Response) => {
            const shouldRetryHeader = parseShouldRetryHeader(response);
            return shouldRetryStatus(response.status, shouldRetryHeader);
        });

    let forceFreshConnection = false;

    for (let attempt = 0; ; attempt++) {
        let response: Response;

        try {
            response = await doFetch({ attempt, forceFreshConnection });
        } catch (error) {
            if (!shouldRetryError(error) || attempt >= resolvedConfig.maxRetries) {
                throw error;
            }

            const delayMs = calculateRetryDelay(attempt, resolvedConfig);
            await waitFor(delayMs);
            forceFreshConnection = true;
            continue;
        }

        // `fetch` is contractually required to return a Response or throw.
        // A nullish return is only possible when a test mock is misconfigured
        // (e.g. `vi.fn()` without an implementation). Turn the resulting
        // "Cannot read properties of undefined (reading 'ok')" into a
        // diagnostic error so the harness points at its own gap instead
        // of a deep crash inside retry logic.
        if (response == null) {
            throw new TypeError(
                "fetchWithRetry: doFetch resolved to undefined. In production, fetch always returns a Response or throws. If you hit this in a test, configure your mockFetch with mockResolvedValue/mockImplementation before the call.",
            );
        }

        if (response.ok) {
            return response;
        }

        if (!shouldRetryResponse(response) || attempt >= resolvedConfig.maxRetries) {
            return response;
        }

        const delayMs =
            parseRetryAfterMsHeader(response) ??
            parseRetryAfterHeader(response) ??
            calculateRetryDelay(attempt, resolvedConfig);

        await waitFor(delayMs);
        forceFreshConnection = false;
    }
}
