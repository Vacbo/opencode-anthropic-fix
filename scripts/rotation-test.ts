#!/usr/bin/env bun

import fs from "node:fs/promises";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ACCOUNTS_FILE = path.join(os.tmpdir(), "rotation-test.json");
const EXPIRED_TOKEN_OFFSET_MS = 60_000;
const OAUTH_ITERATIONS_PER_ACCOUNT = 10;

interface AccountStats {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    lastReset: number;
}

interface StoredAccountIdentity {
    kind: "oauth";
    email: string;
}

interface StoredAccount {
    id: string;
    email: string;
    identity: StoredAccountIdentity;
    refreshToken: string;
    access: string;
    expires: number;
    token_updated_at: number;
    addedAt: number;
    lastUsed: number;
    enabled: boolean;
    rateLimitResetTimes: Record<string, number>;
    consecutiveFailures: number;
    lastFailureTime: number | null;
    stats: AccountStats;
    source: "oauth";
}

interface StorageShape {
    version: number;
    activeIndex: number;
    accounts: StoredAccount[];
}

interface StoredAccountInput {
    id: string;
    email: string;
    refreshToken: string;
    accessToken: string;
    now: number;
}

interface OAuthAuthorizeResult {
    url: string;
    callback: (value: string) => Promise<{ type: string } | undefined>;
}

interface PluginAuthMethod {
    authorize?: () => Promise<OAuthAuthorizeResult>;
}

interface PluginInstance {
    auth?: {
        methods?: PluginAuthMethod[];
    };
    dispose?: () => Promise<void> | void;
}

interface PluginClient {
    auth: {
        set: () => Promise<void>;
    };
    session: {
        prompt: () => Promise<void>;
    };
    tui: {
        showToast: () => Promise<void>;
    };
}

interface TokenServerHandle {
    rotationCounters: Map<string, number>;
    start: () => Promise<number>;
    stop: () => Promise<void>;
}

interface FetchPreconnectOptions {
    dns?: boolean;
    tcp?: boolean;
    http?: boolean;
    https?: boolean;
}

interface FetchType {
    (input: string | URL | Request, init?: RequestInit): Promise<Response>;
    preconnect: (url: string | URL, options?: FetchPreconnectOptions) => void;
}

function createStats(now: number): AccountStats {
    return {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        lastReset: now,
    };
}

function createStoredAccount({ id, email, refreshToken, accessToken, now }: StoredAccountInput): StoredAccount {
    return {
        id,
        email,
        identity: {
            kind: "oauth",
            email,
        },
        refreshToken,
        access: accessToken,
        expires: now - EXPIRED_TOKEN_OFFSET_MS,
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

async function ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath: string): Promise<StorageShape> {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as StorageShape;
}

async function writeJson(filePath: string, value: StorageShape | Record<string, unknown>): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function createTokenServer(): TokenServerHandle {
    const refreshTokenToEmail = new Map<string, string>([
        ["refresh-a-0", "a@test.local"],
        ["refresh-b-0", "b@test.local"],
    ]);
    const rotationCounters = new Map<string, number>();

    const server: Server = http.createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/oauth/token") {
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "not_found" }));
            return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            grant_type?: string;
            code?: string;
            refresh_token?: string;
        };

        let email = "";

        if (payload.grant_type === "authorization_code") {
            email = typeof payload.code === "string" ? payload.code : "";
        } else if (payload.grant_type === "refresh_token") {
            email = typeof payload.refresh_token === "string" ? (refreshTokenToEmail.get(payload.refresh_token) ?? "") : "";
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
        async start(): Promise<number> {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => resolve());
            });
            const address = server.address();
            if (!address || typeof address === "string") {
                throw new Error("Failed to resolve token server port.");
            }
            return address.port;
        },
        async stop(): Promise<void> {
            await new Promise<void>((resolve, reject) => {
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

function createClient(): PluginClient {
    return {
        auth: {
            set: async (): Promise<void> => undefined,
        },
        session: {
            prompt: async (): Promise<void> => undefined,
        },
        tui: {
            showToast: async (): Promise<void> => undefined,
        },
    };
}

async function loadPluginFactory(): Promise<(options: { client: PluginClient }) => Promise<PluginInstance>> {
    const moduleUrl = pathToFileURL(path.join(process.cwd(), "dist", "opencode-anthropic-auth-plugin.mjs")).href;
    const pluginModule = (await import(moduleUrl)) as {
        AnthropicAuthPlugin?: (options: { client: PluginClient }) => Promise<PluginInstance>;
    };

    if (typeof pluginModule.AnthropicAuthPlugin !== "function") {
        throw new Error("AnthropicAuthPlugin export is unavailable in the built plugin.");
    }

    return pluginModule.AnthropicAuthPlugin;
}

async function run(): Promise<void> {
    const requestedAccountsFile = process.env.ANTHROPIC_ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE;
    const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-rotation-"));
    const opencodeConfigDir = path.join(configHome, "opencode");
    const storagePath = path.join(opencodeConfigDir, "anthropic-accounts.json");
    const configPath = path.join(opencodeConfigDir, "anthropic-auth.json");
    const tokenServer = createTokenServer();
    const originalFetch = globalThis.fetch as FetchType;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const originalInitialAccount = process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT;

    process.env.XDG_CONFIG_HOME = configHome;

    const now = Date.now();
    const initialStorage: StorageShape = {
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

    const interceptedFetchImpl = async (
        input: Parameters<FetchType>[0],
        init?: Parameters<FetchType>[1],
    ) => {
        const url = typeof input === "string" || input instanceof URL ? new URL(input.toString()) : new URL(input.url);

        if (url.hostname === "platform.claude.com" && url.pathname === "/v1/oauth/token") {
            return originalFetch(`http://127.0.0.1:${tokenPort}/v1/oauth/token`, init);
        }

        throw new Error(`Unexpected network request: ${url.toString()}`);
    };

    const interceptedFetch: FetchType = Object.assign(interceptedFetchImpl, {
        preconnect: originalFetch.preconnect,
    });

    globalThis.fetch = interceptedFetch;

    const createPlugin = await loadPluginFactory();

    try {
        const expectedEmails = ["a@test.local", "b@test.local"] as const;
        for (const [index, email] of expectedEmails.entries()) {
            process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT = String(index + 1);

            for (let iteration = 0; iteration < OAUTH_ITERATIONS_PER_ACCOUNT; iteration += 1) {
                const plugin = await createPlugin({ client: createClient() });
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

run().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
});
