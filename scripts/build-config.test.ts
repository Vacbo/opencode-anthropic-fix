import { describe, expect, it } from "vitest";

import {
    CLI_BINARY_TARGETS,
    getCliBinaryBuildArgs,
    getCliBinaryFilename,
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
});
