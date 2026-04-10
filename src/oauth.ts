import { createHash, randomBytes } from "node:crypto";
import { CLIENT_ID } from "./config.js";

// ---------------------------------------------------------------------------
// OAuth helpers — shared between plugin (index.ts) and CLI (cli.ts)
// ---------------------------------------------------------------------------

const OAUTH_CONSOLE_HOST = "platform.claude.com";
const OAUTH_MAX_HOST = "claude.ai";
const OAUTH_REDIRECT_URI = `https://${OAUTH_CONSOLE_HOST}/oauth/code/callback`;
const OAUTH_TOKEN_URL = `https://${OAUTH_CONSOLE_HOST}/v1/oauth/token`;
const OAUTH_REVOKE_URL = `https://${OAUTH_CONSOLE_HOST}/v1/oauth/revoke`;
// CC uses default Axios (v1.13.6) for token operations — Axios auto-sets this UA.
// The plugin uses native fetch (no default UA), so we must set it explicitly to match.
const OAUTH_TOKEN_USER_AGENT = "axios/1.13.6";

const OAUTH_SCOPES_API_KEY = ["org:create_api_key", "user:profile"];
const OAUTH_SCOPES_AUTH = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const OAUTH_ALL_SCOPES = [...new Set([...OAUTH_SCOPES_API_KEY, ...OAUTH_SCOPES_AUTH])];

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export interface AuthorizeOptions {
  orgUUID?: string;
  loginHint?: string;
  loginMethod?: string;
}

/**
 * Build an OAuth authorization URL with PKCE challenge.
 */
export async function authorize(
  mode: "max" | "console",
  options: AuthorizeOptions = {},
): Promise<{ url: string; verifier: string; state: string }> {
  const pkce = generatePKCE();
  // Use a separate random value for state (not the verifier) to avoid
  // leaking the PKCE verifier in browser history / referrer headers.
  const state = base64url(randomBytes(32));

  const url = new URL(`https://${mode === "console" ? OAUTH_CONSOLE_HOST : OAUTH_MAX_HOST}/oauth/authorize`);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", OAUTH_ALL_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (options.orgUUID) url.searchParams.set("orgUUID", options.orgUUID);
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  if (options.loginMethod) url.searchParams.set("login_method", options.loginMethod);
  return {
    url: url.toString(),
    verifier: pkce.verifier,
    state,
  };
}

export type ExchangeResult =
  | {
      type: "success";
      refresh: string;
      access: string;
      expires: number;
      email?: string;
    }
  | {
      type: "failed";
      status?: number;
      code?: string;
      reason?: string;
      details?: string;
    };

/**
 * Exchange an authorization code for tokens.
 */
export async function exchange(code: string, verifier: string): Promise<ExchangeResult> {
  const fail = (status: number | undefined, rawText = ""): ExchangeResult => {
    let errorCode: string | undefined;
    let reason: string | undefined;

    if (rawText) {
      try {
        const parsed = JSON.parse(rawText);
        if (typeof parsed.error === "string" && parsed.error) {
          errorCode = parsed.error;
        }
        if (typeof parsed.error_description === "string" && parsed.error_description) {
          reason = parsed.error_description;
        } else if (typeof parsed.message === "string" && parsed.message) {
          reason = parsed.message;
        }
      } catch {
        // Body is not JSON — use raw text as the reason, trimmed to strip whitespace
        reason = rawText.trim() || undefined;
      }
    }

    const detailsParts: string[] = [];
    if (typeof status === "number") detailsParts.push(`HTTP ${status}`);
    if (errorCode) detailsParts.push(errorCode);
    if (reason) detailsParts.push(reason);

    return {
      type: "failed",
      ...(typeof status === "number" ? { status } : {}),
      ...(errorCode ? { code: errorCode } : {}),
      ...(reason ? { reason } : {}),
      ...(detailsParts.length ? { details: detailsParts.join(" · ") } : {}),
    };
  };

  const splits = code.split("#");
  let result: Response;
  try {
    result = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": OAUTH_TOKEN_USER_AGENT,
      },
      body: JSON.stringify({
        code: splits[0],
        state: splits[1],
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return fail(undefined, err instanceof Error ? err.message : String(err));
  }

  if (!result.ok) {
    const raw =
      typeof result.text === "function"
        ? await result
            .text()
            .then((value) => (typeof value === "string" ? value : ""))
            // Body may be unreadable on 5xx responses; empty string is the correct fallback
            // because we've already captured the HTTP status for the caller.
            .catch(() => "")
        : "";
    return fail(result.status, raw);
  }

  const json = (await result.json()) as {
    refresh_token: string;
    access_token: string;
    expires_in: number;
    account?: { email_address?: string };
  };
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
    email: json.account?.email_address || undefined,
  };
}

/**
 * Attempt to revoke a refresh token server-side (best-effort, RFC 7009).
 *
 * Anthropic may or may not support this endpoint. The function returns
 * `true` on a 2xx response and `false` otherwise — callers should always
 * proceed with local cleanup regardless of the result.
 */
export async function revoke(refreshToken: string): Promise<boolean> {
  try {
    const resp = await fetch(OAUTH_REVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": OAUTH_TOKEN_USER_AGENT,
      },
      body: JSON.stringify({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    // Best-effort revocation — network errors, DNS failures, or endpoint unavailability
    // are all expected; callers proceed with local cleanup regardless.
    return false;
  }
}

export interface TokenRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface RefreshError extends Error {
  status?: number;
  code?: string;
}

/**
 * Refresh an OAuth access token.
 * @throws On HTTP errors or network failures
 */
export async function refreshToken(
  refreshTokenValue: string,
  options: { signal?: AbortSignal } = {},
): Promise<TokenRefreshResponse> {
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": OAUTH_TOKEN_USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshTokenValue,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!resp.ok) {
    // Empty string is the correct fallback — we already have resp.status for the error message.
    const text = await resp.text().catch(() => "");
    const error: RefreshError = new Error(`Token refresh failed (HTTP ${resp.status}): ${text}`);
    error.status = resp.status;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) error.code = parsed.error;
    } catch {
      // Body may not be valid JSON — leave error.code unset, the HTTP status is still attached
    }
    throw error;
  }

  return resp.json() as Promise<TokenRefreshResponse>;
}
