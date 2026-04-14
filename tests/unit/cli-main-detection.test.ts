import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { detectMain } from "../../src/cli";

describe("detectMain", () => {
    it("treats Bun entrypoints as direct execution", async () => {
        await expect(
            detectMain({
                argv1: "/tmp/not-the-entrypoint",
                importMetaMain: true,
                importMetaUrl: "file:///tmp/cli.ts",
            }),
        ).resolves.toBe(true);
    });

    it("detects matching argv paths when imported under Node-compatible runtimes", async () => {
        const cliUrl = pathToFileURL("/tmp/cli.ts").href;

        await expect(
            detectMain({
                argv1: "/tmp/cli.ts",
                importMetaMain: false,
                importMetaUrl: cliUrl,
            }),
        ).resolves.toBe(true);
    });
});
