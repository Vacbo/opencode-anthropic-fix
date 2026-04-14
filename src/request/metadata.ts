// ---------------------------------------------------------------------------
// Request metadata helpers
// ---------------------------------------------------------------------------

import type { RequestBodyMetadata, RequestMetadata } from "../types.js";

export function extractFileIds(parsed: unknown): string[] {
    if (!parsed || typeof parsed !== "object") return [];
    const obj = parsed as Record<string, unknown>;

    const ids: string[] = [];

    const collectFromContent = (content: unknown): void => {
        if (!Array.isArray(content)) return;
        for (const block of content) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            if ((b.type === "document" || b.type === "file") && b.source && typeof b.source === "object") {
                const src = b.source as Record<string, unknown>;
                if (typeof src.file_id === "string") {
                    ids.push(src.file_id);
                }
            }
        }
    };

    if (Array.isArray(obj.messages)) {
        for (const msg of obj.messages) {
            if (!msg || typeof msg !== "object") continue;
            collectFromContent((msg as Record<string, unknown>).content);
        }
    }

    if (Array.isArray(obj.system)) {
        collectFromContent(obj.system);
    }

    return ids;
}

export function parseRequestBodyMetadata(
    body: string | undefined,
    debugLog?: (...args: unknown[]) => void,
): RequestBodyMetadata {
    if (!body || typeof body !== "string") {
        return { model: "", tools: [], messages: [], hasFileReferences: false, hasDeferredToolLoading: false };
    }

    try {
        const parsed = JSON.parse(body);
        const model = typeof parsed?.model === "string" ? parsed.model : "";
        const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const hasFileReferences = extractFileIds(parsed).length > 0;
        const hasDeferredToolLoading = tools.some(
            (tool: unknown) =>
                tool && typeof tool === "object" && (tool as { defer_loading?: unknown }).defer_loading === true,
        );
        return { model, tools, messages, hasFileReferences, hasDeferredToolLoading };
    } catch (err) {
        debugLog?.("extractFileIds failed:", (err as Error).message);
        return { model: "", tools: [], messages: [], hasFileReferences: false, hasDeferredToolLoading: false };
    }
}

export function getAccountIdentifier(account: { id?: string; accountUuid?: string } | null | undefined): string {
    // Prefer env-provided account UUID (v2.1.51+), then account record fields
    const envUuid = process.env.CLAUDE_CODE_ACCOUNT_UUID?.trim();
    if (envUuid) return envUuid;
    if (account?.accountUuid && typeof account.accountUuid === "string") {
        return account.accountUuid;
    }
    if (account?.id && typeof account.id === "string") {
        return account.id;
    }
    return "";
}

export function buildRequestMetadata(input: {
    persistentUserId: string;
    accountId: string;
    sessionId: string;
}): RequestMetadata {
    const metadata: RequestMetadata = {
        user_id: JSON.stringify({
            device_id: input.persistentUserId,
            account_uuid: input.accountId,
            session_id: input.sessionId,
        }),
    };

    const userEmail = process.env.CLAUDE_CODE_USER_EMAIL?.trim();
    if (userEmail) metadata.user_email = userEmail;

    return metadata;
}
