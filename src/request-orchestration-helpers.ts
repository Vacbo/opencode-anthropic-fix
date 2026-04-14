import type { AccountManager, ManagedAccount } from "./accounts.js";
import type { RateLimitReason } from "./backoff.js";
import { isAccountSpecificError, parseRateLimitReason, parseRetryAfterHeader } from "./backoff.js";
import type { AnthropicAuthConfig } from "./config.js";
import { FOREGROUND_EXPIRY_BUFFER_MS } from "./constants.js";
import { logTransformedSystemPrompt } from "./env.js";
import { buildRequestHeaders } from "./headers/builder.js";
import type { PluginHelpers } from "./plugin-helpers.js";
import { resolveSignatureProfile } from "./profiles/index.js";
import { cloneBodyForRetry, transformRequestBody } from "./request/body.js";
import { extractFileIds, getAccountIdentifier } from "./request/metadata.js";
import { fetchWithRetry } from "./request/retry.js";
import { transformRequestUrl } from "./request/url.js";
import {
    buildCodeSessionPayload,
    extractOrganizationUuidFromResponse,
    buildSessionSidecarHeaders,
    extractOrganizationUuidFromBody,
    extractSessionTitleFromBody,
    type SessionSidecarState,
} from "./session-sidecar.js";
import type { RefreshHelpers } from "./refresh-helpers.js";
import { isEventStreamResponse, stripMcpPrefixFromJsonBody, transformResponse } from "./response/index.js";
import { StreamTruncatedError } from "./response/streaming.js";
import { formatSwitchReason, markTokenStateUpdated, readDiskAccountAuth } from "./token-refresh.js";
import type { UsageStats } from "./types.js";

type PromptCompactionMode = "minimal" | "off";
type ToastFn = PluginHelpers["toast"];
type ParseRefreshFailureFn = RefreshHelpers["parseRefreshFailure"];
type RefreshAccountTokenSingleFlightFn = RefreshHelpers["refreshAccountTokenSingleFlight"];
type MaybeRefreshIdleAccountsFn = RefreshHelpers["maybeRefreshIdleAccounts"];

type RequestContext = {
    attempt: number;
    cloneBody: string | undefined;
    preparedBody: string | undefined;
};

type PreparedRequest = {
    requestInput: string | URL | Request;
    requestInit: RequestInit;
    requestUrl: URL | null;
    requestMethod: string;
    showUsageToast: boolean;
    requestContext: RequestContext;
};

type FinalizeResponseAccountErrorDetails = {
    reason: string;
    invalidateToken: boolean;
};

export interface RequestOrchestrationDeps {
    config: AnthropicAuthConfig;
    debugLog: (...args: unknown[]) => void;
    toast: ToastFn;
    getAccountManager: () => AccountManager | null;
    getClaudeCliVersion: () => string;
    getInitialAccountPinned: () => boolean;
    getLastToastedIndex: () => number;
    setLastToastedIndex: (index: number) => void;
    fileAccountMap: Map<string, number>;
    forwardRequest: (input: string | URL | Request, init: RequestInit) => Promise<Response>;
    parseRefreshFailure: ParseRefreshFailureFn;
    refreshAccountTokenSingleFlight: RefreshAccountTokenSingleFlightFn;
    maybeRefreshIdleAccounts: MaybeRefreshIdleAccountsFn;
    signatureEmulationEnabled: boolean;
    promptCompactionMode: PromptCompactionMode;
    signatureSanitizeSystemPrompt: boolean;
    getSignatureSessionId: () => string;
    signatureUserId: string;
}

function getAccountManagerOrThrow(getAccountManager: () => AccountManager | null): AccountManager {
    const accountManager = getAccountManager();
    if (!accountManager) {
        throw new Error("No available Anthropic account for request.");
    }

    return accountManager;
}

async function finalizeResponse(
    response: Response,
    onUsage?: ((stats: UsageStats) => void) | null,
    onAccountError?: ((details: FinalizeResponseAccountErrorDetails) => void) | null,
    onStreamError?: ((error: Error) => void) | null,
): Promise<Response> {
    if (!isEventStreamResponse(response)) {
        const body = stripMcpPrefixFromJsonBody(await response.text());
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: new Headers(response.headers),
        });
    }

    return transformResponse(response, onUsage, onAccountError, onStreamError);
}

function resolveShowUsageToast(requestUrl: URL | null, requestMethod: string): boolean {
    try {
        return requestUrl?.pathname === "/v1/messages" && requestMethod === "POST";
    } catch {
        return false;
    }
}

async function prepareRequest(input: string | URL | Request, init: RequestInit | undefined): Promise<PreparedRequest> {
    const requestInit = { ...(init ?? {}) };
    const { requestInput, requestUrl } = transformRequestUrl(input);
    const resolvedBody =
        requestInit.body !== undefined
            ? requestInit.body
            : requestInput instanceof Request && requestInput.body
              ? await requestInput.clone().text()
              : undefined;

    if (resolvedBody !== undefined) {
        requestInit.body = resolvedBody;
    }

    const requestMethod = String(
        requestInit.method || (requestInput instanceof Request ? requestInput.method : "POST"),
    ).toUpperCase();

    return {
        requestInput: requestInput as string | URL | Request,
        requestInit,
        requestUrl,
        requestMethod,
        showUsageToast: resolveShowUsageToast(requestUrl, requestMethod),
        requestContext: {
            attempt: 0,
            cloneBody: typeof resolvedBody === "string" ? cloneBodyForRetry(resolvedBody) : undefined,
            preparedBody: undefined,
        },
    };
}

function resolvePinnedAccount(
    accountManager: AccountManager,
    requestBody: RequestInit["body"],
    fileAccountMap: Map<string, number>,
    debugLog: (...args: unknown[]) => void,
): ManagedAccount | null {
    if (typeof requestBody !== "string" || fileAccountMap.size === 0) {
        return null;
    }

    try {
        const bodyObj = JSON.parse(requestBody);
        const fileIds = extractFileIds(bodyObj);
        for (const fileId of fileIds) {
            const pinnedIndex = fileAccountMap.get(fileId);
            if (pinnedIndex === undefined) {
                continue;
            }

            const pinnedAccount =
                accountManager.getEnabledAccounts().find((account) => account.index === pinnedIndex) ?? null;
            if (!pinnedAccount) {
                continue;
            }

            debugLog("file-id pinning: routing to account", {
                fileId,
                accountIndex: pinnedIndex,
                email: pinnedAccount.email,
            });
            return pinnedAccount;
        }
    } catch {
        // Non-JSON body
    }

    return null;
}

function maybeToastAccountUsage(params: {
    showUsageToast: boolean;
    account: ManagedAccount | null;
    accountManager: AccountManager;
    getLastToastedIndex: () => number;
    setLastToastedIndex: (index: number) => void;
    toast: ToastFn;
}): Promise<void> | undefined {
    const { showUsageToast, account, accountManager, getLastToastedIndex, setLastToastedIndex, toast } = params;

    if (!showUsageToast || !account) {
        return undefined;
    }

    const currentIndex = accountManager.getCurrentIndex();
    if (currentIndex === getLastToastedIndex()) {
        return undefined;
    }

    const name = account.email || `Account ${currentIndex + 1}`;
    const total = accountManager.getAccountCount();
    const message = total > 1 ? `Claude: ${name} (${currentIndex + 1}/${total})` : `Claude: ${name}`;

    return toast(message, "info", { debounceKey: "account-usage" }).then(() => {
        setLastToastedIndex(currentIndex);
    });
}

async function resolveAccessToken(
    account: ManagedAccount,
    accountManager: AccountManager,
    transientRefreshSkips: Set<number>,
    deps: Pick<
        RequestOrchestrationDeps,
        "debugLog" | "toast" | "parseRefreshFailure" | "refreshAccountTokenSingleFlight"
    >,
): Promise<{ accessToken?: string; lastError?: unknown }> {
    if (account.access && account.expires && account.expires >= Date.now() + FOREGROUND_EXPIRY_BUFFER_MS) {
        return { accessToken: account.access };
    }

    const attemptedRefreshToken = account.refreshToken;
    try {
        return { accessToken: await deps.refreshAccountTokenSingleFlight(account) };
    } catch (err) {
        let finalError = err;
        let details = deps.parseRefreshFailure(err);

        if (details.isInvalidGrant || details.isTerminalStatus) {
            const diskAuth = await readDiskAccountAuth(account.id);
            const retryToken = diskAuth?.refreshToken;
            if (retryToken && retryToken !== attemptedRefreshToken && account.refreshToken === attemptedRefreshToken) {
                deps.debugLog("refresh token on disk differs from in-memory, retrying with disk token", {
                    accountIndex: account.index,
                });
                account.refreshToken = retryToken;
                if (diskAuth?.tokenUpdatedAt) {
                    account.tokenUpdatedAt = diskAuth.tokenUpdatedAt;
                } else {
                    markTokenStateUpdated(account);
                }
            } else if (retryToken && retryToken !== attemptedRefreshToken) {
                deps.debugLog("skipping disk token adoption because in-memory token already changed", {
                    accountIndex: account.index,
                });
            }

            try {
                return {
                    accessToken: await deps.refreshAccountTokenSingleFlight(account),
                };
            } catch (retryErr) {
                finalError = retryErr;
                details = deps.parseRefreshFailure(retryErr);
                deps.debugLog("retry refresh failed", {
                    accountIndex: account.index,
                    status: details.status,
                    errorCode: details.errorCode,
                    message: details.message,
                });
            }
        }

        accountManager.markFailure(account);
        if (details.isInvalidGrant || details.isTerminalStatus) {
            const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
            deps.debugLog("disabling account after terminal refresh failure", {
                accountIndex: account.index,
                status: details.status,
                errorCode: details.errorCode,
                message: details.message,
            });
            account.enabled = false;
            accountManager.requestSaveToDisk();
            const statusLabel = Number.isFinite(details.status) ? `HTTP ${details.status}` : "unknown status";
            await deps.toast(`Disabled ${name} (token refresh failed: ${details.errorCode || statusLabel})`, "error");
        } else {
            transientRefreshSkips.add(account.index);
        }

        return { lastError: finalError };
    }
}

function buildAttemptBody(
    account: ManagedAccount,
    requestContext: RequestContext,
    signatureSessionId: string,
    deps: Pick<
        RequestOrchestrationDeps,
        | "config"
        | "debugLog"
        | "getClaudeCliVersion"
        | "signatureEmulationEnabled"
        | "promptCompactionMode"
        | "signatureSanitizeSystemPrompt"
        | "signatureUserId"
    >,
): string | undefined {
    const transformedBody = transformRequestBody(
        requestContext.cloneBody === undefined ? undefined : cloneBodyForRetry(requestContext.cloneBody),
        {
            enabled: deps.signatureEmulationEnabled,
            claudeCliVersion: deps.getClaudeCliVersion(),
            promptCompactionMode: deps.promptCompactionMode,
            sanitizeSystemPrompt: deps.signatureSanitizeSystemPrompt,
        },
        {
            persistentUserId: deps.signatureUserId,
            sessionId: signatureSessionId,
            accountId: getAccountIdentifier(account),
        },
        deps.config.relocate_third_party_prompts,
        deps.debugLog,
    );

    requestContext.preparedBody = typeof transformedBody === "string" ? cloneBodyForRetry(transformedBody) : undefined;
    return transformedBody;
}

function logFingerprintSnapshot(
    body: string | undefined,
    requestHeaders: Headers,
    deps: Pick<RequestOrchestrationDeps, "config" | "debugLog" | "getClaudeCliVersion" | "signatureEmulationEnabled">,
): void {
    if (!deps.config.debug) {
        return;
    }

    const billingHeader = body
        ? (() => {
              try {
                  const parsed = JSON.parse(body) as Record<string, unknown>;
                  const system = parsed.system;
                  if (Array.isArray(system)) {
                      return (system as Array<{ text?: string }>).find(
                          (block) =>
                              typeof block.text === "string" && block.text.startsWith("x-anthropic-billing-header:"),
                      )?.text;
                  }
              } catch {
                  // JSON parse failed — body is not valid JSON
              }

              return undefined;
          })()
        : undefined;

    deps.debugLog("fingerprint snapshot", {
        billingHeader: billingHeader ?? "(not in system prompt)",
        userAgent: requestHeaders.get("user-agent"),
        anthropicBeta: requestHeaders.get("anthropic-beta"),
        stainlessPackageVersion: requestHeaders.get("x-stainless-package-version"),
        xApp: requestHeaders.get("x-app"),
        claudeCliVersion: deps.getClaudeCliVersion(),
        signatureEnabled: deps.signatureEmulationEnabled,
    });
}

function buildTransportRequestInit(
    requestInit: RequestInit,
    headers: Headers,
    requestBody: RequestInit["body"],
    forceFreshConnection: boolean,
): RequestInit {
    const requestHeadersForTransport = new Headers(headers);
    if (forceFreshConnection) {
        requestHeadersForTransport.set("connection", "close");
        requestHeadersForTransport.set("x-proxy-disable-keepalive", "true");
    } else {
        requestHeadersForTransport.delete("connection");
        requestHeadersForTransport.delete("x-proxy-disable-keepalive");
    }

    return {
        ...requestInit,
        body: requestBody,
        headers: requestHeadersForTransport,
        ...(forceFreshConnection ? { keepalive: false } : {}),
    };
}

async function retryServiceWideResponse(params: {
    response: Response;
    fetchInput: string | URL | Request;
    requestHeaders: Headers;
    requestInit: RequestInit;
    requestContext: RequestContext;
    forwardRequest: RequestOrchestrationDeps["forwardRequest"];
}): Promise<Response> {
    let retryCount = 0;
    return fetchWithRetry(
        async ({ forceFreshConnection }) => {
            if (retryCount === 0) {
                retryCount += 1;
                return params.response;
            }

            const headersForRetry = new Headers(params.requestHeaders);
            headersForRetry.set("x-stainless-retry-count", String(retryCount));
            retryCount += 1;
            const retryUrl =
                params.fetchInput instanceof Request ? params.fetchInput.url : params.fetchInput.toString();
            const retryBody =
                params.requestContext.preparedBody === undefined
                    ? undefined
                    : cloneBodyForRetry(params.requestContext.preparedBody);

            return params.forwardRequest(
                retryUrl,
                buildTransportRequestInit(params.requestInit, headersForRetry, retryBody, forceFreshConnection),
            );
        },
        { maxRetries: 2 },
    );
}

function buildFinalizeCallbacks(
    response: Response,
    account: ManagedAccount,
    accountManager: AccountManager,
    debugLog: (...args: unknown[]) => void,
) {
    const shouldInspectStream = response.ok && isEventStreamResponse(response);
    const onUsage = shouldInspectStream
        ? (usage: UsageStats) => {
              accountManager.recordUsage(account.index, usage);
          }
        : null;
    const onAccountError = shouldInspectStream
        ? (details: FinalizeResponseAccountErrorDetails) => {
              if (details.invalidateToken) {
                  account.access = undefined;
                  account.expires = undefined;
                  markTokenStateUpdated(account);
              }
              accountManager.markRateLimited(account, details.reason as RateLimitReason, null);
          }
        : null;
    const onStreamError = shouldInspectStream
        ? (error: Error) => {
              if (!(error instanceof StreamTruncatedError)) {
                  return;
              }

              debugLog("stream truncated during response consumption", {
                  accountIndex: account.index,
                  message: error.message,
                  context: error.context,
              });
          }
        : null;

    return { onUsage, onAccountError, onStreamError };
}

export function createRequestOrchestrationHelpers(deps: RequestOrchestrationDeps) {
    const sessionStateByKey = new Map<string, SessionSidecarState>();

    function getSessionStateKey(account: ManagedAccount, signatureSessionId: string): string {
        return `${account.id}:${signatureSessionId}`;
    }

    function getSessionState(account: ManagedAccount, signatureSessionId: string): SessionSidecarState {
        const key = getSessionStateKey(account, signatureSessionId);
        const existing = sessionStateByKey.get(key);
        if (existing) return existing;
        const created: SessionSidecarState = {};
        sessionStateByKey.set(key, created);
        return created;
    }

    async function ensureCodeSession(params: {
        account: ManagedAccount;
        accessToken: string;
        body: string | undefined;
        state: SessionSidecarState;
        signatureSessionId: string;
    }): Promise<void> {
        const { account, accessToken, body, state, signatureSessionId } = params;
        if (state.codeSessionId || state.createPromise) {
            return state.createPromise;
        }

        state.createPromise = (async () => {
            try {
                const response = await deps.forwardRequest("https://api.anthropic.com/v1/code/sessions", {
                    method: "POST",
                    headers: buildSessionSidecarHeaders(accessToken),
                    body: JSON.stringify(buildCodeSessionPayload(body, signatureSessionId)),
                    keepalive: false,
                });

                if (!response.ok) {
                    deps.debugLog("code session create failed", {
                        accountIndex: account.index,
                        status: response.status,
                    });
                    return;
                }

                const json = (await response.json()) as { session?: { id?: string } };
                if (typeof json.session?.id === "string" && json.session.id) {
                    state.codeSessionId = json.session.id;
                }
            } catch (error) {
                deps.debugLog("code session create threw", {
                    accountIndex: account.index,
                    message: error instanceof Error ? error.message : String(error),
                });
            } finally {
                state.createPromise = undefined;
            }
        })();

        return state.createPromise;
    }

    async function maybePatchRemoteSessionTitle(params: {
        account: ManagedAccount;
        accessToken: string;
        body: string | undefined;
        state: SessionSidecarState;
    }): Promise<void> {
        const { account, accessToken, body, state } = params;
        const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID?.trim();
        if (!remoteSessionId || state.patchPromise) {
            return state.patchPromise;
        }

        const title = extractSessionTitleFromBody(body);
        if (!title || title === state.lastPatchedTitle) {
            return;
        }

        const organizationUuid = state.organizationUuid || extractOrganizationUuidFromBody(body);
        if (!organizationUuid) {
            return;
        }
        state.organizationUuid = organizationUuid;

        state.patchPromise = (async () => {
            try {
                const response = await deps.forwardRequest(`https://api.anthropic.com/v1/sessions/${remoteSessionId}`, {
                    method: "PATCH",
                    headers: buildSessionSidecarHeaders(accessToken, organizationUuid, true),
                    body: JSON.stringify({ title }),
                    keepalive: false,
                });

                if (!response.ok) {
                    deps.debugLog("remote session title patch failed", {
                        accountIndex: account.index,
                        remoteSessionId,
                        status: response.status,
                    });
                    return;
                }

                state.lastPatchedTitle = title;
            } catch (error) {
                deps.debugLog("remote session title patch threw", {
                    accountIndex: account.index,
                    remoteSessionId,
                    message: error instanceof Error ? error.message : String(error),
                });
            } finally {
                state.patchPromise = undefined;
            }
        })();

        return state.patchPromise;
    }

    function triggerSessionSideEffects(params: {
        account: ManagedAccount;
        accessToken: string;
        requestUrl: URL | null;
        requestMethod: string;
        body: string | undefined;
        response: Response;
    }): void {
        const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID?.trim();
        if (!remoteSessionId) {
            return;
        }

        if (params.requestMethod !== "POST" || params.requestUrl?.pathname !== "/v1/messages") {
            return;
        }

        const signatureSessionId = deps.getSignatureSessionId();
        const state = getSessionState(params.account, signatureSessionId);
        state.organizationUuid ||= extractOrganizationUuidFromResponse(params.response);
        state.organizationUuid ||= extractOrganizationUuidFromBody(params.body);

        void ensureCodeSession({
            account: params.account,
            accessToken: params.accessToken,
            body: params.body,
            state,
            signatureSessionId,
        });

        void maybePatchRemoteSessionTitle({
            account: params.account,
            accessToken: params.accessToken,
            body: params.body,
            state,
        });
    }

    async function executeOAuthFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        const preparedRequest = await prepareRequest(input, init);
        const transientRefreshSkips = new Set<number>();
        let lastError: unknown = null;

        if (!deps.getInitialAccountPinned()) {
            const accountManager = deps.getAccountManager();
            if (accountManager) {
                await accountManager.syncActiveIndexFromDisk();
            }
        }

        const maxAttempts = getAccountManagerOrThrow(deps.getAccountManager).getTotalAccountCount();
        const pinnedAccount = resolvePinnedAccount(
            getAccountManagerOrThrow(deps.getAccountManager),
            preparedRequest.requestInit.body,
            deps.fileAccountMap,
            deps.debugLog,
        );

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            preparedRequest.requestContext.attempt = attempt + 1;

            const accountManager = getAccountManagerOrThrow(deps.getAccountManager);
            const account =
                attempt === 0 && pinnedAccount && !transientRefreshSkips.has(pinnedAccount.index)
                    ? pinnedAccount
                    : accountManager.getCurrentAccount(transientRefreshSkips);

            await maybeToastAccountUsage({
                showUsageToast: preparedRequest.showUsageToast,
                account,
                accountManager,
                getLastToastedIndex: deps.getLastToastedIndex,
                setLastToastedIndex: deps.setLastToastedIndex,
                toast: deps.toast,
            });

            if (!account) {
                const enabledCount = accountManager.getAccountCount();
                if (enabledCount === 0) {
                    throw new Error(
                        "No enabled Anthropic accounts available. Enable one with 'opencode-anthropic-auth enable <N>'.",
                    );
                }

                throw new Error("No available Anthropic account for request.");
            }

            const { accessToken, lastError: refreshError } = await resolveAccessToken(
                account,
                accountManager,
                transientRefreshSkips,
                {
                    debugLog: deps.debugLog,
                    toast: deps.toast,
                    parseRefreshFailure: deps.parseRefreshFailure,
                    refreshAccountTokenSingleFlight: deps.refreshAccountTokenSingleFlight,
                },
            );
            if (!accessToken) {
                lastError = refreshError;
                continue;
            }

            deps.maybeRefreshIdleAccounts(account);

            const signatureSessionId = deps.getSignatureSessionId();
            const body = buildAttemptBody(account, preparedRequest.requestContext, signatureSessionId, deps);
            logTransformedSystemPrompt(body);

            const requestHeaders = buildRequestHeaders(
                input,
                preparedRequest.requestInit as Record<string, unknown>,
                accessToken,
                body,
                preparedRequest.requestUrl,
                {
                    enabled: deps.signatureEmulationEnabled,
                    claudeCliVersion: deps.getClaudeCliVersion(),
                    promptCompactionMode: deps.promptCompactionMode,
                    profile: resolveSignatureProfile(deps.config.signature_profile),
                    sessionId: signatureSessionId,
                    sanitizeSystemPrompt: deps.signatureSanitizeSystemPrompt,
                    customBetas: deps.config.custom_betas,
                    strategy: deps.config.account_selection_strategy,
                },
            );
            logFingerprintSnapshot(body, requestHeaders, deps);

            const fetchInput = preparedRequest.requestInput;
            let response: Response;
            try {
                response = await fetchWithRetry(
                    async ({ forceFreshConnection }) =>
                        deps.forwardRequest(
                            fetchInput,
                            buildTransportRequestInit(
                                preparedRequest.requestInit,
                                requestHeaders,
                                body,
                                forceFreshConnection,
                            ),
                        ),
                    {
                        maxRetries: 2,
                        shouldRetryResponse: () => false,
                    },
                );
            } catch (err) {
                const fetchError = err instanceof Error ? err : new Error(String(err));
                accountManager.markFailure(account);
                transientRefreshSkips.add(account.index);
                lastError = fetchError;
                deps.debugLog("request fetch threw, trying next account", {
                    accountIndex: account.index,
                    message: fetchError.message,
                });
                continue;
            }

            if (!response.ok) {
                let errorBody: string | null = null;
                try {
                    errorBody = await response.clone().text();
                } catch {
                    // Ignore clone/read failures for best-effort diagnostics.
                }

                if (isAccountSpecificError(response.status, errorBody)) {
                    const reason = parseRateLimitReason(response.status, errorBody);
                    const retryAfterMs = parseRetryAfterHeader(response);
                    if (reason === "AUTH_FAILED") {
                        account.access = undefined;
                        account.expires = undefined;
                        markTokenStateUpdated(account);
                    }

                    deps.debugLog("account-specific error, switching account", {
                        accountIndex: account.index,
                        status: response.status,
                        reason,
                    });
                    accountManager.markRateLimited(account, reason, reason === "AUTH_FAILED" ? null : retryAfterMs);
                    transientRefreshSkips.add(account.index);
                    if (accountManager.getAccountCount() > 1) {
                        const name = account.email || `Account ${accountManager.getCurrentIndex() + 1}`;
                        const switchReason = formatSwitchReason(response.status, reason);
                        await deps.toast(`${name} ${switchReason}, switching account`, "warning", {
                            debounceKey: "account-switch",
                        });
                    }
                    continue;
                }

                if (response.status === 500 || response.status === 503 || response.status === 529) {
                    deps.debugLog("service-wide response error, attempting retry", {
                        status: response.status,
                    });
                    const retried = await retryServiceWideResponse({
                        response,
                        fetchInput,
                        requestHeaders,
                        requestInit: preparedRequest.requestInit,
                        requestContext: preparedRequest.requestContext,
                        forwardRequest: deps.forwardRequest,
                    });
                    if (!retried.ok) {
                        return finalizeResponse(retried);
                    }

                    response = retried;
                } else {
                    deps.debugLog("non-account-specific response error, returning directly", {
                        status: response.status,
                    });
                    return finalizeResponse(response);
                }
            }

            if (response.ok) {
                accountManager.markSuccess(account);
                triggerSessionSideEffects({
                    account,
                    accessToken,
                    requestUrl: preparedRequest.requestUrl,
                    requestMethod: preparedRequest.requestMethod,
                    body,
                    response,
                });
            }

            const finalizeCallbacks = buildFinalizeCallbacks(response, account, accountManager, deps.debugLog);
            return finalizeResponse(
                response,
                finalizeCallbacks.onUsage,
                finalizeCallbacks.onAccountError,
                finalizeCallbacks.onStreamError,
            );
        }

        if (lastError) {
            throw lastError;
        }

        throw new Error("All accounts exhausted — no account could serve this request");
    }

    return {
        executeOAuthFetch,
    };
}

export type RequestOrchestrationHelpers = ReturnType<typeof createRequestOrchestrationHelpers>;
