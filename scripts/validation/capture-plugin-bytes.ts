#!/usr/bin/env bun
/**
 * capture-plugin-bytes.ts
 *
 * Synthesizes the EXACT request the plugin would send for a given
 * (prompt, model, account) and writes it to disk so it can be replayed
 * via curl. Does NOT send the request itself.
 *
 * Used by the cch validation flow to A/B/C test:
 *   A — plugin's current sha256[:5] cch
 *   B — same body with cch=00000
 *   C — same body with cch=ffffe (any non-zero hex)
 *
 * Inputs:
 *   --prompt <text>       The user message text. Default: "Reply with the single word: OK"
 *   --model  <id>         Model ID. Default: claude-sonnet-4-5
 *   --cc-version <ver>    CLI version to embed. Default: 2.1.101
 *   --account <n>         1-indexed account number. Default: active account from anthropic-accounts.json
 *   --cch-override <hex>  Force the cch field to a specific 5-char value (e.g. 00000)
 *   --body-out <path>     Where to write the JSON body. Default: /tmp/cch-validation/body-<tag>.json
 *   --headers-out <path>  Where to write the headers JSON. Default: /tmp/cch-validation/headers-<tag>.json
 *   --curl-out <path>     Where to write a runnable curl bash script. Default: /tmp/cch-validation/curl-<tag>.sh
 *   --tag <name>          Short tag for output filenames. Default: "current"
 *
 * Outputs three files:
 *   body-<tag>.json    — the JSON body to POST
 *   headers-<tag>.json — JSON object of header name → value (auth token redacted in stdout)
 *   curl-<tag>.sh      — bash script that POSTs the body to api.anthropic.com
 *
 * Reads:
 *   ~/.config/opencode/anthropic-accounts.json (the active account's access token)
 *
 * NEVER prints the access token to stdout. Only writes it into the curl script and headers file
 * (those files inherit owner-only perms).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { transformRequestBody } from "../../src/request/body.js";
import { buildRequestHeaders } from "../../src/headers/builder.js";
import type { RuntimeContext, SignatureConfig } from "../../src/types.js";

interface Args {
    prompt: string;
    model: string;
    ccVersion: string;
    account: number | null;
    cchOverride: string | null;
    bodyOut: string;
    headersOut: string;
    curlOut: string;
    tag: string;
}

interface AccountRecord {
    id: string;
    email?: string;
    refreshToken: string;
    access?: string;
    expires?: number;
    enabled: boolean;
    source?: string;
}

interface AccountsFile {
    version: number;
    accounts: AccountRecord[];
    activeIndex: number;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    const get = (flag: string, def?: string): string | undefined => {
        const i = argv.indexOf(flag);
        if (i === -1) return def;
        return argv[i + 1];
    };

    const tag = get("--tag", "current") ?? "current";
    const defaultDir = "/tmp/cch-validation";

    return {
        prompt: get("--prompt", "Reply with the single word: OK") ?? "Reply with the single word: OK",
        model: get("--model", "claude-sonnet-4-5") ?? "claude-sonnet-4-5",
        ccVersion: get("--cc-version", "2.1.101") ?? "2.1.101",
        account: (() => {
            const v = get("--account");
            return v ? parseInt(v, 10) : null;
        })(),
        cchOverride: get("--cch-override") ?? null,
        bodyOut: resolve(
            get("--body-out", join(defaultDir, `body-${tag}.json`)) ?? join(defaultDir, `body-${tag}.json`),
        ),
        headersOut: resolve(
            get("--headers-out", join(defaultDir, `headers-${tag}.json`)) ?? join(defaultDir, `headers-${tag}.json`),
        ),
        curlOut: resolve(get("--curl-out", join(defaultDir, `curl-${tag}.sh`)) ?? join(defaultDir, `curl-${tag}.sh`)),
        tag,
    };
}

async function loadAccountsFile(): Promise<AccountsFile> {
    const path = join(homedir(), ".config", "opencode", "anthropic-accounts.json");
    const content = await readFile(path, "utf-8");
    const data = JSON.parse(content) as AccountsFile;
    if (!data.accounts || !Array.isArray(data.accounts)) {
        throw new Error(`anthropic-accounts.json is malformed at ${path}`);
    }
    return data;
}

function pickAccount(accountsFile: AccountsFile, oneIndexed: number | null): AccountRecord {
    const idx = oneIndexed != null ? oneIndexed - 1 : accountsFile.activeIndex;
    const account = accountsFile.accounts[idx];
    if (!account) {
        throw new Error(`Account index ${idx} not found (have ${accountsFile.accounts.length} accounts)`);
    }
    if (!account.enabled) {
        throw new Error(`Account index ${idx} (${account.email ?? account.id}) is disabled`);
    }
    if (!account.access) {
        throw new Error(
            `Account index ${idx} (${account.email ?? account.id}) has no access token. Run: opencode-anthropic-auth refresh ${idx + 1}`,
        );
    }
    if (typeof account.expires === "number" && account.expires < Date.now() + 60_000) {
        const minutesLeft = Math.floor((account.expires - Date.now()) / 60_000);
        throw new Error(
            `Account index ${idx} access token expires in ${minutesLeft} min (need >1 min). Run: opencode-anthropic-auth refresh ${idx + 1}`,
        );
    }
    return account;
}

function buildInputBody(prompt: string, model: string): string {
    // Mimic what opencode would send through the plugin's fetch interceptor.
    // System prompt is intentionally minimal here — the plugin's
    // transformRequestBody will inject the CC billing block + identity block
    // and relocate any third-party prompts.
    return JSON.stringify({
        model,
        max_tokens: 1024,
        stream: false,
        messages: [
            {
                role: "user",
                content: prompt,
            },
        ],
        system: "You are a helpful assistant.",
    });
}

function generateCurlScript(headers: Record<string, string>, bodyPath: string): string {
    const lines: string[] = [
        "#!/usr/bin/env bash",
        "# Generated by scripts/validation/capture-plugin-bytes.ts",
        "# Replays a synthesized plugin request against api.anthropic.com.",
        "set -euo pipefail",
        "",
        'BODY_PATH="$(dirname "$0")/' + bodyPath.split("/").pop() + '"',
        'if [[ ! -f "$BODY_PATH" ]]; then',
        '  echo "ERROR: body file not found at $BODY_PATH" >&2',
        "  exit 1",
        "fi",
        "",
        'echo "[*] Replaying $(basename "$BODY_PATH") to api.anthropic.com" >&2',
        'echo "[*] cch in body: $(grep -oE \'cch=[0-9a-f]{5}\' "$BODY_PATH" | head -1)" >&2',
        "",
        "curl -sS -X POST 'https://api.anthropic.com/v1/messages?beta=true' \\",
    ];
    for (const [key, value] of Object.entries(headers)) {
        // Escape single quotes for bash literal strings: ' → '\''
        const escaped = value.replace(/'/g, "'\\''");
        lines.push(`  -H '${key}: ${escaped}' \\`);
    }
    lines.push('  --data-binary "@$BODY_PATH" \\');
    lines.push('  -w "\\n[*] HTTP %{http_code}  %{time_total}s\\n"');
    lines.push("");
    return lines.join("\n");
}

async function main(): Promise<void> {
    const args = parseArgs();

    const accountsFile = await loadAccountsFile();
    const account = pickAccount(accountsFile, args.account);

    const inputBody = buildInputBody(args.prompt, args.model);

    const runtime: RuntimeContext = {
        persistentUserId: process.env.OPENCODE_ANTHROPIC_SIGNATURE_USER_ID ?? "0".repeat(64),
        sessionId: randomUUID(),
        accountId: account.id,
    };

    const signature: SignatureConfig = {
        enabled: true,
        claudeCliVersion: args.ccVersion,
        promptCompactionMode: "minimal",
        sessionId: runtime.sessionId,
    };

    const transformedBody = transformRequestBody(inputBody, signature, runtime);
    if (!transformedBody) {
        throw new Error("transformRequestBody returned undefined");
    }

    // Apply cch override if requested. The plugin emits exactly one cch=<5hex> match.
    let finalBody = transformedBody;
    let originalCch: string | null = null;
    const cchMatch = transformedBody.match(/cch=([0-9a-f]{5})/);
    if (cchMatch) originalCch = cchMatch[1] ?? null;
    if (args.cchOverride) {
        if (!/^[0-9a-f]{5}$/.test(args.cchOverride)) {
            throw new Error(`--cch-override must be exactly 5 lowercase hex chars, got: ${args.cchOverride}`);
        }
        finalBody = transformedBody.replace(/cch=[0-9a-f]{5}/, `cch=${args.cchOverride}`);
    }

    const requestUrl = new URL("https://api.anthropic.com/v1/messages?beta=true");
    const headers = buildRequestHeaders(
        requestUrl.toString(),
        { headers: {} },
        account.access ?? "",
        finalBody,
        requestUrl,
        signature,
    );

    const headersObj: Record<string, string> = {};
    headers.forEach((value, key) => {
        headersObj[key] = value;
    });

    await mkdir(dirname(args.bodyOut), { recursive: true });

    await writeFile(args.bodyOut, finalBody, { mode: 0o600 });
    await writeFile(args.headersOut, JSON.stringify(headersObj, null, 2), { mode: 0o600 });

    const curlScript = generateCurlScript(headersObj, args.bodyOut);
    await writeFile(args.curlOut, curlScript, { mode: 0o700 });
    await chmod(args.curlOut, 0o700);

    // Print summary (NEVER print the access token)
    const finalCch = finalBody.match(/cch=([0-9a-f]{5})/)?.[1] ?? "NONE";
    const billingHeader = finalBody.match(/x-anthropic-billing-header:[^"\\]*/)?.[0] ?? "NONE";
    console.log(`Tag:           ${args.tag}`);
    console.log(`Model:         ${args.model}`);
    console.log(`CC version:    ${args.ccVersion}`);
    console.log(
        `Account:       index ${(args.account ?? accountsFile.activeIndex + 1) - 1} (${account.email ?? account.id.slice(0, 40)}, source=${account.source ?? "unknown"})`,
    );
    console.log(`Original cch:  ${originalCch ?? "NONE"}`);
    console.log(`Final cch:     ${finalCch}${args.cchOverride ? " (overridden)" : ""}`);
    console.log(`Billing block: ${billingHeader}`);
    console.log(`Body bytes:    ${Buffer.byteLength(finalBody, "utf8")}`);
    console.log(`Body:          ${args.bodyOut}`);
    console.log(`Headers:       ${args.headersOut}`);
    console.log(`Curl script:   ${args.curlOut}`);
    console.log("");
    console.log("To replay:");
    console.log(`  bash ${args.curlOut}`);
}

main().catch((err: Error) => {
    console.error(`ERROR: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
});
