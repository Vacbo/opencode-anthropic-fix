// Characterization tests for extractOpenCodeSessionKey (src/session-scope.ts).
//
// Locks the 7-path precedence order so future hook schema changes in OpenCode
// or refactors of session-scope.ts cannot silently shift which key wins.
//
// Precedence (top-to-bottom per readString + `||` chain):
//   1. record.sessionID
//   2. record.sessionId
//   3. record.path.id
//   4. record.metadata.sessionID
//   5. record.metadata.sessionId
//   6. record.conversation.id
//   7. record.conversation.metadata.sessionID / sessionId

import { describe, expect, it } from "vitest";
import { createSessionScopeTracker, extractOpenCodeSessionKey } from "../../src/session-scope.js";

describe("extractOpenCodeSessionKey", () => {
    it("returns undefined for non-object inputs", () => {
        expect(extractOpenCodeSessionKey(null)).toBeUndefined();
        expect(extractOpenCodeSessionKey(undefined)).toBeUndefined();
        expect(extractOpenCodeSessionKey("sess-abc")).toBeUndefined();
        expect(extractOpenCodeSessionKey(42)).toBeUndefined();
    });

    it("returns undefined for an empty object", () => {
        expect(extractOpenCodeSessionKey({})).toBeUndefined();
    });

    it("ignores non-string and blank string values", () => {
        expect(extractOpenCodeSessionKey({ sessionID: "" })).toBeUndefined();
        expect(extractOpenCodeSessionKey({ sessionID: "   " })).toBeUndefined();
        expect(extractOpenCodeSessionKey({ sessionID: 123 })).toBeUndefined();
    });

    it("trims whitespace around the resolved value", () => {
        expect(extractOpenCodeSessionKey({ sessionID: "  sess-1  " })).toBe("sess-1");
    });

    it("prefers sessionID over sessionId (path 1 > path 2)", () => {
        expect(extractOpenCodeSessionKey({ sessionID: "primary", sessionId: "secondary" })).toBe("primary");
    });

    it("falls through from sessionID to sessionId when sessionID is missing", () => {
        expect(extractOpenCodeSessionKey({ sessionId: "camel-case" })).toBe("camel-case");
    });

    it("prefers sessionId over path.id (path 2 > path 3)", () => {
        expect(extractOpenCodeSessionKey({ sessionId: "two", path: { id: "three" } })).toBe("two");
    });

    it("falls through to path.id when top-level session keys are absent", () => {
        expect(extractOpenCodeSessionKey({ path: { id: "path-id" } })).toBe("path-id");
    });

    it("prefers path.id over metadata.sessionID (path 3 > path 4)", () => {
        expect(
            extractOpenCodeSessionKey({
                path: { id: "p" },
                metadata: { sessionID: "m" },
            }),
        ).toBe("p");
    });

    it("falls through to metadata.sessionID when upstream keys are missing", () => {
        expect(extractOpenCodeSessionKey({ metadata: { sessionID: "meta-upper" } })).toBe("meta-upper");
    });

    it("prefers metadata.sessionID over metadata.sessionId (path 4 > path 5)", () => {
        expect(
            extractOpenCodeSessionKey({
                metadata: { sessionID: "upper", sessionId: "lower" },
            }),
        ).toBe("upper");
    });

    it("falls through to metadata.sessionId when metadata.sessionID is missing", () => {
        expect(extractOpenCodeSessionKey({ metadata: { sessionId: "meta-camel" } })).toBe("meta-camel");
    });

    it("prefers metadata keys over conversation.id (path 5 > path 6)", () => {
        expect(
            extractOpenCodeSessionKey({
                metadata: { sessionId: "meta" },
                conversation: { id: "conv" },
            }),
        ).toBe("meta");
    });

    it("falls through to conversation.id when no metadata keys resolve", () => {
        expect(extractOpenCodeSessionKey({ conversation: { id: "conv-id" } })).toBe("conv-id");
    });

    it("prefers conversation.id over conversation.metadata.sessionID (path 6 > path 7)", () => {
        expect(
            extractOpenCodeSessionKey({
                conversation: { id: "conv-root", metadata: { sessionID: "conv-meta" } },
            }),
        ).toBe("conv-root");
    });

    it("resolves conversation.metadata.sessionID as the 7th path", () => {
        expect(
            extractOpenCodeSessionKey({
                conversation: { metadata: { sessionID: "deep" } },
            }),
        ).toBe("deep");
    });

    it("falls through from conversation.metadata.sessionID to .sessionId", () => {
        expect(
            extractOpenCodeSessionKey({
                conversation: { metadata: { sessionId: "deep-camel" } },
            }),
        ).toBe("deep-camel");
    });

    it("prefers conversation.metadata.sessionID over .sessionId", () => {
        expect(
            extractOpenCodeSessionKey({
                conversation: { metadata: { sessionID: "upper", sessionId: "lower" } },
            }),
        ).toBe("upper");
    });

    it("returns undefined when every path is present but blank", () => {
        expect(
            extractOpenCodeSessionKey({
                sessionID: "",
                sessionId: "   ",
                path: { id: "" },
                metadata: { sessionID: "", sessionId: "" },
                conversation: { id: "", metadata: { sessionID: "", sessionId: "" } },
            }),
        ).toBeUndefined();
    });
});

describe("createSessionScopeTracker", () => {
    it("returns the fallback signature session id before any hook input", () => {
        const tracker = createSessionScopeTracker();
        const id = tracker.getCurrentSignatureSessionId();
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(tracker.getCurrentSignatureSessionId()).toBe(id);
    });

    it("assigns a stable signature id per observed session key", () => {
        const tracker = createSessionScopeTracker();

        expect(tracker.observeHookInput({ sessionID: "sess-A" })).toBe("sess-A");
        const first = tracker.getCurrentSignatureSessionId();

        tracker.observeHookInput({ sessionID: "sess-A" });
        expect(tracker.getCurrentSignatureSessionId()).toBe(first);

        tracker.observeHookInput({ sessionID: "sess-B" });
        const second = tracker.getCurrentSignatureSessionId();
        expect(second).not.toBe(first);

        tracker.observeHookInput({ sessionID: "sess-A" });
        expect(tracker.getCurrentSignatureSessionId()).toBe(first);
    });

    it("returns undefined and does not mutate active state when the hook input has no session key", () => {
        const tracker = createSessionScopeTracker();
        tracker.observeHookInput({ sessionID: "sess-A" });
        const active = tracker.getCurrentSignatureSessionId();

        expect(tracker.observeHookInput({})).toBeUndefined();
        expect(tracker.getCurrentSignatureSessionId()).toBe(active);
    });
});
