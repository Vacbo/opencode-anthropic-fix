import { join } from "node:path";

export const DIST_DIR = "dist";
export const PLUGIN_OUTFILE = join(DIST_DIR, "opencode-anthropic-auth-plugin.mjs");
export const CLI_BUNDLE_OUTFILE = join(DIST_DIR, "opencode-anthropic-auth-cli.mjs");
export const CLI_ENTRYPOINT = "src/cli.ts";

export type CliBinaryTargetId =
    | "darwin-x64"
    | "darwin-arm64"
    | "linux-x64"
    | "linux-x64-baseline"
    | "linux-x64-modern"
    | "linux-arm64"
    | "linux-x64-musl"
    | "linux-arm64-musl"
    | "windows-x64"
    | "windows-x64-baseline"
    | "windows-x64-modern";

export type CliBinaryTarget = {
    id: CliBinaryTargetId;
    bunTarget: `bun-${string}`;
    platform: "darwin" | "linux" | "windows";
};

export const CLI_BINARY_TARGETS: readonly CliBinaryTarget[] = [
    { id: "darwin-x64", bunTarget: "bun-darwin-x64", platform: "darwin" },
    { id: "darwin-arm64", bunTarget: "bun-darwin-arm64", platform: "darwin" },
    { id: "linux-x64", bunTarget: "bun-linux-x64", platform: "linux" },
    { id: "linux-x64-baseline", bunTarget: "bun-linux-x64-baseline", platform: "linux" },
    { id: "linux-x64-modern", bunTarget: "bun-linux-x64-modern", platform: "linux" },
    { id: "linux-arm64", bunTarget: "bun-linux-arm64", platform: "linux" },
    { id: "linux-x64-musl", bunTarget: "bun-linux-x64-musl", platform: "linux" },
    { id: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", platform: "linux" },
    { id: "windows-x64", bunTarget: "bun-windows-x64", platform: "windows" },
    { id: "windows-x64-baseline", bunTarget: "bun-windows-x64-baseline", platform: "windows" },
    { id: "windows-x64-modern", bunTarget: "bun-windows-x64-modern", platform: "windows" },
] as const;

const CLI_BINARY_TARGETS_BY_ID = new Map(CLI_BINARY_TARGETS.map((target) => [target.id, target]));

export function parseCliBinaryTargetArgs(argv: readonly string[]) {
    const requestedTargetIds: string[] = [];

    for (const arg of argv) {
        if (arg.startsWith("--targets=")) {
            requestedTargetIds.push(...splitTargetList(arg.slice("--targets=".length)));
            continue;
        }

        if (arg.startsWith("--target=")) {
            requestedTargetIds.push(arg.slice("--target=".length));
            continue;
        }
    }

    return requestedTargetIds;
}

export function resolveCliBinaryTargets(requestedTargetIds: readonly string[] = []) {
    if (requestedTargetIds.length === 0) {
        return [...CLI_BINARY_TARGETS];
    }

    const targets: CliBinaryTarget[] = [];

    for (const targetId of requestedTargetIds) {
        const target = CLI_BINARY_TARGETS_BY_ID.get(targetId as CliBinaryTargetId);

        if (!target) {
            const supportedTargets = CLI_BINARY_TARGETS.map(({ id }) => id).join(", ");
            throw new Error(`Unknown CLI binary target '${targetId}'. Supported targets: ${supportedTargets}`);
        }

        if (!targets.some(({ id }) => id === target.id)) {
            targets.push(target);
        }
    }

    return targets;
}

export function parseBuildArguments(argv: readonly string[]) {
    const requestedTargetIds = parseCliBinaryTargetArgs(argv);
    let buildCliBinaries = requestedTargetIds.length > 0;

    for (const arg of argv) {
        if (arg === "--cli-binaries") {
            buildCliBinaries = true;
            continue;
        }

        if (arg.startsWith("--target=") || arg.startsWith("--targets=")) {
            continue;
        }

        throw new Error(`Unknown build flag '${arg}'. Supported flags: --cli-binaries, --target=..., --targets=...`);
    }

    return {
        buildCliBinaries,
        cliBinaryTargets: buildCliBinaries ? resolveCliBinaryTargets(requestedTargetIds) : [],
    };
}

export function getCliBinaryFilename(target: Pick<CliBinaryTarget, "id" | "platform">) {
    return `opencode-anthropic-auth-${target.id}${target.platform === "windows" ? ".exe" : ""}`;
}

export function getCliBinaryOutfile(target: Pick<CliBinaryTarget, "id" | "platform">) {
    return join(DIST_DIR, getCliBinaryFilename(target));
}

export function getCliBinaryBuildArgs(target: CliBinaryTarget) {
    return [
        "build",
        "--compile",
        `--target=${target.bunTarget}`,
        CLI_ENTRYPOINT,
        "--outfile",
        getCliBinaryOutfile(target),
    ];
}

function splitTargetList(value: string) {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}
