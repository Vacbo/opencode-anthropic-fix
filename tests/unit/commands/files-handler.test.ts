import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("node:fs", () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
}));

import { AccountManager, type ManagedAccount } from "../../../src/accounts.js";
import { FILES_API_BETA_FLAG } from "../../../src/constants.js";
import {
    capFileAccountMap,
    FILE_ACCOUNT_MAP_MAX_SIZE,
    handleFilesCommand,
} from "../../../src/commands/handlers/files.js";
import { DEFAULT_CONFIG } from "../../../src/config.js";

const mockExistsSync = existsSync as Mock;
const mockReadFileSync = readFileSync as Mock;
const mockWriteFileSync = writeFileSync as Mock;

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
    return {
        id: "acct-1",
        index: 0,
        email: "user@example.com",
        refreshToken: "refresh-token",
        access: "access-token",
        expires: Date.now() + 60 * 60 * 1000,
        tokenUpdatedAt: Date.now(),
        addedAt: Date.now(),
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        stats: {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            lastReset: 0,
        },
        source: "oauth",
        ...overrides,
    };
}

function createAccountManager(account: ManagedAccount): AccountManager {
    const manager = new AccountManager(DEFAULT_CONFIG);
    Object.defineProperties(manager, {
        getAccountCount: { value: () => 1 },
        getEnabledAccounts: { value: () => [account] },
        getCurrentAccount: { value: () => account },
    });
    return manager;
}

function createDeps(account: ManagedAccount) {
    return {
        sendCommandMessage: vi.fn().mockResolvedValue(undefined),
        accountManager: createAccountManager(account),
        fileAccountMap: new Map<string, number>(),
        refreshAccountTokenSingleFlight: vi.fn().mockResolvedValue("refreshed-access-token"),
    };
}

function jsonResponse(payload: unknown, init: { ok?: boolean; status?: number } = {}): Response {
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        json: () => Promise.resolve(payload),
        text: () => Promise.resolve(JSON.stringify(payload)),
    } as unknown as Response;
}

function textResponse(body: string, init: { ok?: boolean; status?: number } = {}): Response {
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        text: () => Promise.resolve(body),
    } as unknown as Response;
}

function binaryResponse(body: Uint8Array, init: { ok?: boolean; status?: number } = {}): Response {
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        arrayBuffer: () => Promise.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
        text: () => Promise.resolve(""),
    } as unknown as Response;
}

describe("handleFilesCommand", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        const fetchMock = vi.fn();
        global.fetch = Object.assign(fetchMock, { preconnect: vi.fn() }) as typeof fetch;
    });

    it("lists files for the current account and pins each file id", async () => {
        const account = makeAccount();
        const deps = createDeps(account);
        const fetchMock = global.fetch as unknown as Mock;
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                data: [{ id: "file_1", filename: "report.pdf", size: 2048, purpose: "assistants" }],
            }),
        );

        await handleFilesCommand("sess-1", ["files", "list", "--account", "user@example.com"], deps);

        expect(fetchMock).toHaveBeenCalledWith("https://api.anthropic.com/v1/files", {
            headers: {
                authorization: "Bearer access-token",
                "anthropic-beta": `oauth-2025-04-20,${FILES_API_BETA_FLAG}`,
            },
        });
        expect(deps.fileAccountMap.get("file_1")).toBe(0);
        expect(deps.sendCommandMessage).toHaveBeenCalledWith(
            "sess-1",
            expect.stringContaining("report.pdf"),
        );
    });

    it("uploads a file with multipart form data and records the owning account", async () => {
        const account = makeAccount();
        const deps = createDeps(account);
        const fetchMock = global.fetch as unknown as Mock;
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(Buffer.from("hello"));
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: "file_up", filename: "notes.txt", size: 5 }));

        await handleFilesCommand("sess-1", ["files", "upload", "notes.txt"], deps);

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe("POST");
        expect(init.body).toBeInstanceOf(FormData);
        expect(deps.fileAccountMap.get("file_up")).toBe(0);
        expect(deps.sendCommandMessage).toHaveBeenCalledWith(
            "sess-1",
            expect.stringContaining("Uploaded: file_up"),
        );
    });

    it("gets file metadata for the selected file id", async () => {
        const account = makeAccount();
        const deps = createDeps(account);
        const fetchMock = global.fetch as unknown as Mock;
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                id: "file_meta",
                filename: "meta.json",
                purpose: "assistants",
                size: 1024,
                mime_type: "application/json",
                created_at: "2026-04-16T00:00:00Z",
            }),
        );

        await handleFilesCommand("sess-1", ["files", "get", "file_meta"], deps);

        expect(fetchMock).toHaveBeenCalledWith("https://api.anthropic.com/v1/files/file_meta", {
            headers: {
                authorization: "Bearer access-token",
                "anthropic-beta": `oauth-2025-04-20,${FILES_API_BETA_FLAG}`,
            },
        });
        expect(deps.fileAccountMap.get("file_meta")).toBe(0);
        expect(deps.sendCommandMessage).toHaveBeenCalledWith(
            "sess-1",
            expect.stringContaining("Filename: meta.json"),
        );
    });

    it("deletes a file and removes its account pin", async () => {
        const account = makeAccount();
        const deps = createDeps(account);
        deps.fileAccountMap.set("file_dead", 0);
        const fetchMock = global.fetch as unknown as Mock;
        fetchMock.mockResolvedValueOnce(textResponse("", { ok: true, status: 200 }));

        await handleFilesCommand("sess-1", ["files", "delete", "file_dead"], deps);

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe("DELETE");
        expect(deps.fileAccountMap.has("file_dead")).toBe(false);
        expect(deps.sendCommandMessage).toHaveBeenCalledWith(
            "sess-1",
            "▣ Anthropic Files [user@example.com]\n\nDeleted: file_dead",
        );
    });

    it("resolveTargetAccount: dispatches unknown --account identifier as an error without calling the network", async () => {
        const account = makeAccount();
        const deps = createDeps(account);
        const fetchMock = global.fetch as unknown as Mock;

        await handleFilesCommand("sess-1", ["files", "list", "--account", "ghost@example.com"], deps);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(deps.sendCommandMessage).toHaveBeenCalledWith(
            "sess-1",
            expect.stringContaining("not found"),
        );
    });

    it("downloads file content and writes it to the requested output path", async () => {
        const account = makeAccount();
        const deps = createDeps(account);
        const fetchMock = global.fetch as unknown as Mock;
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ filename: "report.csv" }))
            .mockResolvedValueOnce(binaryResponse(new Uint8Array([65, 66, 67])));

        await handleFilesCommand("sess-1", ["files", "download", "file_dl", "out/report.csv"], deps);

        expect(fetchMock).toHaveBeenNthCalledWith(1, "https://api.anthropic.com/v1/files/file_dl", expect.any(Object));
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "https://api.anthropic.com/v1/files/file_dl/content",
            expect.any(Object),
        );
        expect(mockWriteFileSync).toHaveBeenCalledWith(resolve("out/report.csv"), Buffer.from([65, 66, 67]));
        expect(deps.sendCommandMessage).toHaveBeenCalledWith(
            "sess-1",
            expect.stringContaining(`Saved to: ${resolve("out/report.csv")}`),
        );
    });
});

describe("capFileAccountMap", () => {
    it("inserts new bindings without touching existing ones while under the cap", () => {
        const map = new Map<string, number>();
        capFileAccountMap(map, "file_a", 0);
        capFileAccountMap(map, "file_b", 1);

        expect(map.get("file_a")).toBe(0);
        expect(map.get("file_b")).toBe(1);
        expect(map.size).toBe(2);
    });

    it("overwrites the account index for an existing file id without evicting others", () => {
        const map = new Map<string, number>();
        capFileAccountMap(map, "file_a", 0);
        capFileAccountMap(map, "file_b", 1);
        capFileAccountMap(map, "file_b", 2);

        expect(map.get("file_a")).toBe(0);
        expect(map.get("file_b")).toBe(2);
        expect(map.size).toBe(2);
    });

    it("evicts the oldest entry in insertion order when the cap is reached (FIFO)", () => {
        const map = new Map<string, number>();
        for (let i = 0; i < FILE_ACCOUNT_MAP_MAX_SIZE; i++) {
            capFileAccountMap(map, `file_${i}`, i);
        }
        expect(map.size).toBe(FILE_ACCOUNT_MAP_MAX_SIZE);
        expect(map.has("file_0")).toBe(true);

        capFileAccountMap(map, "file_overflow", 999);

        expect(map.size).toBe(FILE_ACCOUNT_MAP_MAX_SIZE);
        expect(map.has("file_0")).toBe(false);
        expect(map.has("file_overflow")).toBe(true);
        expect(map.get("file_overflow")).toBe(999);

        capFileAccountMap(map, "file_overflow_2", 1000);
        expect(map.has("file_1")).toBe(false);
        expect(map.has("file_overflow")).toBe(true);
        expect(map.has("file_overflow_2")).toBe(true);
        expect(map.size).toBe(FILE_ACCOUNT_MAP_MAX_SIZE);
    });

    it("pins FILE_ACCOUNT_MAP_MAX_SIZE at 1000 so long sessions stay bounded", () => {
        expect(FILE_ACCOUNT_MAP_MAX_SIZE).toBe(1000);
    });
});
