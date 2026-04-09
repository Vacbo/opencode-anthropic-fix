import { randomUUID } from "node:crypto";
import { buildAnthropicBetaHeader } from "../betas.js";
import { isFalsyEnv, isTruthyEnv } from "../env.js";
import type { SignatureConfig } from "../types.js";
import { buildStainlessHelperHeader, getStainlessArch, getStainlessOs } from "./stainless.js";
import { buildUserAgent } from "./user-agent.js";

function parseAnthropicCustomHeaders(): Record<string, string> {
  const raw = process.env.ANTHROPIC_CUSTOM_HEADERS;
  if (!raw) return {};

  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (!key || !value) continue;
    headers[key] = value;
  }

  return headers;
}

function detectProvider(requestUrl: URL | null) {
  if (!requestUrl) return "anthropic" as const;
  const host = requestUrl.hostname.toLowerCase();
  if (host.includes("bedrock") || host.includes("amazonaws.com")) return "bedrock" as const;
  if (host.includes("aiplatform") || host.includes("vertex")) return "vertex" as const;
  if (host.includes("foundry") || host.includes("azure")) return "foundry" as const;
  return "anthropic" as const;
}

function parseRequestBodyMetadata(body: string | undefined): {
  model: string;
  tools: unknown[];
  messages: unknown[];
  hasFileReferences: boolean;
} {
  if (!body || typeof body !== "string") {
    return { model: "", tools: [], messages: [], hasFileReferences: false };
  }

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const model = typeof parsed?.model === "string" ? parsed.model : "";
    const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    // hasFileReferences: check if any message content references files
    const hasFileReferences = hasFileIds(parsed);
    return { model, tools, messages, hasFileReferences };
  } catch {
    return { model: "", tools: [], messages: [], hasFileReferences: false };
  }
}

function hasFileIds(parsed: Record<string, unknown>): boolean {
  const str = JSON.stringify(parsed);
  return /file[-_][a-zA-Z0-9]{2,}/.test(str);
}

export function buildRequestHeaders(
  input: Request | string | URL,
  requestInit: Record<string, unknown>,
  accessToken: string,
  requestBody: string | undefined,
  requestUrl: URL | null,
  signature: SignatureConfig,
): Headers {
  const requestHeaders = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
  }
  const initHeaders = requestInit.headers;
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders as [string, string | undefined][]) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders as Record<string, unknown>)) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    }
  }

  // Preserve all incoming beta headers while ensuring OAuth requirements
  const incomingBeta = requestHeaders.get("anthropic-beta") || "";
  const { model, tools, messages, hasFileReferences } = parseRequestBodyMetadata(requestBody);
  const provider = detectProvider(requestUrl);
  const mergedBetas = buildAnthropicBetaHeader(
    incomingBeta,
    signature.enabled,
    model,
    provider,
    signature.customBetas,
    signature.strategy,
    requestUrl?.pathname,
    hasFileReferences,
  );

  const authTokenOverride = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  const bearerToken = authTokenOverride || accessToken;

  requestHeaders.set("authorization", `Bearer ${bearerToken}`);
  requestHeaders.set("anthropic-beta", mergedBetas);
  requestHeaders.set("user-agent", buildUserAgent(signature.claudeCliVersion));
  if (signature.enabled) {
    requestHeaders.set("anthropic-version", "2023-06-01");
    requestHeaders.set("anthropic-dangerous-direct-browser-access", "true");
    requestHeaders.set("x-app", "cli");
    requestHeaders.set("x-stainless-arch", getStainlessArch(process.arch));
    requestHeaders.set("x-stainless-lang", "js");
    requestHeaders.set("x-stainless-os", getStainlessOs(process.platform));
    // CC's Stainless SDK reports its own package version (0.81.0), not the CLI version
    requestHeaders.set("x-stainless-package-version", "0.81.0");
    requestHeaders.set("x-stainless-runtime", "node");
    requestHeaders.set("x-stainless-runtime-version", process.version);
    // CC's SDK default timeout is 600s (600000ms)
    requestHeaders.set("x-stainless-timeout", "600");
    const incomingRetryCount = requestHeaders.get("x-stainless-retry-count");
    requestHeaders.set(
      "x-stainless-retry-count",
      incomingRetryCount && !isFalsyEnv(incomingRetryCount) ? incomingRetryCount : "0",
    );
    const stainlessHelpers = buildStainlessHelperHeader(tools, messages);
    if (stainlessHelpers) {
      requestHeaders.set("x-stainless-helper", stainlessHelpers);
    }

    for (const [key, value] of Object.entries(parseAnthropicCustomHeaders())) {
      requestHeaders.set(key, value);
    }
    if (process.env.CLAUDE_CODE_CONTAINER_ID) {
      requestHeaders.set("x-claude-remote-container-id", process.env.CLAUDE_CODE_CONTAINER_ID);
    }
    if (process.env.CLAUDE_CODE_REMOTE_SESSION_ID) {
      requestHeaders.set("x-claude-remote-session-id", process.env.CLAUDE_CODE_REMOTE_SESSION_ID);
    }
    if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) {
      requestHeaders.set("x-client-app", process.env.CLAUDE_AGENT_SDK_CLIENT_APP);
    }
    if (isTruthyEnv(process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION)) {
      requestHeaders.set("x-anthropic-additional-protection", "true");
    }
    // CC 2.1.98 sends a per-request UUID
    requestHeaders.set("x-client-request-id", randomUUID());
  }
  requestHeaders.delete("x-api-key");

  return requestHeaders;
}
