import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calculateRetryDelay, fetchWithRetry, shouldRetryStatus } from "./retry.js";

function makeResponse(status: number, headers?: HeadersInit): Response {
  return new Response(null, {
    status,
    headers,
  });
}

const FAST_RETRY_CONFIG = {
  initialDelayMs: 1,
  maxDelayMs: 8,
  jitterFraction: 0,
};

describe("shouldRetryStatus", () => {
  it("honors x-should-retry overrides before status logic", () => {
    expect(shouldRetryStatus(400, true)).toBe(true);
    expect(shouldRetryStatus(503, false)).toBe(false);
  });

  it("retries only the supported fallback statuses", () => {
    expect(shouldRetryStatus(408, null)).toBe(true);
    expect(shouldRetryStatus(409, null)).toBe(true);
    expect(shouldRetryStatus(429, null)).toBe(true);
    expect(shouldRetryStatus(529, null)).toBe(true);
    expect(shouldRetryStatus(400, null)).toBe(false);
  });
});

describe("calculateRetryDelay", () => {
  it("matches the Stainless exponential backoff formula with jitter and max cap", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(
      calculateRetryDelay(0, {
        maxRetries: 2,
        initialDelayMs: 500,
        maxDelayMs: 8000,
        jitterFraction: 0.25,
      }),
    ).toBe(438);

    expect(
      calculateRetryDelay(3, {
        maxRetries: 2,
        initialDelayMs: 500,
        maxDelayMs: 8000,
        jitterFraction: 0.25,
      }),
    ).toBe(3500);

    expect(
      calculateRetryDelay(5, {
        maxRetries: 2,
        initialDelayMs: 500,
        maxDelayMs: 8000,
        jitterFraction: 0.25,
      }),
    ).toBe(7000);
  });
});

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries a 529 once and returns the next success", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(makeResponse(529))
      .mockResolvedValueOnce(makeResponse(200));

    const response = await fetchWithRetry(doFetch, FAST_RETRY_CONFIG);

    expect(response.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("retries twice before succeeding on the third attempt", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(makeResponse(529))
      .mockResolvedValueOnce(makeResponse(529))
      .mockResolvedValueOnce(makeResponse(200));

    const response = await fetchWithRetry(doFetch, FAST_RETRY_CONFIG);

    expect(response.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it("returns the last failure after exhausting the retry budget", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(makeResponse(529))
      .mockResolvedValueOnce(makeResponse(529))
      .mockResolvedValueOnce(makeResponse(529));

    const response = await fetchWithRetry(doFetch, FAST_RETRY_CONFIG);

    expect(response.status).toBe(529);
    expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry when x-should-retry is false", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(makeResponse(503, { "x-should-retry": "false" }));

    const response = await fetchWithRetry(doFetch);

    expect(response.status).toBe(503);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("prefers retry-after-ms over calculated backoff", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(makeResponse(503, { "retry-after-ms": "2000" }))
      .mockResolvedValueOnce(makeResponse(200));

    const startedAt = Date.now();
    const response = await fetchWithRetry(doFetch);
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(1900);
  });

  it("falls back to retry-after when retry-after-ms is absent", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(makeResponse(503, { "retry-after": "3" }))
      .mockResolvedValueOnce(makeResponse(200));

    const startedAt = Date.now();
    const response = await fetchWithRetry(doFetch);
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(2900);
  });

  it("retries thrown retryable network errors and marks the next attempt as fresh-connection", async () => {
    const forceFreshConnectionByAttempt: boolean[] = [];
    const doFetch = vi.fn(async ({ forceFreshConnection = false }: { forceFreshConnection?: boolean } = {}) => {
      forceFreshConnectionByAttempt.push(forceFreshConnection);
      if (forceFreshConnectionByAttempt.length === 1) {
        throw Object.assign(new Error("Connection reset by server"), { code: "ECONNRESET" });
      }

      return makeResponse(200);
    });

    const response = await fetchWithRetry(doFetch, FAST_RETRY_CONFIG);

    expect(response.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(forceFreshConnectionByAttempt).toEqual([false, true]);
  });

  it("does not retry user abort errors", async () => {
    const doFetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });

    await expect(fetchWithRetry(doFetch, FAST_RETRY_CONFIG)).rejects.toThrow(/aborted/i);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
});
