#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    loadScenarioDefinitions,
    normalizeStoredCapture,
    selectCaptureForScenario,
    type CaptureRecord,
    type ScenarioDefinition,
} from "../verification/run-live-verification.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIO_DIR = resolve(SCRIPT_DIR, "../verification/scenarios");

export interface NormalizeHarArgs {
    harPath: string;
    outPath?: string;
    scenarioId?: string;
    scenarioDir: string;
    hostContains?: string;
    pathContains?: string;
    promptContains?: string;
    selectLast: boolean;
    help: boolean;
}

interface HarHeader {
    name?: string;
    value?: string;
}

interface HarPostData {
    text?: string;
}

interface HarRequest {
    method?: string;
    url?: string;
    headers?: HarHeader[];
    postData?: HarPostData;
}

interface HarEntry {
    startedDateTime?: string;
    request?: HarRequest;
}

interface HarFile {
    log?: {
        entries?: HarEntry[];
    };
}

function printUsage(): void {
    console.log(`Usage: bun scripts/proxyman/normalize-har.ts --har <path> [--out <path>] [--scenario <id>]

Normalizes a Proxyman HAR export into the verifier's CaptureRecord format.

Options:
  --har <path>               Input HAR file exported from Proxyman
  --out <path>               Output JSON capture artifact path
  --scenario <id>            Scenario ID from scripts/verification/scenarios
  --scenario-dir <path>      Scenario definition directory
                             Default: scripts/verification/scenarios
  --host-contains <value>    Require URL host to include this substring
  --path-contains <value>    Require path to include this substring
  --prompt-contains <value>  Require body text to include this substring
  --select-last              Pick the last matching capture instead of the first
  --help                     Show this help message
`);
}

export function parseArgs(args: string[]): NormalizeHarArgs {
    let harPath = "";
    let outPath: string | undefined;
    let scenarioId: string | undefined;
    let scenarioDir = DEFAULT_SCENARIO_DIR;
    let hostContains: string | undefined;
    let pathContains: string | undefined;
    let promptContains: string | undefined;
    let selectLast = false;
    let help = false;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--help") {
            help = true;
            continue;
        }
        if (arg === "--select-last") {
            selectLast = true;
            continue;
        }
        if (arg === "--har" && index + 1 < args.length) {
            harPath = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--out" && index + 1 < args.length) {
            outPath = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--scenario" && index + 1 < args.length) {
            scenarioId = (args[index + 1] ?? "").trim();
            index += 1;
            continue;
        }
        if (arg === "--scenario-dir" && index + 1 < args.length) {
            scenarioDir = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--host-contains" && index + 1 < args.length) {
            hostContains = (args[index + 1] ?? "").trim();
            index += 1;
            continue;
        }
        if (arg === "--path-contains" && index + 1 < args.length) {
            pathContains = (args[index + 1] ?? "").trim();
            index += 1;
            continue;
        }
        if (arg === "--prompt-contains" && index + 1 < args.length) {
            promptContains = args[index + 1] ?? "";
            index += 1;
            continue;
        }
    }

    if (!help && !harPath) {
        throw new Error("Missing required --har <path>");
    }

    return {
        harPath,
        outPath,
        scenarioId,
        scenarioDir,
        hostContains,
        pathContains,
        promptContains,
        selectLast,
        help,
    };
}

function readJsonFile<T>(filePath: string): T {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function normalizeHeaders(headers: HarHeader[] | undefined): Record<string, string> {
    if (!Array.isArray(headers)) {
        return {};
    }

    return Object.fromEntries(
        headers
            .filter((header) => typeof header?.name === "string" && typeof header?.value === "string")
            .map((header) => [header.name!.toLowerCase(), header.value!]),
    );
}

export function normalizeHarEntry(entry: HarEntry): CaptureRecord {
    const request = entry.request;
    if (!request || typeof request !== "object") {
        throw new Error("HAR entry is missing request data");
    }
    if (typeof request.url !== "string" || request.url.length === 0) {
        throw new Error("HAR entry request.url is missing");
    }

    const parsedUrl = new URL(request.url);
    return normalizeStoredCapture({
        capturedAt: typeof entry.startedDateTime === "string" ? entry.startedDateTime : new Date().toISOString(),
        method: typeof request.method === "string" ? request.method : "POST",
        url: request.url,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        headers: normalizeHeaders(request.headers),
        bodyText: typeof request.postData?.text === "string" ? request.postData.text : "",
    });
}

export function loadHarCaptures(filePath: string): CaptureRecord[] {
    const har = readJsonFile<HarFile>(filePath);
    const entries = har.log?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error(`No HAR entries found in ${filePath}`);
    }

    return entries.map(normalizeHarEntry);
}

function selectByFilters(captures: CaptureRecord[], args: NormalizeHarArgs): CaptureRecord | undefined {
    const matches = captures.filter((capture) => {
        if (args.hostContains && !capture.url.includes(args.hostContains)) {
            return false;
        }
        if (args.pathContains && !capture.path.includes(args.pathContains)) {
            return false;
        }
        if (args.promptContains && !capture.bodyText.includes(args.promptContains)) {
            return false;
        }
        return true;
    });

    if (matches.length === 0) {
        return undefined;
    }

    return args.selectLast ? matches[matches.length - 1] : matches[0];
}

function loadScenario(scenarioDir: string, scenarioId: string): ScenarioDefinition {
    const scenarios = loadScenarioDefinitions(scenarioDir);
    const scenario = scenarios.find((entry) => entry.id === scenarioId);
    if (!scenario) {
        throw new Error(`Unknown scenario: ${scenarioId}`);
    }
    return scenario;
}

export function selectCapture(captures: CaptureRecord[], args: NormalizeHarArgs): CaptureRecord {
    if (args.scenarioId) {
        const scenario = loadScenario(args.scenarioDir, args.scenarioId);
        const ordered = args.selectLast ? [...captures].reverse() : captures;
        const capture = selectCaptureForScenario(ordered, scenario);
        if (!capture) {
            throw new Error(`No capture matched scenario ${args.scenarioId}`);
        }
        return capture;
    }

    const capture = selectByFilters(captures, args);
    if (!capture) {
        throw new Error("No capture matched the provided filters");
    }
    return capture;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printUsage();
        return;
    }

    const captures = loadHarCaptures(args.harPath);
    const selected = selectCapture(captures, args);

    if (args.outPath) {
        mkdirSync(dirname(args.outPath), { recursive: true });
        writeFileSync(args.outPath, `${JSON.stringify(selected, null, 2)}\n`, "utf8");
        console.log(`Wrote normalized capture to ${args.outPath}`);
        return;
    }

    console.log(JSON.stringify(selected, null, 2));
}

if (import.meta.main) {
    await main();
}
