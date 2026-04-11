#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ACCOUNTS_FILE = path.join(os.tmpdir(), "rotation-test.json");

function createStats(now) {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastReset: now,
  };
}

function createStoredAccount({ id, email, refreshToken, accessToken, now }) {
  return {
    id,
    email,
    identity: {
      kind: "oauth",
      email,
    },
    refreshToken,
    access: accessToken,
    expires: now - 60_000,
    token_updated_at: now,
    addedAt: now,
    lastUsed: 0,
    enabled: true,
    rateLimitResetTimes: {},
    consecutiveFailures: 0,
    lastFailureTime: null,
    stats: createStats(now),
    source: "oauth",
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function createTokenServer() {
  const refreshTokenToEmail = new Map([
    ["refresh-a-0", "a@test.local"],
    ["refresh-b-0", "b@test.local"],
  ]);
  const rotationCounters = new Map();

  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/oauth/token") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let email;

    if (payload.grant_type === "authorization_code") {
      email = typeof payload.code === "string" ? payload.code : "";
    } else if (payload.grant_type === "refresh_token") {
      email = refreshTokenToEmail.get(payload.refresh_token) ?? "";
    } else {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }

    if (!email) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unknown_account" }));
      return;
    }

    const nextCount = (rotationCounters.get(email) ?? 0) + 1;
    rotationCounters.set(email, nextCount);

    const safeEmail = email.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const refreshToken = `refresh-${safeEmail}-${nextCount}`;
    const accessToken = `access-${safeEmail}-${nextCount}`;

    refreshTokenToEmail.set(refreshToken, email);

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: 0,
        account: {
          email_address: email,
        },
      }),
    );
  });

  return {
    rotationCounters,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve token server port.");
      }
      return address.port;
    },
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function createClient() {
  return {
    auth: {
      set: async () => undefined,
    },
    session: {
      prompt: async () => undefined,
    },
    tui: {
      showToast: async () => undefined,
    },
  };
}

async function run() {
  const requestedAccountsFile = process.env.ANTHROPIC_ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE;
  const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-rotation-"));
  const opencodeConfigDir = path.join(configHome, "opencode");
  const storagePath = path.join(opencodeConfigDir, "anthropic-accounts.json");
  const configPath = path.join(opencodeConfigDir, "anthropic-auth.json");
  const tokenServer = createTokenServer();
  const originalFetch = globalThis.fetch;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalInitialAccount = process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT;

  process.env.XDG_CONFIG_HOME = configHome;

  const now = Date.now();
  const initialStorage = {
    version: 1,
    activeIndex: 0,
    accounts: [
      createStoredAccount({
        id: "oauth-a",
        email: "a@test.local",
        refreshToken: "refresh-a-0",
        accessToken: "access-a-0",
        now,
      }),
      createStoredAccount({
        id: "oauth-b",
        email: "b@test.local",
        refreshToken: "refresh-b-0",
        accessToken: "access-b-0",
        now,
      }),
    ],
  };

  await writeJson(storagePath, initialStorage);
  await writeJson(requestedAccountsFile, initialStorage);
  await writeJson(configPath, {
    signature_emulation: {
      fetch_claude_code_version_on_startup: false,
    },
    idle_refresh: {
      enabled: false,
    },
    cc_credential_reuse: {
      enabled: false,
      auto_detect: false,
      prefer_over_oauth: false,
    },
  });

  const tokenPort = await tokenServer.start();

  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === "string" || input instanceof URL ? new URL(input.toString()) : new URL(input.url);

    if (url.hostname === "platform.claude.com" && url.pathname === "/v1/oauth/token") {
      return originalFetch(`http://127.0.0.1:${tokenPort}/v1/oauth/token`, init);
    }

    throw new Error(`Unexpected network request: ${url.toString()}`);
  };

  const { AnthropicAuthPlugin } = await import(
    pathToFileURL(path.join(process.cwd(), "dist", "opencode-anthropic-auth-plugin.js")).href
  );

  try {
    for (const [index, email] of ["a@test.local", "b@test.local"].entries()) {
      process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT = String(index + 1);

      for (let iteration = 0; iteration < 10; iteration += 1) {
        const plugin = await AnthropicAuthPlugin({ client: createClient() });
        const method = plugin.auth?.methods?.[1];
        if (!method || typeof method.authorize !== "function") {
          throw new Error("OAuth auth method is unavailable in the built plugin.");
        }

        const authResult = await method.authorize();
        if (typeof authResult.callback !== "function") {
          throw new Error("OAuth callback is unavailable.");
        }

        const state = new URL(authResult.url).searchParams.get("state");
        if (!state) {
          throw new Error("OAuth state was missing from the authorize URL.");
        }

        const result = await authResult.callback(`${email}#${state}`);
        if (!result || result.type !== "success") {
          throw new Error(`OAuth callback failed for ${email}.`);
        }

        await plugin.dispose?.();
      }
    }

    const finalStorage = await readJson(storagePath);
    await writeJson(requestedAccountsFile, finalStorage);
    const accountCount = Array.isArray(finalStorage.accounts) ? finalStorage.accounts.length : 0;

    console.log(`ACCOUNT_COUNT=${accountCount}`);
    process.exitCode = accountCount === 2 ? 0 : 1;
  } finally {
    globalThis.fetch = originalFetch;

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    if (originalInitialAccount === undefined) {
      delete process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT;
    } else {
      process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT = originalInitialAccount;
    }

    await tokenServer.stop();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
