import { describe, expect, it } from "vitest";

import { buildRequestMetadata, getAccountIdentifier } from "../../../src/request/metadata.js";

describe("request/metadata", () => {
    it("prefers accountUuid over synthetic account id", () => {
        expect(
            getAccountIdentifier({
                id: "cc-cc-keychain-123:sk-ant-ort01",
                accountUuid: "7b3c6eea-69cf-4d2e-a649-9f0745ce6633",
            }),
        ).toBe("7b3c6eea-69cf-4d2e-a649-9f0745ce6633");
    });

    it("falls back to account id when no uuid is available", () => {
        expect(getAccountIdentifier({ id: "cc-cc-keychain-123:sk-ant-ort01" })).toBe("cc-cc-keychain-123:sk-ant-ort01");
    });

    it("builds metadata.user_id with the resolved uuid source", () => {
        const metadata = buildRequestMetadata({
            persistentUserId: "device-1",
            accountId: "7b3c6eea-69cf-4d2e-a649-9f0745ce6633",
            sessionId: "session-1",
        });

        expect(metadata.user_id).toBe(
            JSON.stringify({
                device_id: "device-1",
                account_uuid: "7b3c6eea-69cf-4d2e-a649-9f0745ce6633",
                session_id: "session-1",
            }),
        );
    });
});
