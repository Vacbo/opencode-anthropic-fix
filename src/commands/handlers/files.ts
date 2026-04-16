// ---------------------------------------------------------------------------
// Files API slash-command handler (/anthropic files)
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AccountManager } from "../../accounts.js";
import { FILES_API_BETA_FLAG } from "../../constants.js";
import { buildOAuthBearerHeaders } from "../../headers/oauth-bearer.js";
import type { ManagedAccount } from "../../token-refresh.js";

/**
 * Maximum number of file-to-account pinning entries retained in memory.
 * Bounded to prevent unbounded growth across long sessions that touch many
 * Files API uploads. Eviction is FIFO: when the cap is hit, the oldest entry
 * (Maps preserve insertion order) is dropped before inserting the new one.
 */
export const FILE_ACCOUNT_MAP_MAX_SIZE = 1000;

/**
 * Insert a fileId→accountIndex binding with FIFO eviction when the cap is reached.
 * See {@link FILE_ACCOUNT_MAP_MAX_SIZE} for the rationale.
 */
export function capFileAccountMap(fileAccountMap: Map<string, number>, fileId: string, accountIndex: number): void {
    if (fileAccountMap.size >= FILE_ACCOUNT_MAP_MAX_SIZE) {
        const oldestKey = fileAccountMap.keys().next().value;
        if (oldestKey !== undefined) fileAccountMap.delete(oldestKey);
    }
    fileAccountMap.set(fileId, accountIndex);
}

export interface FilesHandlerDeps {
    sendCommandMessage: (sessionID: string, message: string) => Promise<void>;
    accountManager: AccountManager | null;
    fileAccountMap: Map<string, number>;
    refreshAccountTokenSingleFlight: (account: ManagedAccount) => Promise<string>;
}

type ResolvedAccount = { account: ManagedAccount; label: string };

function resolveTargetAccount(accountManager: AccountManager, identifier: string | null): ResolvedAccount | null {
    const accounts = accountManager.getEnabledAccounts();
    if (identifier) {
        const byEmail = accounts.find((a) => a.email === identifier);
        if (byEmail) return { account: byEmail, label: byEmail.email || `Account ${byEmail.index + 1}` };
        const idx = parseInt(identifier, 10);
        if (!isNaN(idx) && idx >= 1) {
            const byIdx = accounts.find((a) => a.index === idx - 1);
            if (byIdx) return { account: byIdx, label: byIdx.email || `Account ${byIdx.index + 1}` };
        }
        return null;
    }
    const current = accountManager.getCurrentAccount();
    if (!current) return null;
    return { account: current, label: current.email || `Account ${current.index + 1}` };
}

async function getFilesAuth(
    acct: ManagedAccount,
    refreshAccountTokenSingleFlight: (account: ManagedAccount) => Promise<string>,
) {
    let tok = acct.access;
    if (!tok || !acct.expires || acct.expires < Date.now()) {
        tok = await refreshAccountTokenSingleFlight(acct);
    }
    return buildOAuthBearerHeaders(tok, { extraBetas: [FILES_API_BETA_FLAG] });
}

const API_BASE = "https://api.anthropic.com";

/**
 * Handle /anthropic files [list|upload|get|delete|download].
 */
export async function handleFilesCommand(sessionID: string, args: string[], deps: FilesHandlerDeps): Promise<void> {
    const { sendCommandMessage, accountManager, fileAccountMap, refreshAccountTokenSingleFlight } = deps;

    let targetAccountId: string | null = null;
    const filteredArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--account" && i + 1 < args.length) {
            targetAccountId = args[i + 1];
            i++;
        } else {
            filteredArgs.push(args[i]);
        }
    }
    const action = (filteredArgs[1] || "").toLowerCase();

    if (!accountManager || accountManager.getAccountCount() === 0) {
        await sendCommandMessage(
            sessionID,
            "▣ Anthropic Files (error)\n\nNo accounts configured. Use /anthropic login first.",
        );
        return;
    }

    try {
        if (!action || action === "list") {
            if (targetAccountId) {
                const resolved = resolveTargetAccount(accountManager, targetAccountId);
                if (!resolved) {
                    await sendCommandMessage(
                        sessionID,
                        `▣ Anthropic Files (error)\n\nAccount not found: ${targetAccountId}`,
                    );
                    return;
                }
                const { account, label } = resolved;
                const headers = await getFilesAuth(account, refreshAccountTokenSingleFlight);
                const res = await fetch(`${API_BASE}/v1/files`, { headers });
                if (!res.ok) {
                    const errBody = await res.text();
                    await sendCommandMessage(
                        sessionID,
                        `▣ Anthropic Files (error) [${label}]\n\nHTTP ${res.status}: ${errBody}`,
                    );
                    return;
                }
                const data = (await res.json()) as {
                    data?: Array<{ id: string; filename: string; size: number; purpose: string }>;
                };
                const files = data.data || [];
                for (const f of files) capFileAccountMap(fileAccountMap, f.id, account.index);
                if (files.length === 0) {
                    await sendCommandMessage(sessionID, `▣ Anthropic Files [${label}]\n\nNo files uploaded.`);
                    return;
                }
                const lines = [`▣ Anthropic Files [${label}]`, "", `${files.length} file(s):`, ""];
                for (const f of files) {
                    const sizeKB = (f.size / 1024).toFixed(1);
                    lines.push(`  ${f.id}  ${f.filename}  (${sizeKB} KB, ${f.purpose})`);
                }
                await sendCommandMessage(sessionID, lines.join("\n"));
                return;
            }

            const accounts = accountManager.getEnabledAccounts();
            const allLines = ["▣ Anthropic Files (all accounts)", ""];
            let totalFiles = 0;
            for (const acct of accounts) {
                const label = acct.email || `Account ${acct.index + 1}`;
                try {
                    const headers = await getFilesAuth(acct, refreshAccountTokenSingleFlight);
                    const res = await fetch(`${API_BASE}/v1/files`, { headers });
                    if (!res.ok) {
                        allLines.push(`[${label}] Error: HTTP ${res.status}`);
                        allLines.push("");
                        continue;
                    }
                    const data = (await res.json()) as {
                        data?: Array<{ id: string; filename: string; size: number; purpose: string }>;
                    };
                    const files = data.data || [];
                    for (const f of files) capFileAccountMap(fileAccountMap, f.id, acct.index);
                    totalFiles += files.length;
                    if (files.length === 0) {
                        allLines.push(`[${label}] No files`);
                    } else {
                        allLines.push(`[${label}] ${files.length} file(s):`);
                        for (const f of files) {
                            const sizeKB = (f.size / 1024).toFixed(1);
                            allLines.push(`  ${f.id}  ${f.filename}  (${sizeKB} KB, ${f.purpose})`);
                        }
                    }
                    allLines.push("");
                } catch (err) {
                    allLines.push(`[${label}] Error: ${(err as Error).message}`);
                    allLines.push("");
                }
            }
            if (totalFiles === 0 && accounts.length > 0) {
                allLines.push(`Total: No files across ${accounts.length} account(s).`);
            } else {
                allLines.push(`Total: ${totalFiles} file(s) across ${accounts.length} account(s).`);
            }
            if (accounts.length > 1) {
                allLines.push("", "Tip: Use --account <email> to target a specific account.");
            }
            await sendCommandMessage(sessionID, allLines.join("\n"));
            return;
        }

        const resolved = resolveTargetAccount(accountManager, targetAccountId);
        if (!resolved) {
            const errMsg = targetAccountId ? `Account not found: ${targetAccountId}` : "No accounts available.";
            await sendCommandMessage(sessionID, `▣ Anthropic Files (error)\n\n${errMsg}`);
            return;
        }
        const { account, label } = resolved;
        const authHeaders = await getFilesAuth(account, refreshAccountTokenSingleFlight);

        if (action === "upload") {
            const filePath = filteredArgs.slice(2).join(" ").trim();
            if (!filePath) {
                await sendCommandMessage(
                    sessionID,
                    "▣ Anthropic Files\n\nUsage: /anthropic files upload <path> [--account <email>]",
                );
                return;
            }
            const resolvedPath = resolve(filePath);
            if (!existsSync(resolvedPath)) {
                await sendCommandMessage(sessionID, `▣ Anthropic Files (error)\n\nFile not found: ${resolvedPath}`);
                return;
            }
            const content = readFileSync(resolvedPath);
            const filename = basename(resolvedPath);
            const blob = new Blob([content]);
            const form = new FormData();
            form.append("file", blob, filename);
            form.append("purpose", "assistants");
            const res = await fetch(`${API_BASE}/v1/files`, {
                method: "POST",
                headers: authHeaders,
                body: form,
            });
            if (!res.ok) {
                const errBody = await res.text();
                await sendCommandMessage(
                    sessionID,
                    `▣ Anthropic Files (error) [${label}]\n\nUpload failed (HTTP ${res.status}): ${errBody}`,
                );
                return;
            }
            const file = (await res.json()) as { id: string; filename: string; size?: number };
            const sizeKB = ((file.size || 0) / 1024).toFixed(1);
            capFileAccountMap(fileAccountMap, file.id, account.index);
            await sendCommandMessage(
                sessionID,
                `▣ Anthropic Files [${label}]\n\nUploaded: ${file.id}\n  Filename: ${file.filename}\n  Size: ${sizeKB} KB`,
            );
            return;
        }

        if (action === "get" || action === "info") {
            const fileId = filteredArgs[2]?.trim();
            if (!fileId) {
                await sendCommandMessage(
                    sessionID,
                    "▣ Anthropic Files\n\nUsage: /anthropic files get <file_id> [--account <email>]",
                );
                return;
            }
            const res = await fetch(`${API_BASE}/v1/files/${encodeURIComponent(fileId)}`, { headers: authHeaders });
            if (!res.ok) {
                const errBody = await res.text();
                await sendCommandMessage(
                    sessionID,
                    `▣ Anthropic Files (error) [${label}]\n\nHTTP ${res.status}: ${errBody}`,
                );
                return;
            }
            const file = (await res.json()) as {
                id: string;
                filename: string;
                purpose: string;
                size?: number;
                mime_type?: string;
                created_at?: string;
            };
            capFileAccountMap(fileAccountMap, file.id, account.index);
            const lines = [
                `▣ Anthropic Files [${label}]`,
                "",
                `  ID:       ${file.id}`,
                `  Filename: ${file.filename}`,
                `  Purpose:  ${file.purpose}`,
                `  Size:     ${((file.size || 0) / 1024).toFixed(1)} KB`,
                `  Type:     ${file.mime_type || "unknown"}`,
                `  Created:  ${file.created_at || "unknown"}`,
            ];
            await sendCommandMessage(sessionID, lines.join("\n"));
            return;
        }

        if (action === "delete" || action === "rm") {
            const fileId = filteredArgs[2]?.trim();
            if (!fileId) {
                await sendCommandMessage(
                    sessionID,
                    "▣ Anthropic Files\n\nUsage: /anthropic files delete <file_id> [--account <email>]",
                );
                return;
            }
            const res = await fetch(`${API_BASE}/v1/files/${encodeURIComponent(fileId)}`, {
                method: "DELETE",
                headers: authHeaders,
            });
            if (!res.ok) {
                const errBody = await res.text();
                await sendCommandMessage(
                    sessionID,
                    `▣ Anthropic Files (error) [${label}]\n\nHTTP ${res.status}: ${errBody}`,
                );
                return;
            }
            fileAccountMap.delete(fileId);
            await sendCommandMessage(sessionID, `▣ Anthropic Files [${label}]\n\nDeleted: ${fileId}`);
            return;
        }

        if (action === "download" || action === "dl") {
            const fileId = filteredArgs[2]?.trim();
            if (!fileId) {
                await sendCommandMessage(
                    sessionID,
                    "▣ Anthropic Files\n\nUsage: /anthropic files download <file_id> [output_path] [--account <email>]",
                );
                return;
            }
            const outputPath = filteredArgs.slice(3).join(" ").trim();
            const metaRes = await fetch(`${API_BASE}/v1/files/${encodeURIComponent(fileId)}`, { headers: authHeaders });
            if (!metaRes.ok) {
                const errBody = await metaRes.text();
                await sendCommandMessage(
                    sessionID,
                    `▣ Anthropic Files (error) [${label}]\n\nHTTP ${metaRes.status}: ${errBody}`,
                );
                return;
            }
            const meta = (await metaRes.json()) as { filename: string };
            const savePath = outputPath ? resolve(outputPath) : resolve(meta.filename);
            const res = await fetch(`${API_BASE}/v1/files/${encodeURIComponent(fileId)}/content`, {
                headers: authHeaders,
            });
            if (!res.ok) {
                const errBody = await res.text();
                await sendCommandMessage(
                    sessionID,
                    `▣ Anthropic Files (error) [${label}]\n\nDownload failed (HTTP ${res.status}): ${errBody}`,
                );
                return;
            }
            const buffer = Buffer.from(await res.arrayBuffer());
            writeFileSync(savePath, buffer);
            const sizeKB = (buffer.length / 1024).toFixed(1);
            await sendCommandMessage(
                sessionID,
                `▣ Anthropic Files [${label}]\n\nDownloaded: ${meta.filename}\n  Saved to: ${savePath}\n  Size: ${sizeKB} KB`,
            );
            return;
        }

        const helpLines = [
            "▣ Anthropic Files",
            "",
            "Usage: /anthropic files <action> [--account <email|index>]",
            "",
            "Actions:",
            "  list                          List uploaded files (all accounts if no --account)",
            "  upload <path>                 Upload a file (max 350MB)",
            "  get <file_id>                 Get file metadata",
            "  delete <file_id>              Delete a file",
            "  download <file_id> [path]     Download file content",
            "",
            "Options:",
            "  --account <email|index>       Target a specific account (1-based index)",
            "",
            "Supported formats: PDF, DOCX, TXT, CSV, Excel, Markdown, images",
            "Files can be referenced by file_id in Messages API requests.",
            "",
            "When using round-robin, file_ids are automatically pinned to the",
            "account that owns them for Messages API requests.",
        ];
        await sendCommandMessage(sessionID, helpLines.join("\n"));
        return;
    } catch (err) {
        await sendCommandMessage(sessionID, `▣ Anthropic Files (error)\n\n${(err as Error).message}`);
        return;
    }
}
