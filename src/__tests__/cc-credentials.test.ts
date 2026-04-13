import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("node:child_process", () => ({
    execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
    readFileSync: vi.fn(),
}));

vi.mock("node:os", () => ({
    homedir: vi.fn(() => "/mock-home"),
}));

import type { CCCredential } from "../cc-credentials.js";
import {
    parseCCCredentialData,
    readCCCredentials,
    readCCCredentialsFromFile,
    readCCCredentialsFromKeychain,
} from "../cc-credentials.js";

const mockExecSync = execSync as Mock;
const mockReadFileSync = readFileSync as Mock;
const mockHomedir = homedir as Mock;
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", {
        value: platform,
        configurable: true,
    });
}

function restorePlatform(): void {
    if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
}

function makeWrappedCredential(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        claudeAiOauth: {
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresAt: 1_700_000_000_000,
            subscriptionType: "max",
            ...overrides,
        },
    });
}

function makeFlatCredential(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        accessToken: "flat-access",
        refreshToken: "flat-refresh",
        expiresAt: 1_800_000_000_000,
        subscriptionType: "pro",
        ...overrides,
    });
}

function makeSecurityError(status?: number, code?: string): Error {
    const error = new Error("security failed") as Error & { status?: number; code?: string };
    error.status = status;
    error.code = code;
    return error;
}

describe("parseCCCredentialData", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockHomedir.mockReturnValue("/mock-home");
        restorePlatform();
    });

    afterEach(() => {
        restorePlatform();
    });

    it("parses wrapped Claude Code credentials", () => {
        expect(parseCCCredentialData(makeWrappedCredential())).toEqual({
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresAt: 1_700_000_000_000,
            subscriptionType: "max",
            source: "cc-file",
            label: "/mock-home/.claude/.credentials.json",
        });
    });

    it("parses flat credential format", () => {
        expect(parseCCCredentialData(makeFlatCredential())).toEqual({
            accessToken: "flat-access",
            refreshToken: "flat-refresh",
            expiresAt: 1_800_000_000_000,
            subscriptionType: "pro",
            source: "cc-file",
            label: "/mock-home/.claude/.credentials.json",
        });
    });

    it("filters MCP-only payloads", () => {
        expect(parseCCCredentialData(JSON.stringify({ mcpOAuth: { accessToken: "mcp-only" } }))).toBeNull();
    });

    it("returns null for malformed JSON", () => {
        expect(parseCCCredentialData("not-json")).toBeNull();
    });
});

describe("readCCCredentialsFromKeychain", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockHomedir.mockReturnValue("/mock-home");
        setPlatform("darwin");
    });

    afterEach(() => {
        restorePlatform();
    });

    it("reads multiple Claude Code services from macOS Keychain", () => {
        mockExecSync.mockImplementation((command: string) => {
            if (command === "security dump-keychain") {
                return [
                    '    "svce"<blob>="Claude Code-credentials"',
                    '    "svce"<blob>="Claude Code-credentials-abc123"',
                    '    "svce"<blob>="ignored-service"',
                ].join("\n");
            }

            if (command === "security find-generic-password -s 'Claude Code-credentials' -w") {
                return makeWrappedCredential();
            }

            if (command === "security find-generic-password -s 'Claude Code-credentials-abc123' -w") {
                return makeFlatCredential({
                    accessToken: "access-2",
                    refreshToken: "refresh-2",
                    subscriptionType: "team",
                });
            }

            throw new Error(`unexpected command: ${command}`);
        });

        expect(readCCCredentialsFromKeychain()).toEqual<CCCredential[]>([
            {
                accessToken: "access-token",
                refreshToken: "refresh-token",
                expiresAt: 1_700_000_000_000,
                subscriptionType: "max",
                source: "cc-keychain",
                label: "Claude Code-credentials",
            },
            {
                accessToken: "access-2",
                refreshToken: "refresh-2",
                expiresAt: 1_800_000_000_000,
                subscriptionType: "team",
                source: "cc-keychain",
                label: "Claude Code-credentials-abc123",
            },
        ]);

        expect(mockExecSync).toHaveBeenCalledWith("security dump-keychain", {
            encoding: "utf-8",
            timeout: 5000,
        });
    });

    it.each([44, 36, 128])("returns null for handled security exit code %i", (status) => {
        mockExecSync.mockImplementation((command: string) => {
            if (command === "security dump-keychain") {
                throw makeSecurityError(status);
            }
            return "";
        });

        expect(readCCCredentialsFromKeychain()).toBeNull();
    });

    it("returns null when security command times out", () => {
        mockExecSync.mockImplementation((command: string) => {
            if (command === "security dump-keychain") {
                throw makeSecurityError(undefined, "ETIMEDOUT");
            }
            return "";
        });

        expect(readCCCredentialsFromKeychain()).toBeNull();
    });

    it("returns null when a service payload is missing usable Claude credentials", () => {
        mockExecSync.mockImplementation((command: string) => {
            if (command === "security dump-keychain") {
                return '    "svce"<blob>="Claude Code-credentials"';
            }

            if (command === "security find-generic-password -s 'Claude Code-credentials' -w") {
                return JSON.stringify({ mcpOAuth: { accessToken: "mcp-only" } });
            }

            throw new Error(`unexpected command: ${command}`);
        });

        expect(readCCCredentialsFromKeychain()).toBeNull();
    });
});

describe("readCCCredentialsFromFile", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockHomedir.mockReturnValue("/mock-home");
        restorePlatform();
    });

    afterEach(() => {
        restorePlatform();
    });

    it("reads wrapped credentials from ~/.claude/.credentials.json", () => {
        mockReadFileSync.mockReturnValue(makeWrappedCredential());

        expect(readCCCredentialsFromFile()).toEqual<CCCredential>({
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresAt: 1_700_000_000_000,
            subscriptionType: "max",
            source: "cc-file",
            label: "/mock-home/.claude/.credentials.json",
        });
    });

    it("reads flat credentials from ~/.claude/.credentials.json", () => {
        mockReadFileSync.mockReturnValue(makeFlatCredential());

        expect(readCCCredentialsFromFile()).toEqual<CCCredential>({
            accessToken: "flat-access",
            refreshToken: "flat-refresh",
            expiresAt: 1_800_000_000_000,
            subscriptionType: "pro",
            source: "cc-file",
            label: "/mock-home/.claude/.credentials.json",
        });
    });

    it("returns null when the credentials file is missing", () => {
        const error = new Error("missing") as Error & { code?: string };
        error.code = "ENOENT";
        mockReadFileSync.mockImplementation(() => {
            throw error;
        });

        expect(readCCCredentialsFromFile()).toBeNull();
    });

    it("returns null when the file is malformed", () => {
        mockReadFileSync.mockReturnValue("not-json");

        expect(readCCCredentialsFromFile()).toBeNull();
    });
});

describe("readCCCredentials", () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mockHomedir.mockReturnValue("/mock-home");
    });

    afterEach(() => {
        restorePlatform();
    });

    it("skips Keychain on non-macOS platforms and still reads the file", () => {
        setPlatform("linux");
        mockReadFileSync.mockReturnValue(makeFlatCredential());

        expect(readCCCredentials()).toEqual<CCCredential[]>([
            {
                accessToken: "flat-access",
                refreshToken: "flat-refresh",
                expiresAt: 1_800_000_000_000,
                subscriptionType: "pro",
                source: "cc-file",
                label: "/mock-home/.claude/.credentials.json",
            },
        ]);
        expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("combines Keychain and file credentials on macOS", () => {
        setPlatform("darwin");
        mockExecSync.mockImplementation((command: string) => {
            if (command === "security dump-keychain") {
                return '    "svce"<blob>="Claude Code-credentials"';
            }

            if (command === "security find-generic-password -s 'Claude Code-credentials' -w") {
                return makeWrappedCredential();
            }

            throw new Error(`unexpected command: ${command}`);
        });
        mockReadFileSync.mockReturnValue(makeFlatCredential());

        expect(readCCCredentials()).toEqual<CCCredential[]>([
            {
                accessToken: "access-token",
                refreshToken: "refresh-token",
                expiresAt: 1_700_000_000_000,
                subscriptionType: "max",
                source: "cc-keychain",
                label: "Claude Code-credentials",
            },
            {
                accessToken: "flat-access",
                refreshToken: "flat-refresh",
                expiresAt: 1_800_000_000_000,
                subscriptionType: "pro",
                source: "cc-file",
                label: "/mock-home/.claude/.credentials.json",
            },
        ]);
    });
});
