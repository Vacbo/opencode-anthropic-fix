import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorize, exchange, refreshToken, revoke } from "./oauth.js";

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

describe("oauth headers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    globalThis.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends Claude Code user-agent on token exchange", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "",
    });

    await exchange("code#state", "verifier");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe("axios/1.13.6");
  });

  it("sends Claude Code user-agent on token refresh", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
      }),
    });

    await refreshToken("refresh-token");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe("axios/1.13.6");
  });

  it("sends Claude Code user-agent on token revoke", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await revoke("refresh-token");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe("axios/1.13.6");
  });
});

describe("oauth scopes", () => {
  it("requests all required scopes in authorization URL", async () => {
    const { url } = await authorize("console");
    const parsed = new URL(url);
    const scope = parsed.searchParams.get("scope");

    expect(scope).toContain("org:create_api_key");
    expect(scope).toContain("user:profile");
    expect(scope).toContain("user:inference");
    expect(scope).toContain("user:sessions:claude_code");
    expect(scope).toContain("user:mcp_servers");
    expect(scope).toContain("user:file_upload");
  });

  it("uses console host for console mode", async () => {
    const { url } = await authorize("console");
    expect(url).toContain("platform.claude.com/oauth/authorize");
  });

  it("uses max host for max mode", async () => {
    const { url } = await authorize("max");
    expect(url).toContain("claude.ai/oauth/authorize");
  });
});

describe("oauth authorize options", () => {
  it("includes orgUUID when provided", async () => {
    const { url } = await authorize("console", { orgUUID: "org-123" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("orgUUID")).toBe("org-123");
  });

  it("includes login_hint when provided", async () => {
    const { url } = await authorize("console", {
      loginHint: "user@example.com",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("login_hint")).toBe("user@example.com");
  });

  it("includes login_method when provided", async () => {
    const { url } = await authorize("console", { loginMethod: "google" });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("login_method")).toBe("google");
  });

  it("omits optional params when not provided", async () => {
    const { url } = await authorize("console");
    const parsed = new URL(url);
    expect(parsed.searchParams.has("orgUUID")).toBe(false);
    expect(parsed.searchParams.has("login_hint")).toBe(false);
    expect(parsed.searchParams.has("login_method")).toBe(false);
  });
});

describe("oauth exchange timeout", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    globalThis.fetch = mockFetch as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sets 15s timeout on token exchange", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "",
    });

    await exchange("code#state", "verifier");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBeDefined();
  });
});
