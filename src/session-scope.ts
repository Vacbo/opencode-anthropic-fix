import { randomUUID } from "node:crypto";

function readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractOpenCodeSessionKey(input: unknown): string | undefined {
    if (!input || typeof input !== "object") return undefined;
    const record = input as Record<string, unknown>;

    return (
        readString(record.sessionID) ||
        readString(record.sessionId) ||
        readString((record.path as Record<string, unknown> | undefined)?.id) ||
        readString((record.metadata as Record<string, unknown> | undefined)?.sessionID) ||
        readString((record.metadata as Record<string, unknown> | undefined)?.sessionId) ||
        readString((record.conversation as Record<string, unknown> | undefined)?.id) ||
        readString(
            (
                (record.conversation as Record<string, unknown> | undefined)?.metadata as
                    | Record<string, unknown>
                    | undefined
            )?.sessionID,
        ) ||
        readString(
            (
                (record.conversation as Record<string, unknown> | undefined)?.metadata as
                    | Record<string, unknown>
                    | undefined
            )?.sessionId,
        )
    );
}

export function createSessionScopeTracker() {
    const fallbackSessionId = randomUUID();
    const sessionIdsByKey = new Map<string, string>();
    let activeSessionKey: string | undefined;

    function observeHookInput(input: unknown): string | undefined {
        const key = extractOpenCodeSessionKey(input);
        if (!key) {
            return undefined;
        }

        activeSessionKey = key;
        if (!sessionIdsByKey.has(key)) {
            sessionIdsByKey.set(key, randomUUID());
        }

        return key;
    }

    function getCurrentSignatureSessionId(): string {
        if (!activeSessionKey) {
            return fallbackSessionId;
        }
        return sessionIdsByKey.get(activeSessionKey) ?? fallbackSessionId;
    }

    return {
        observeHookInput,
        getCurrentSignatureSessionId,
    };
}

export type SessionScopeTracker = ReturnType<typeof createSessionScopeTracker>;
