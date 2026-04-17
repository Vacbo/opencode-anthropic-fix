// ---------------------------------------------------------------------------
// Plugin entry point — slim factory that wires all extracted modules.
// ---------------------------------------------------------------------------

import type { ManagedAccount } from "./accounts.js";
import { AccountManager } from "./accounts.js";
import type { PendingOAuthEntry } from "./commands/oauth-flow.js";
import { promptAccountMenu, promptManageAccounts } from "./commands/prompts.js";
import type { CommandDeps } from "./commands/router.js";
import { ANTHROPIC_COMMAND_HANDLED, handleAnthropicSlashCommand } from "./commands/router.js";
import type { AnthropicAuthConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { FALLBACK_CLAUDE_CLI_VERSION, selectClaudeCodeIdentity } from "./constants.js";
import { getOrCreateSignatureUserId, isTruthyEnv } from "./env.js";
import { fetchLatestClaudeCodeVersion } from "./headers/user-agent.js";
import { hasOneMillionContext, isOpus46Model } from "./models.js";
import { authorize, exchange } from "./oauth.js";
import { readCCCredentials } from "./cc-credentials.js";
import {
    findByIdentity,
    resolveIdentityFromCCCredential,
    resolveIdentityFromOAuthExchange,
} from "./account-identity.js";
import { clearAccounts, loadAccounts } from "./storage.js";
import type { OpenCodeClient } from "./token-refresh.js";
import { createPluginHelpers } from "./plugin-helpers.js";
import { createRefreshHelpers } from "./refresh-helpers.js";
import { createRequestOrchestrationHelpers } from "./request-orchestration-helpers.js";
import { createSessionScopeTracker } from "./session-scope.js";
import { forwardAnthropicRequest } from "./transport/forward.js";

type OpenCodeCommandDescriptor = {
    template: string;
    description: string;
};

type OpenCodeTransformInput = {
    model?: {
        providerID?: string;
    };
};

type OpenCodeTransformOutput = {
    system: string[];
};

type OpenCodeConfigHookInput = {
    command?: Record<string, OpenCodeCommandDescriptor>;
};

type OpenCodeCommandExecuteBeforeInput = {
    command?: unknown;
    arguments?: unknown;
    sessionID: string;
};

type OpenCodeAuthState = {
    type?: string;
    refresh?: string;
    access?: string;
    expires?: number;
};

type OAuthAuthState = {
    type: "oauth";
    refresh: string;
    access?: string;
    expires?: number;
};

type OpenCodeProviderModel = {
    id: string;
    cost?: {
        input?: number;
        output?: number;
        cache?: {
            read?: number;
            write?: number;
        };
    };
    limit?: {
        context?: number;
        output?: number;
    };
};

type OpenCodeProvider = {
    models: Record<string, OpenCodeProviderModel>;
};

function isOAuthAuthState(auth: OpenCodeAuthState): auth is OAuthAuthState {
    return auth.type === "oauth" && typeof auth.refresh === "string" && auth.refresh.length > 0;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export async function AnthropicAuthPlugin({ client }: { client: OpenCodeClient }) {
    const config: AnthropicAuthConfig = loadConfig();
    const signatureEmulationEnabled = config.signature_emulation.enabled;
    const promptCompactionMode =
        config.signature_emulation.prompt_compaction === "off" ? ("off" as const) : ("minimal" as const);
    const signatureSanitizeSystemPrompt = config.signature_emulation.sanitize_system_prompt === true;
    const shouldFetchClaudeCodeVersion =
        signatureEmulationEnabled && config.signature_emulation.fetch_claude_code_version_on_startup;

    let accountManager: AccountManager | null = null;

    // Track account usage toasts; show once per account change (including first use).
    let lastToastedIndex = -1;

    let initialAccountPinned = false;
    const pendingSlashOAuth = new Map<string, PendingOAuthEntry>();
    const fileAccountMap = new Map<string, number>();

    // -- Helpers ---------------------------------------------------------------

    function debugLog(...args: unknown[]) {
        if (!config.debug) return;
        // eslint-disable-next-line no-console -- this IS the plugin's dedicated debug logger; gated on config.debug
        console.error("[opencode-anthropic-auth]", ...args);
    }

    const { toast, sendCommandMessage, runCliCommand, reloadAccountManagerFromDisk, persistOpenCodeAuth } =
        createPluginHelpers({
            client,
            config,
            debugLog,
            getAccountManager: () => accountManager,
            setAccountManager: (nextAccountManager) => {
                accountManager = nextAccountManager;
            },
        });

    const { parseRefreshFailure, refreshAccountTokenSingleFlight, maybeRefreshIdleAccounts } = createRefreshHelpers({
        client,
        config,
        getAccountManager: () => accountManager,
        debugLog,
    });

    const fetchWithTransport = async (input: string | URL | Request, init: RequestInit): Promise<Response> => {
        const activeFetch = globalThis.fetch as typeof globalThis.fetch & {
            mock?: unknown;
        };
        if (typeof activeFetch === "function" && activeFetch.mock) {
            return activeFetch(input, init);
        }

        try {
            return await forwardAnthropicRequest(input, init);
        } catch (error) {
            if (error instanceof Error && error.message === "forwardAnthropicRequest requires Bun.fetch") {
                debugLog("Bun.fetch unavailable; falling back to native fetch");
                return fetch(input, init);
            }

            throw error;
        }
    };

    // -- Version resolution ----------------------------------------------------

    let claudeCliVersion = FALLBACK_CLAUDE_CLI_VERSION;
    const signatureUserId = getOrCreateSignatureUserId();
    const sessionScopeTracker = createSessionScopeTracker();
    if (shouldFetchClaudeCodeVersion) {
        fetchLatestClaudeCodeVersion()
            .then((version) => {
                if (!version) return;
                claudeCliVersion = version;
                debugLog("resolved claude-code version from npm", version);
            })
            .catch((err) => debugLog("CC version fetch failed:", (err as Error).message));
    }

    const { executeOAuthFetch } = createRequestOrchestrationHelpers({
        config,
        debugLog,
        toast,
        getAccountManager: () => accountManager,
        getClaudeCliVersion: () => claudeCliVersion,
        getInitialAccountPinned: () => initialAccountPinned,
        getLastToastedIndex: () => lastToastedIndex,
        setLastToastedIndex: (index) => {
            lastToastedIndex = index;
        },
        fileAccountMap,
        forwardRequest: fetchWithTransport,
        parseRefreshFailure,
        refreshAccountTokenSingleFlight,
        maybeRefreshIdleAccounts,
        signatureEmulationEnabled,
        promptCompactionMode,
        signatureSanitizeSystemPrompt,
        getSignatureSessionId: () => sessionScopeTracker.getCurrentSignatureSessionId(),
        signatureUserId,
    });

    // -- Command deps ----------------------------------------------------------

    const commandDeps: CommandDeps = {
        sendCommandMessage,
        get accountManager() {
            return accountManager;
        },
        runCliCommand,
        config,
        fileAccountMap,
        get initialAccountPinned() {
            return initialAccountPinned;
        },
        pendingSlashOAuth,
        reloadAccountManagerFromDisk,
        persistOpenCodeAuth,
        refreshAccountTokenSingleFlight,
    };

    // -- Plugin return ---------------------------------------------------------

    return {
        dispose: async () => {
            // No-op: proxy infrastructure removed, native fetch requires no cleanup
        },

        "experimental.chat.system.transform": (input: OpenCodeTransformInput, output: OpenCodeTransformOutput) => {
            sessionScopeTracker.observeHookInput(input);
            const prefix = selectClaudeCodeIdentity({ provider: input.model?.providerID });
            if (!signatureEmulationEnabled && input.model?.providerID === "anthropic") {
                output.system.unshift(prefix);
                if (output.system[1]) output.system[1] = prefix + "\n\n" + output.system[1];
            }
        },

        config: async (input: OpenCodeConfigHookInput) => {
            input.command ??= {};
            input.command["anthropic"] = {
                template: "/anthropic",
                description:
                    "Manage Anthropic auth, config, profiles, and betas (usage, login, config, profile, set, betas, switch)",
            };
        },

        "command.execute.before": async (input: OpenCodeCommandExecuteBeforeInput) => {
            sessionScopeTracker.observeHookInput(input);
            if (input.command !== "anthropic") return;
            try {
                const slashInput = {
                    command: String(input.command),
                    arguments: typeof input.arguments === "string" ? input.arguments : undefined,
                    sessionID: String(input.sessionID),
                };
                await handleAnthropicSlashCommand(slashInput, commandDeps);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                await sendCommandMessage(input.sessionID, `▣ Anthropic (error)\n\n${message}`);
            }
            throw new Error(ANTHROPIC_COMMAND_HANDLED);
        },

        auth: {
            provider: "anthropic",
            async loader(getAuth: () => Promise<OpenCodeAuthState>, provider: OpenCodeProvider) {
                const auth = await getAuth();
                if (isOAuthAuthState(auth)) {
                    // Zero out cost for max plan and optionally override context limits.
                    for (const model of Object.values(provider.models)) {
                        model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
                        if (
                            config.override_model_limits.enabled &&
                            !isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT) &&
                            (hasOneMillionContext(model.id) || isOpus46Model(model.id))
                        ) {
                            model.limit = {
                                ...(model.limit ?? {}),
                                context: config.override_model_limits.context,
                                ...(config.override_model_limits.output > 0
                                    ? { output: config.override_model_limits.output }
                                    : {}),
                            };
                        }
                    }

                    // Initialize AccountManager from disk + OpenCode auth fallback
                    accountManager = await AccountManager.load(config, {
                        refresh: auth.refresh,
                        access: auth.access,
                        expires: auth.expires,
                    });
                    if (accountManager.getAccountCount() > 0) {
                        await accountManager.saveToDisk();
                    }

                    if (config.cc_credential_reuse?.enabled && config.cc_credential_reuse?.auto_detect) {
                        const ccCount = accountManager.getCCAccounts().length;
                        if (ccCount > 0) {
                            await toast(`Using Claude Code credentials (${ccCount} found)`, "success");
                        }
                    }

                    // OPENCODE_ANTHROPIC_INITIAL_ACCOUNT: pin to a specific account
                    const initialAccountEnv = process.env.OPENCODE_ANTHROPIC_INITIAL_ACCOUNT?.trim();
                    if (initialAccountEnv && accountManager.getAccountCount() > 1) {
                        const accounts = accountManager.getEnabledAccounts();
                        let target: ManagedAccount | null = null;
                        const asIndex = parseInt(initialAccountEnv, 10);
                        if (!isNaN(asIndex) && asIndex >= 1 && asIndex <= accounts.length) {
                            target = accounts[asIndex - 1];
                        }
                        if (!target) {
                            target =
                                accounts.find(
                                    (a) => a.email && a.email.toLowerCase() === initialAccountEnv.toLowerCase(),
                                ) ?? null;
                        }
                        if (target && accountManager.forceCurrentIndex(target.index)) {
                            config.account_selection_strategy = "sticky";
                            initialAccountPinned = true;
                            debugLog("OPENCODE_ANTHROPIC_INITIAL_ACCOUNT: pinned to account", {
                                index: target.index + 1,
                                email: target.email,
                                strategy: "sticky (overridden)",
                            });
                        } else {
                            debugLog(
                                "OPENCODE_ANTHROPIC_INITIAL_ACCOUNT: could not resolve account",
                                initialAccountEnv,
                            );
                        }
                    }

                    return {
                        apiKey: "",
                        async fetch(input: string | URL | Request, init?: RequestInit) {
                            const currentAuth = await getAuth();
                            if (currentAuth.type !== "oauth") return fetch(input, init);
                            return executeOAuthFetch(input, init);
                        },
                    };
                }

                return {};
            },

            methods: [
                {
                    label: "Claude Code Credentials (auto-detected)",
                    type: "oauth" as const,
                    authorize: async () => {
                        const ccCredentials = readCCCredentials();

                        if (ccCredentials.length === 0) {
                            return {
                                url: "about:blank",
                                instructions:
                                    "No Claude Code credentials found. Please install Claude Code and run 'claude login' first, then return here to use those credentials.",
                                method: "code" as const,
                                callback: async () => ({
                                    type: "failed" as const,
                                    reason: "Claude Code not installed or not authenticated",
                                }),
                            };
                        }

                        const ccCred = ccCredentials[0];

                        if (!accountManager) {
                            accountManager = await AccountManager.load(config, null);
                        }

                        const identity = resolveIdentityFromCCCredential(ccCred);
                        const existing = findByIdentity(accountManager.getCCAccounts(), identity);

                        if (existing) {
                            existing.refreshToken = ccCred.refreshToken;
                            existing.identity = identity;
                            existing.source = ccCred.source;
                            existing.label = ccCred.label;
                            existing.enabled = true;
                            if (ccCred.accessToken) {
                                existing.access = ccCred.accessToken;
                            }
                            if (ccCred.expiresAt >= (existing.expires ?? 0)) {
                                existing.expires = ccCred.expiresAt;
                            }
                            existing.tokenUpdatedAt = Math.max(existing.tokenUpdatedAt || 0, ccCred.expiresAt || 0);
                            await accountManager.saveToDisk();
                        } else {
                            const added = accountManager.addAccount(
                                ccCred.refreshToken,
                                ccCred.accessToken,
                                ccCred.expiresAt,
                                undefined,
                                {
                                    identity,
                                    label: ccCred.label,
                                    source: ccCred.source,
                                },
                            );
                            if (added) {
                                added.source = ccCred.source;
                                added.label = ccCred.label;
                                added.identity = identity;
                            }
                            await accountManager.saveToDisk();
                            await toast("Added Claude Code credentials", "success");
                        }

                        return {
                            type: "success" as const,
                            refresh: ccCred.refreshToken,
                            access: ccCred.accessToken,
                            expires: ccCred.expiresAt,
                        };
                    },
                },
                {
                    label: "Claude Pro/Max (multi-account)",
                    type: "oauth" as const,
                    authorize: async () => {
                        const stored = await loadAccounts();
                        if (stored && stored.accounts.length > 0 && accountManager) {
                            const action = await promptAccountMenu(accountManager);
                            if (action === "cancel") {
                                return {
                                    url: "about:blank",
                                    instructions: "Cancelled.",
                                    method: "code" as const,
                                    callback: async () => ({ type: "failed" as const }),
                                };
                            }
                            if (action === "manage") {
                                await promptManageAccounts(accountManager);
                                await accountManager.saveToDisk();
                                return {
                                    url: "about:blank",
                                    instructions: "Account management complete. Re-run auth to add accounts.",
                                    method: "code" as const,
                                    callback: async () => ({ type: "failed" as const }),
                                };
                            }
                            if (action === "fresh") {
                                await clearAccounts();
                                accountManager.clearAll();
                            }
                        }

                        const { url, verifier, state } = await authorize("max");
                        return {
                            url,
                            instructions: "Paste the authorization code here: ",
                            method: "code" as const,
                            callback: async (code: string) => {
                                const parts = code.split("#");
                                if (state && parts[1] && parts[1] !== state) {
                                    return {
                                        type: "failed" as const,
                                        reason: "OAuth state mismatch",
                                    };
                                }
                                const credentials = await exchange(code, verifier);
                                if (credentials.type === "failed") return credentials;
                                if (!accountManager) {
                                    accountManager = await AccountManager.load(config, null);
                                }
                                const identity = resolveIdentityFromOAuthExchange(credentials);
                                const countBefore = accountManager.getAccountCount();
                                const candidate =
                                    identity.kind === "oauth"
                                        ? findByIdentity(accountManager.getOAuthAccounts(), identity)
                                        : null;
                                // Refuse to reshape a row that was born as a CC import. The id
                                // prefix is the only durable proof-of-origin; reshaping it to
                                // oauth would re-introduce the dedup bug.
                                const existing =
                                    candidate && /^cc-(cc-keychain|cc-file)-\d+:/.test(candidate.id) ? null : candidate;

                                if (existing) {
                                    existing.refreshToken = credentials.refresh;
                                    existing.access = credentials.access;
                                    existing.expires = credentials.expires;
                                    existing.email = credentials.email ?? existing.email;
                                    existing.identity = identity;
                                    existing.source = "oauth";
                                    existing.enabled = true;
                                    existing.tokenUpdatedAt = Date.now();
                                } else {
                                    accountManager.addAccount(
                                        credentials.refresh,
                                        credentials.access,
                                        credentials.expires,
                                        credentials.email,
                                        {
                                            identity,
                                            source: "oauth",
                                        },
                                    );
                                }

                                await accountManager.saveToDisk();
                                const total = accountManager.getAccountCount();
                                const name = credentials.email || "account";
                                if (existing) await toast(`Re-authenticated (${name})`, "success");
                                else if (countBefore > 0) await toast(`Added ${name} — ${total} accounts`, "success");
                                else await toast(`Authenticated (${name})`, "success");
                                return credentials;
                            },
                        };
                    },
                },
                {
                    label: "Create an API Key",
                    type: "oauth" as const,
                    authorize: async () => {
                        const { url, verifier, state } = await authorize("console");
                        return {
                            url,
                            instructions: "Paste the authorization code here: ",
                            method: "code" as const,
                            callback: async (code: string) => {
                                const parts = code.split("#");
                                if (state && parts[1] && parts[1] !== state) {
                                    return {
                                        type: "failed" as const,
                                        reason: "OAuth state mismatch",
                                    };
                                }
                                const credentials = await exchange(code, verifier);
                                if (credentials.type === "failed") return credentials;
                                const result = (await fetch(
                                    "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
                                    {
                                        method: "POST",
                                        headers: {
                                            "Content-Type": "application/json",
                                            authorization: `Bearer ${credentials.access}`,
                                        },
                                    },
                                ).then((r) => r.json())) as { raw_key: string };
                                return { type: "success" as const, key: result.raw_key };
                            },
                        };
                    },
                },
                {
                    provider: "anthropic",
                    label: "Manually enter API Key",
                    type: "api" as const,
                },
            ],
        },
    };
}
