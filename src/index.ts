// ---------------------------------------------------------------------------
// Plugin entry point — slim factory that wires all extracted modules.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { ManagedAccount } from "./accounts.js";
import { AccountManager } from "./accounts.js";
import { isAccountSpecificError, parseRateLimitReason, parseRetryAfterHeader } from "./backoff.js";
import type { PendingOAuthEntry } from "./commands/oauth-flow.js";
import { promptAccountMenu, promptManageAccounts } from "./commands/prompts.js";
import type { CommandDeps } from "./commands/router.js";
import { ANTHROPIC_COMMAND_HANDLED, handleAnthropicSlashCommand } from "./commands/router.js";
import type { AnthropicAuthConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { CLAUDE_CODE_IDENTITY_STRING, FALLBACK_CLAUDE_CLI_VERSION, FOREGROUND_EXPIRY_BUFFER_MS } from "./constants.js";
import { getOrCreateSignatureUserId, isTruthyEnv, logTransformedSystemPrompt } from "./env.js";
import { buildRequestHeaders } from "./headers/builder.js";
import { fetchLatestClaudeCodeVersion } from "./headers/user-agent.js";
import { hasOneMillionContext, isOpus46Model } from "./models.js";
import { authorize, exchange } from "./oauth.js";
import { transformRequestBody } from "./request/body.js";
import { extractFileIds, getAccountIdentifier } from "./request/metadata.js";
import { fetchWithRetry } from "./request/retry.js";
import { transformRequestUrl } from "./request/url.js";
import { isEventStreamResponse, stripMcpPrefixFromJsonBody, transformResponse } from "./response/index.js";
import { readCCCredentials } from "./cc-credentials.js";
import { clearAccounts, loadAccounts } from "./storage.js";
import type { OpenCodeClient } from "./token-refresh.js";
import { formatSwitchReason, markTokenStateUpdated, readDiskAccountAuth } from "./token-refresh.js";
import type { UsageStats } from "./types.js";
import { fetchViaBun } from "./bun-fetch.js";
import { createPluginHelpers } from "./plugin-helpers.js";
import { createRefreshHelpers } from "./refresh-helpers.js";

async function finalizeResponse(
  response: Response,
  onUsage?: ((stats: UsageStats) => void) | null,
  onAccountError?: ((details: { reason: string; invalidateToken: boolean }) => void) | null,
): Promise<Response> {
  if (!isEventStreamResponse(response)) {
    const body = stripMcpPrefixFromJsonBody(await response.text());
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  }

  return transformResponse(response, onUsage, onAccountError);
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export async function AnthropicAuthPlugin({
  client,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenCode plugin client API boundary; accepts arbitrary extension methods
  client: OpenCodeClient & Record<string, any>;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- plugin config accepts forward-compatible arbitrary keys
  const config: AnthropicAuthConfig & Record<string, any> = loadConfig();
  const signatureEmulationEnabled = config.signature_emulation.enabled;
  const promptCompactionMode =
    config.signature_emulation.prompt_compaction === "off" ? ("off" as const) : ("minimal" as const);
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

  // -- Version resolution ----------------------------------------------------

  let claudeCliVersion = FALLBACK_CLAUDE_CLI_VERSION;
  const signatureSessionId = randomUUID();
  const signatureUserId = getOrCreateSignatureUserId();
  if (shouldFetchClaudeCodeVersion) {
    fetchLatestClaudeCodeVersion()
      .then((version) => {
        if (!version) return;
        claudeCliVersion = version;
        debugLog("resolved claude-code version from npm", version);
      })
      .catch((err) => debugLog("CC version fetch failed:", (err as Error).message));
  }

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenCode plugin hook API boundary
    "experimental.chat.system.transform": (input: Record<string, any>, output: Record<string, any>) => {
      const prefix = CLAUDE_CODE_IDENTITY_STRING;
      if (!signatureEmulationEnabled && input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        if (output.system[1]) output.system[1] = prefix + "\n\n" + output.system[1];
      }
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenCode plugin hook API boundary
    config: async (input: Record<string, any>) => {
      input.command ??= {};
      input.command["anthropic"] = {
        template: "/anthropic",
        description: "Manage Anthropic auth, config, and betas (usage, login, config, set, betas, switch)",
      };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenCode plugin hook API boundary
    "command.execute.before": async (input: Record<string, any>) => {
      if (input.command !== "anthropic") return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- command router accepts the Record-shaped input from OpenCode
        await handleAnthropicSlashCommand(input as any, commandDeps);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sendCommandMessage(input.sessionID, `▣ Anthropic (error)\n\n${message}`);
      }
      throw new Error(ANTHROPIC_COMMAND_HANDLED);
    },

    auth: {
      provider: "anthropic",
      async loader(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenCode auth loader API boundary
        getAuth: () => Promise<Record<string, any>>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenCode auth loader API boundary
        provider: Record<string, any>,
      ) {
        const auth = await getAuth();
        if (auth.type === "oauth") {
          // Zero out cost for max plan and optionally override context limits.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- model objects carry provider-specific metadata
          for (const model of Object.values(provider.models) as Record<string, any>[]) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
            if (
              config.override_model_limits.enabled &&
              !isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT) &&
              (hasOneMillionContext(model.id) || isOpus46Model(model.id))
            ) {
              model.limit = {
                ...(model.limit ?? {}),
                context: config.override_model_limits.context,
                ...(config.override_model_limits.output > 0 ? { output: config.override_model_limits.output } : {}),
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
            } else {
              await toast("No Claude Code credentials — using OAuth", "info");
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
                accounts.find((a) => a.email && a.email.toLowerCase() === initialAccountEnv.toLowerCase()) ?? null;
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
              debugLog("OPENCODE_ANTHROPIC_INITIAL_ACCOUNT: could not resolve account", initialAccountEnv);
            }
          }

          return {
            apiKey: "",
            async fetch(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fetch input varies (string | URL | Request) across call sites
              input: any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fetch init is OpenCode-shaped RequestInit-plus
              init: any,
            ) {
              const currentAuth = await getAuth();
              if (currentAuth.type !== "oauth") return fetch(input, init);

              const requestInit = init ?? {};
              const { requestInput, requestUrl } = transformRequestUrl(input);
              const requestMethod = String(
                requestInit.method || (requestInput instanceof Request ? requestInput.method : "POST"),
              ).toUpperCase();
              let showUsageToast: boolean;
              try {
                showUsageToast = new URL(requestUrl!).pathname === "/v1/messages" && requestMethod === "POST";
              } catch {
                showUsageToast = false;
              }

              let lastError: unknown = null;
              const transientRefreshSkips = new Set<number>();

              if (accountManager && !initialAccountPinned) {
                await accountManager.syncActiveIndexFromDisk();
              }

              const maxAttempts = accountManager!.getTotalAccountCount();

              // File-ID account pinning
              let pinnedAccount: ManagedAccount | null = null;
              if (typeof requestInit.body === "string" && fileAccountMap.size > 0) {
                try {
                  const bodyObj = JSON.parse(requestInit.body);
                  const fileIds = extractFileIds(bodyObj);
                  for (const fid of fileIds) {
                    const pinnedIndex = fileAccountMap.get(fid);
                    if (pinnedIndex !== undefined) {
                      const candidates = accountManager!.getEnabledAccounts();
                      pinnedAccount = candidates.find((a) => a.index === pinnedIndex) ?? null;
                      if (pinnedAccount) {
                        debugLog("file-id pinning: routing to account", {
                          fileId: fid,
                          accountIndex: pinnedIndex,
                          email: pinnedAccount.email,
                        });
                        break;
                      }
                    }
                  }
                } catch {
                  /* Non-JSON body */
                }
              }

              for (let attempt = 0; attempt < maxAttempts; attempt++) {
                const account =
                  attempt === 0 && pinnedAccount && !transientRefreshSkips.has(pinnedAccount.index)
                    ? pinnedAccount
                    : accountManager!.getCurrentAccount(transientRefreshSkips);

                // Toast account usage
                if (showUsageToast && account && accountManager) {
                  const currentIndex = accountManager.getCurrentIndex();
                  if (currentIndex !== lastToastedIndex) {
                    const name = account.email || `Account ${currentIndex + 1}`;
                    const total = accountManager.getAccountCount();
                    const msg = total > 1 ? `Claude: ${name} (${currentIndex + 1}/${total})` : `Claude: ${name}`;
                    await toast(msg, "info", { debounceKey: "account-usage" });
                    lastToastedIndex = currentIndex;
                  }
                }

                if (!account) {
                  const enabledCount = accountManager!.getAccountCount();
                  if (enabledCount === 0) {
                    throw new Error(
                      "No enabled Anthropic accounts available. Enable one with 'opencode-anthropic-auth enable <N>'.",
                    );
                  }
                  throw new Error("No available Anthropic account for request.");
                }

                // Determine access token
                let accessToken: string | undefined;
                if (!account.access || !account.expires || account.expires < Date.now() + FOREGROUND_EXPIRY_BUFFER_MS) {
                  const attemptedRefreshToken = account.refreshToken;
                  try {
                    accessToken = await refreshAccountTokenSingleFlight(account);
                  } catch (err) {
                    let finalError = err;
                    let details = parseRefreshFailure(err);

                    if (details.isInvalidGrant || details.isTerminalStatus) {
                      const diskAuth = await readDiskAccountAuth(account.id);
                      const retryToken = diskAuth?.refreshToken;
                      if (
                        retryToken &&
                        retryToken !== attemptedRefreshToken &&
                        account.refreshToken === attemptedRefreshToken
                      ) {
                        debugLog("refresh token on disk differs from in-memory, retrying with disk token", {
                          accountIndex: account.index,
                        });
                        account.refreshToken = retryToken;
                        if (diskAuth?.tokenUpdatedAt) account.tokenUpdatedAt = diskAuth.tokenUpdatedAt;
                        else markTokenStateUpdated(account);
                      } else if (retryToken && retryToken !== attemptedRefreshToken) {
                        debugLog("skipping disk token adoption because in-memory token already changed", {
                          accountIndex: account.index,
                        });
                      }
                      try {
                        accessToken = await refreshAccountTokenSingleFlight(account);
                      } catch (retryErr) {
                        finalError = retryErr;
                        details = parseRefreshFailure(retryErr);
                        debugLog("retry refresh failed", {
                          accountIndex: account.index,
                          status: details.status,
                          errorCode: details.errorCode,
                          message: details.message,
                        });
                      }
                    }

                    if (!accessToken) {
                      accountManager!.markFailure(account);
                      if (details.isInvalidGrant || details.isTerminalStatus) {
                        const name = account.email || `Account ${accountManager!.getCurrentIndex() + 1}`;
                        debugLog("disabling account after terminal refresh failure", {
                          accountIndex: account.index,
                          status: details.status,
                          errorCode: details.errorCode,
                          message: details.message,
                        });
                        account.enabled = false;
                        accountManager!.requestSaveToDisk();
                        const statusLabel = Number.isFinite(details.status)
                          ? `HTTP ${details.status}`
                          : "unknown status";
                        await toast(
                          `Disabled ${name} (token refresh failed: ${details.errorCode || statusLabel})`,
                          "error",
                        );
                      } else {
                        transientRefreshSkips.add(account.index);
                      }
                      lastError = finalError;
                      continue;
                    }
                  }
                } else {
                  accessToken = account.access;
                }

                maybeRefreshIdleAccounts(account);

                const body = transformRequestBody(
                  requestInit.body,
                  {
                    enabled: signatureEmulationEnabled,
                    claudeCliVersion,
                    promptCompactionMode,
                  },
                  {
                    persistentUserId: signatureUserId,
                    sessionId: signatureSessionId,
                    accountId: getAccountIdentifier(account),
                  },
                  config.relocate_third_party_prompts,
                  config.sanitize_system_prompt,
                  debugLog,
                );
                logTransformedSystemPrompt(body);

                const requestHeaders = buildRequestHeaders(input, requestInit, accessToken!, body, requestUrl, {
                  enabled: signatureEmulationEnabled,
                  claudeCliVersion,
                  promptCompactionMode,
                  customBetas: config.custom_betas,
                  strategy: config.account_selection_strategy,
                });

                // --- Debug: log the exact fingerprint being sent ---
                if (config.debug) {
                  const billingBlock = body
                    ? (() => {
                        try {
                          const parsed = JSON.parse(body) as Record<string, unknown>;
                          const sys = parsed.system;
                          if (Array.isArray(sys)) {
                            return (sys as Array<{ text?: string }>).find(
                              (b) => typeof b.text === "string" && b.text.startsWith("x-anthropic-billing-header:"),
                            )?.text;
                          }
                        } catch {
                          // JSON parse failed — body is not valid JSON
                        }
                        return undefined;
                      })()
                    : undefined;

                  debugLog("fingerprint snapshot", {
                    billingHeader: billingBlock ?? "(not in system prompt)",
                    userAgent: requestHeaders.get("user-agent"),
                    anthropicBeta: requestHeaders.get("anthropic-beta"),
                    stainlessPackageVersion: requestHeaders.get("x-stainless-package-version"),
                    xApp: requestHeaders.get("x-app"),
                    claudeCliVersion,
                    signatureEnabled: signatureEmulationEnabled,
                  });
                }

                let response: Response;
                const fetchInput = requestInput as string | URL | Request;
                try {
                  response = await fetchViaBun(
                    fetchInput,
                    {
                      ...requestInit,
                      body,
                      headers: requestHeaders,
                    },
                    config.debug,
                  );
                } catch (err) {
                  const fetchError = err instanceof Error ? err : new Error(String(err));
                  if (accountManager && account) {
                    accountManager.markFailure(account);
                    transientRefreshSkips.add(account.index);
                    lastError = fetchError;
                    debugLog("request fetch threw, trying next account", {
                      accountIndex: account.index,
                      message: fetchError.message,
                    });
                    continue;
                  }
                  throw fetchError;
                }

                // On error, check if account-specific or service-wide
                if (!response.ok && accountManager && account) {
                  let errorBody: string | null = null;
                  try {
                    errorBody = await response.clone().text();
                  } catch {
                    /* ignore */
                  }

                  if (isAccountSpecificError(response.status, errorBody)) {
                    const reason = parseRateLimitReason(response.status, errorBody);
                    const retryAfterMs = parseRetryAfterHeader(response);
                    const authOrPermissionIssue = reason === "AUTH_FAILED";
                    if (reason === "AUTH_FAILED") {
                      account.access = undefined;
                      account.expires = undefined;
                      markTokenStateUpdated(account);
                    }
                    debugLog("account-specific error, switching account", {
                      accountIndex: account.index,
                      status: response.status,
                      reason,
                    });
                    accountManager.markRateLimited(account, reason, authOrPermissionIssue ? null : retryAfterMs);
                    const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
                    const total = accountManager.getAccountCount();
                    if (total > 1) {
                      const switchReason = formatSwitchReason(response.status, reason);
                      await toast(`${name} ${switchReason}, switching account`, "warning", {
                        debounceKey: "account-switch",
                      });
                    }
                    continue;
                  }

                  if (response.status === 500 || response.status === 503 || response.status === 529) {
                    debugLog("service-wide response error, attempting retry", {
                      status: response.status,
                    });

                    let retryCount = 0;
                    const retried = await fetchWithRetry(
                      async () => {
                        if (retryCount === 0) {
                          retryCount += 1;
                          return response;
                        }

                        const headersForRetry = new Headers(requestHeaders);
                        headersForRetry.set("x-stainless-retry-count", String(retryCount));
                        retryCount += 1;
                        const retryUrl = fetchInput instanceof Request ? fetchInput.url : fetchInput.toString();
                        return fetchViaBun(
                          retryUrl,
                          {
                            ...requestInit,
                            body,
                            headers: headersForRetry,
                          },
                          config.debug,
                        );
                      },
                      { maxRetries: 2 },
                    );

                    if (!retried.ok) {
                      return finalizeResponse(retried);
                    }

                    response = retried;
                  } else {
                    debugLog("non-account-specific response error, returning directly", {
                      status: response.status,
                    });
                    return finalizeResponse(response);
                  }
                }

                // Success
                if (account && accountManager && response.ok) {
                  accountManager.markSuccess(account);
                }

                const shouldInspectStream = response.ok && account && accountManager && isEventStreamResponse(response);
                const usageCallback = shouldInspectStream
                  ? (usage: UsageStats) => {
                      accountManager!.recordUsage(account.index, usage);
                    }
                  : null;
                const accountErrorCallback = shouldInspectStream
                  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reason carries opaque rate-limit metadata; shape stabilized at callsite
                    (details: { reason: any; invalidateToken: boolean }) => {
                      if (details.invalidateToken) {
                        account.access = undefined;
                        account.expires = undefined;
                        markTokenStateUpdated(account);
                      }
                      accountManager!.markRateLimited(account, details.reason, null);
                    }
                  : null;

                return finalizeResponse(response, usageCallback, accountErrorCallback);
              }

              if (lastError) throw lastError;
              throw new Error("All accounts exhausted — no account could serve this request");
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

            const exists = accountManager
              .getAccountsSnapshot()
              .some((acc: ManagedAccount) => acc.refreshToken === ccCred.refreshToken);

            if (!exists) {
              const added = accountManager.addAccount(ccCred.refreshToken, ccCred.accessToken, ccCred.expiresAt);
              if (added) {
                added.source = ccCred.source;
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
                const countBefore = accountManager.getAccountCount();
                accountManager.addAccount(
                  credentials.refresh,
                  credentials.access,
                  credentials.expires,
                  credentials.email,
                );
                await accountManager.saveToDisk();
                const total = accountManager.getAccountCount();
                const name = credentials.email || "account";
                if (countBefore > 0) await toast(`Added ${name} — ${total} accounts`, "success");
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
                const result = (await fetch("https://api.anthropic.com/api/oauth/claude_cli/create_api_key", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    authorization: `Bearer ${credentials.access}`,
                  },
                }).then((r) => r.json())) as { raw_key: string };
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
