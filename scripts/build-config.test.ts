import { describe, expect, it } from "vitest";

import {
    CLI_BINARY_TARGETS,
    getCliBinaryBuildArgs,
    getCliBinaryFilename,
    isTargetRunnableOnHost,
    parseBuildArguments,
    resolveCliBinaryTargets,
} from "./build-config";

describe("build-config", () => {
    it("defines the 11 standalone CLI targets", () => {
        expect(CLI_BINARY_TARGETS.map(({ id }) => id)).toEqual([
            "darwin-x64",
            "darwin-arm64",
            "linux-x64",
            "linux-x64-baseline",
            "linux-x64-modern",
            "linux-arm64",
            "linux-x64-musl",
            "linux-arm64-musl",
            "windows-x64",
            "windows-x64-baseline",
            "windows-x64-modern",
        ]);
    });

    it("keeps the default build bundle-only unless CLI binaries are requested", () => {
        expect(parseBuildArguments([])).toEqual({ buildCliBinaries: false, cliBinaryTargets: [] });
    });

    it("resolves deduplicated target selections from comma-separated flags", () => {
        const result = parseBuildArguments(["--cli-binaries", "--targets=linux-x64,windows-x64", "--target=linux-x64"]);

        expect(result.buildCliBinaries).toBe(true);
        expect(result.cliBinaryTargets.map(({ id }) => id)).toEqual(["linux-x64", "windows-x64"]);
    });

    it("adds the .exe suffix only for Windows binaries", () => {
        expect(getCliBinaryFilename({ id: "linux-x64", platform: "linux" })).toBe("opencode-anthropic-auth-linux-x64");
        expect(getCliBinaryFilename({ id: "windows-x64", platform: "windows" })).toBe(
            "opencode-anthropic-auth-windows-x64.exe",
        );
    });

    it("builds Bun compile args per target", () => {
        const windowsTarget = resolveCliBinaryTargets(["windows-x64-modern"])[0];

        expect(getCliBinaryBuildArgs(windowsTarget)).toEqual([
            "build",
            "--compile",
            "--target=bun-windows-x64-modern",
            "src/cli.ts",
            "--outfile",
            "dist/opencode-anthropic-auth-windows-x64-modern.exe",
        ]);
    });

    it("rejects unknown target ids", () => {
        expect(() => resolveCliBinaryTargets(["plan9-x64"])).toThrowError(/Unknown CLI binary target 'plan9-x64'/);
    });

    describe("isTargetRunnableOnHost", () => {
        const darwin = { platform: "darwin" } as const;
        const linux = { platform: "linux" } as const;
        const win32 = { platform: "win32" } as const;

        it("runs darwin targets only on darwin hosts", () => {
            expect(isTargetRunnableOnHost({ platform: "darwin" }, darwin)).toBe(true);
            expect(isTargetRunnableOnHost({ platform: "darwin" }, linux)).toBe(false);
            expect(isTargetRunnableOnHost({ platform: "darwin" }, win32)).toBe(false);
        });

        it("runs windows targets only on win32 hosts", () => {
            expect(isTargetRunnableOnHost({ platform: "windows" }, win32)).toBe(true);
            expect(isTargetRunnableOnHost({ platform: "windows" }, linux)).toBe(false);
            expect(isTargetRunnableOnHost({ platform: "windows" }, darwin)).toBe(false);
        });

        it("runs glibc linux targets on linux hosts", () => {
            expect(isTargetRunnableOnHost({ platform: "linux", libc: "glibc" }, linux)).toBe(true);
            expect(isTargetRunnableOnHost({ platform: "linux" }, linux)).toBe(true);
        });

        it("refuses to run musl linux targets on linux hosts (glibc assumed on CI)", () => {
            expect(isTargetRunnableOnHost({ platform: "linux", libc: "musl" }, linux)).toBe(false);
        });

        it("classifies every CLI_BINARY_TARGETS entry for a linux host", () => {
            const runnable = CLI_BINARY_TARGETS.filter((target) => isTargetRunnableOnHost(target, linux)).map(
                ({ id }) => id,
            );
            expect(runnable).toEqual(["linux-x64", "linux-x64-baseline", "linux-x64-modern", "linux-arm64"]);
        });
    });
});
