// ---------------------------------------------------------------------------
// Slash-command router for /anthropic commands
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AccountManager } from "../accounts.js";
import { resolveBetaShortcut } from "../betas.js";
import type { AnthropicAuthConfig } from "../config.js";
import { loadConfigFresh, saveConfig } from "../config.js";
import { isTruthyEnv } from "../env.js";
import { loadAccounts } from "../storage.js";
import type { ManagedAccount } from "../token-refresh.js";
import { completeSlashOAuth, startSlashOAuth, type OAuthFlowDeps, type PendingOAuthEntry } from "./oauth-flow.js";

export const ANTHROPIC_COMMAND_HANDLED = "__ANTHROPIC_COMMAND_HANDLED__";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandDeps {
  sendCommandMessage: (sessionID: string, message: string) => Promise<void>;
  accountManager: AccountManager | null;
  runCliCommand: (args: string[]) => Promise<CliResult>;
  config: AnthropicAuthConfig;
  fileAccountMap: Map<string, number>;
  initialAccountPinned: boolean;
  pendingSlashOAuth: Map<string, PendingOAuthEntry>;
  reloadAccountManagerFromDisk: () => Promise<void>;
  persistOpenCodeAuth: (refresh: string, access: string | undefined, expires: number | undefined) => Promise<void>;
  refreshAccountTokenSingleFlight: (account: ManagedAccount) => Promise<string>;
}

/**
 * Remove ANSI color/control codes from output text.
 */
export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Parse command arguments with minimal quote support.
 *
 * Examples:
 *   a b "c d"  -> ["a", "b", "c d"]
 *   a 'c d'     -> ["a", "c d"]
 */
export function parseCommandArgs(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  const parts: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    parts.push(token.replace(/\\(["'\\])/g, "$1"));
  }
  return parts;
}

/**
 * Handle /anthropic slash commands.
 */
export async function handleAnthropicSlashCommand(
  input: { command: string; arguments?: string; sessionID: string },
  deps: CommandDeps,
): Promise<void> {
  const {
    sendCommandMessage,
    accountManager,
    runCliCommand,
    config,
    fileAccountMap,
    initialAccountPinned,
    pendingSlashOAuth,
    reloadAccountManagerFromDisk,
    persistOpenCodeAuth,
    refreshAccountTokenSingleFlight,
  } = deps;

  const oauthFlowDeps: OAuthFlowDeps = {
    pendingSlashOAuth,
    sendCommandMessage,
    reloadAccountManagerFromDisk,
    persistOpenCodeAuth,
  };

  const args = parseCommandArgs(input.arguments || "");
  const primary = (args[0] || "list").toLowerCase();

  // Friendly alias: /anthropic usage -> list
  if (primary === "usage") {
    const result = await runCliCommand(["list"]);
    const heading = result.code === 0 ? "▣ Anthropic" : "▣ Anthropic (error)";
    const body = result.stdout || result.stderr || "No output.";
    await sendCommandMessage(input.sessionID, [heading, "", body].join("\n"));
    await reloadAccountManagerFromDisk();
    return;
  }

  // Two-step login flow
  if (primary === "login") {
    if ((args[1] || "").toLowerCase() === "complete") {
      const code = args.slice(2).join(" ").trim();
      if (!code) {
        await sendCommandMessage(
          input.sessionID,
          "▣ Anthropic OAuth\n\nMissing code. Use: /anthropic login complete <code#state>",
        );
        return;
      }
      const result = await completeSlashOAuth(input.sessionID, code, oauthFlowDeps);
      const heading = result.ok ? "▣ Anthropic OAuth" : "▣ Anthropic OAuth (error)";
      await sendCommandMessage(input.sessionID, `${heading}\n\n${result.message}`);
      return;
    }
    await startSlashOAuth(input.sessionID, "login", undefined, oauthFlowDeps);
    return;
  }

  // Two-step reauth flow
  if (primary === "reauth") {
    if ((args[1] || "").toLowerCase() === "complete") {
      const code = args.slice(2).join(" ").trim();
      if (!code) {
        await sendCommandMessage(
          input.sessionID,
          "▣ Anthropic OAuth\n\nMissing code. Use: /anthropic reauth complete <code#state>",
        );
        return;
      }
      const result = await completeSlashOAuth(input.sessionID, code, oauthFlowDeps);
      const heading = result.ok ? "▣ Anthropic OAuth" : "▣ Anthropic OAuth (error)";
      await sendCommandMessage(input.sessionID, `${heading}\n\n${result.message}`);
      return;
    }
    const n = parseInt(args[1], 10);
    if (Number.isNaN(n) || n < 1) {
      await sendCommandMessage(
        input.sessionID,
        "▣ Anthropic OAuth\n\nProvide an account number. Example: /anthropic reauth 1",
      );
      return;
    }
    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
      await sendCommandMessage(input.sessionID, "▣ Anthropic OAuth (error)\n\nNo accounts configured.");
      return;
    }
    const idx = n - 1;
    if (idx >= stored.accounts.length) {
      await sendCommandMessage(
        input.sessionID,
        `▣ Anthropic OAuth (error)\n\nAccount ${n} does not exist. You have ${stored.accounts.length} account(s).`,
      );
      return;
    }
    await startSlashOAuth(input.sessionID, "reauth", idx, oauthFlowDeps);
    return;
  }

  // /anthropic config
  if (primary === "config") {
    const fresh = loadConfigFresh();
    const lines = [
      "▣ Anthropic Config",
      "",
      `strategy: ${fresh.account_selection_strategy}`,
      `emulation: ${fresh.signature_emulation.enabled ? "on" : "off"}`,
      `compaction: ${fresh.signature_emulation.prompt_compaction}`,
      `1m-context: ${fresh.override_model_limits.enabled ? "on" : "off"}`,
      `idle-refresh: ${fresh.idle_refresh.enabled ? "on" : "off"}`,
      `debug: ${fresh.debug ? "on" : "off"}`,
      `quiet: ${fresh.toasts.quiet ? "on" : "off"}`,
      `custom_betas: ${fresh.custom_betas.length ? fresh.custom_betas.join(", ") : "(none)"}`,
    ];
    await sendCommandMessage(input.sessionID, lines.join("\n"));
    return;
  }

  // /anthropic set <key> <value>
  if (primary === "set") {
    const key = (args[1] || "").toLowerCase();
    const value = (args[2] || "").toLowerCase();
    const setters: Record<string, () => void> = {
      emulation: () =>
        saveConfig({
          signature_emulation: {
            enabled: value === "on" || value === "1" || value === "true",
          },
        }),
      compaction: () =>
        saveConfig({
          signature_emulation: {
            prompt_compaction: value === "off" ? "off" : "minimal",
          },
        }),
      "1m-context": () =>
        saveConfig({
          override_model_limits: {
            enabled: value === "on" || value === "1" || value === "true",
          },
        }),
      "idle-refresh": () =>
        saveConfig({
          idle_refresh: {
            enabled: value === "on" || value === "1" || value === "true",
          },
        }),
      debug: () =>
        saveConfig({
          debug: value === "on" || value === "1" || value === "true",
        }),
      quiet: () =>
        saveConfig({
          toasts: {
            quiet: value === "on" || value === "1" || value === "true",
          },
        }),
      strategy: () => {
        const valid = ["sticky", "round-robin", "hybrid"];
        if (valid.includes(value))
          saveConfig({ account_selection_strategy: value as "sticky" | "round-robin" | "hybrid" });
        else throw new Error(`Invalid strategy. Valid: ${valid.join(", ")}`);
      },
    };

    if (!key || !setters[key]) {
      const keys = Object.keys(setters).join(", ");
      await sendCommandMessage(
        input.sessionID,
        `▣ Anthropic Set\n\nUsage: /anthropic set <key> <value>\nKeys: ${keys}\nValues: on/off (or specific values for strategy/compaction)`,
      );
      return;
    }
    if (!value) {
      await sendCommandMessage(input.sessionID, `▣ Anthropic Set\n\nMissing value for "${key}".`);
      return;
    }
    setters[key]();
    Object.assign(config, loadConfigFresh());
    await sendCommandMessage(input.sessionID, `▣ Anthropic Set\n\n${key} = ${value}`);
    return;
  }

  // /anthropic betas [add|remove <beta>]
  if (primary === "betas") {
    const action = (args[1] || "").toLowerCase();

    if (!action || action === "list") {
      const fresh = loadConfigFresh();
      const strategy = fresh.account_selection_strategy || config.account_selection_strategy;
      const lines = [
        "▣ Anthropic Betas",
        "",
        "Preset betas (auto-computed per model/provider):",
        "  oauth-2025-04-20, claude-code-20250219,",
        "  advanced-tool-use-2025-11-20, fast-mode-2026-02-01,",
        "  interleaved-thinking-2025-05-14 (non-Opus 4.6) OR effort-2025-11-24 (Opus 4.6),",
        "  files-api-2025-04-14 (only /v1/files and requests with file_id),",
        "  token-counting-2024-11-01 (only /v1/messages/count_tokens),",
        `  prompt-caching-scope-2026-01-05 (non-interactive${strategy === "round-robin" ? ", skipped in round-robin" : ""})`,
        "",
        `Experimental betas: ${isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) ? "disabled (CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1)" : "enabled"}`,
        `Strategy: ${strategy}${initialAccountPinned ? " (pinned via OPENCODE_ANTHROPIC_INITIAL_ACCOUNT)" : ""}`,
        `Custom betas: ${fresh.custom_betas.length ? fresh.custom_betas.join(", ") : "(none)"}`,
        "",
        "Toggleable presets:",
        "  /anthropic betas add structured-outputs-2025-12-15",
        "  /anthropic betas add context-management-2025-06-27",
        "  /anthropic betas add task-budgets-2026-03-13",
        "  /anthropic betas add web-search-2025-03-05",
        "  /anthropic betas add compact-2026-01-12",
        "  /anthropic betas add mcp-servers-2025-12-04",
        "  /anthropic betas add redact-thinking-2026-02-12",
        "  /anthropic betas add 1m   (shortcut for context-1m-2025-08-07)",
        "",
        "Remove: /anthropic betas remove <beta>",
      ];
      await sendCommandMessage(input.sessionID, lines.join("\n"));
      return;
    }

    if (action === "add") {
      const betaInput = args[2]?.trim();
      if (!betaInput) {
        await sendCommandMessage(input.sessionID, "▣ Anthropic Betas\n\nUsage: /anthropic betas add <beta-name>");
        return;
      }
      const beta = resolveBetaShortcut(betaInput);
      const fresh = loadConfigFresh();
      const current = fresh.custom_betas || [];
      if (current.includes(beta)) {
        await sendCommandMessage(input.sessionID, `▣ Anthropic Betas\n\n"${beta}" already added.`);
        return;
      }
      saveConfig({ custom_betas: [...current, beta] });
      Object.assign(config, loadConfigFresh());
      const fromShortcut = beta !== betaInput;
      await sendCommandMessage(
        input.sessionID,
        `▣ Anthropic Betas\n\nAdded: ${beta}${fromShortcut ? ` (from shortcut: ${betaInput})` : ""}`,
      );
      return;
    }

    if (action === "remove" || action === "rm") {
      const betaInput = args[2]?.trim();
      if (!betaInput) {
        await sendCommandMessage(input.sessionID, "▣ Anthropic Betas\n\nUsage: /anthropic betas remove <beta-name>");
        return;
      }
      const beta = resolveBetaShortcut(betaInput);
      const fresh = loadConfigFresh();
      const current = fresh.custom_betas || [];
      if (!current.includes(beta)) {
        await sendCommandMessage(input.sessionID, `▣ Anthropic Betas\n\n"${beta}" not in custom betas.`);
        return;
      }
      saveConfig({ custom_betas: current.filter((b) => b !== beta) });
      Object.assign(config, loadConfigFresh());
      await sendCommandMessage(input.sessionID, `▣ Anthropic Betas\n\nRemoved: ${beta}`);
      return;
    }

    await sendCommandMessage(input.sessionID, "▣ Anthropic Betas\n\nUsage: /anthropic betas [add|remove <beta>]");
    return;
  }

  // /anthropic files [list|upload|get|delete|download]
  if (primary === "files") {
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
        input.sessionID,
        "▣ Anthropic Files (error)\n\nNo accounts configured. Use /anthropic login first.",
      );
      return;
    }

    type ResolvedAccount = { account: ManagedAccount; label: string };

    function resolveTargetAccount(identifier: string | null): ResolvedAccount | null {
      const accounts = accountManager!.getEnabledAccounts();
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
      const current = accountManager!.getCurrentAccount();
      if (!current) return null;
      return { account: current, label: current.email || `Account ${current.index + 1}` };
    }

    async function getFilesAuth(acct: ManagedAccount) {
      let tok = acct.access;
      if (!tok || !acct.expires || acct.expires < Date.now()) {
        tok = await refreshAccountTokenSingleFlight(acct);
      }
      return {
        authorization: `Bearer ${tok}`,
        "anthropic-beta": "oauth-2025-04-20,files-api-2025-04-14",
      };
    }

    const apiBase = "https://api.anthropic.com";

    try {
      if (!action || action === "list") {
        if (targetAccountId) {
          const resolved = resolveTargetAccount(targetAccountId);
          if (!resolved) {
            await sendCommandMessage(
              input.sessionID,
              `▣ Anthropic Files (error)\n\nAccount not found: ${targetAccountId}`,
            );
            return;
          }
          const { account, label } = resolved;
          const headers = await getFilesAuth(account);
          const res = await fetch(`${apiBase}/v1/files`, { headers });
          if (!res.ok) {
            const errBody = await res.text();
            await sendCommandMessage(
              input.sessionID,
              `▣ Anthropic Files (error) [${label}]\n\nHTTP ${res.status}: ${errBody}`,
            );
            return;
          }
          const data = (await res.json()) as {
            data?: Array<{ id: string; filename: string; size: number; purpose: string }>;
          };
          const files = data.data || [];
          for (const f of files) fileAccountMap.set(f.id, account.index);
          if (files.length === 0) {
            await sendCommandMessage(input.sessionID, `▣ Anthropic Files [${label}]\n\nNo files uploaded.`);
            return;
          }
          const lines = [`▣ Anthropic Files [${label}]`, "", `${files.length} file(s):`, ""];
          for (const f of files) {
            const sizeKB = (f.size / 1024).toFixed(1);
            lines.push(`  ${f.id}  ${f.filename}  (${sizeKB} KB, ${f.purpose})`);
          }
          await sendCommandMessage(input.sessionID, lines.join("\n"));
          return;
        }

        const accounts = accountManager.getEnabledAccounts();
        const allLines = ["▣ Anthropic Files (all accounts)", ""];
        let totalFiles = 0;
        for (const acct of accounts) {
          const label = acct.email || `Account ${acct.index + 1}`;
          try {
            const headers = await getFilesAuth(acct);
            const res = await fetch(`${apiBase}/v1/files`, { headers });
            if (!res.ok) {
              allLines.push(`[${label}] Error: HTTP ${res.status}`);
              allLines.push("");
              continue;
            }
            const data = (await res.json()) as {
              data?: Array<{ id: string; filename: string; size: number; purpose: string }>;
            };
            const files = data.data || [];
            for (const f of files) fileAccountMap.set(f.id, acct.index);
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
        await sendCommandMessage(input.sessionID, allLines.join("\n"));
        return;
      }

      const resolved = resolveTargetAccount(targetAccountId);
      if (!resolved) {
        const errMsg = targetAccountId ? `Account not found: ${targetAccountId}` : "No accounts available.";
        await sendCommandMessage(input.sessionID, `▣ Anthropic Files (error)\n\n${errMsg}`);
        return;
      }
      const { account, label } = resolved;
      const authHeaders = await getFilesAuth(account);

      if (action === "upload") {
        const filePath = filteredArgs.slice(2).join(" ").trim();
        if (!filePath) {
          await sendCommandMessage(
            input.sessionID,
            "▣ Anthropic Files\n\nUsage: /anthropic files upload <path> [--account <email>]",
          );
          return;
        }
        const resolvedPath = resolve(filePath);
        if (!existsSync(resolvedPath)) {
          await sendCommandMessage(input.sessionID, `▣ Anthropic Files (error)\n\nFile not found: ${resolvedPath}`);
          return;
        }
        const content = readFileSync(resolvedPath);
        const filename = basename(resolvedPath);
        const blob = new Blob([content]);
        const form = new FormData();
        form.append("file", blob, filename);
        form.append("purpose", "assistants");
        const res = await fetch(`${apiBase}/v1/files`, {
          method: "POST",
          headers: {
            authorization: authHeaders.authorization,
            "anthropic-beta": "oauth-2025-04-20,files-api-2025-04-14",
          },
          body: form,
        });
        if (!res.ok) {
          const errBody = await res.text();
          await sendCommandMessage(
            input.sessionID,
            `▣ Anthropic Files (error) [${label}]\n\nUpload failed (HTTP ${res.status}): ${errBody}`,
          );
          return;
        }
        const file = (await res.json()) as { id: string; filename: string; size?: number };
        const sizeKB = ((file.size || 0) / 1024).toFixed(1);
        fileAccountMap.set(file.id, account.index);
        await sendCommandMessage(
          input.sessionID,
          `▣ Anthropic Files [${label}]\n\nUploaded: ${file.id}\n  Filename: ${file.filename}\n  Size: ${sizeKB} KB`,
        );
        return;
      }

      if (action === "get" || action === "info") {
        const fileId = filteredArgs[2]?.trim();
        if (!fileId) {
          await sendCommandMessage(
            input.sessionID,
            "▣ Anthropic Files\n\nUsage: /anthropic files get <file_id> [--account <email>]",
          );
          return;
        }
        const res = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}`, { headers: authHeaders });
        if (!res.ok) {
          const errBody = await res.text();
          await sendCommandMessage(
            input.sessionID,
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
        fileAccountMap.set(file.id, account.index);
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
        await sendCommandMessage(input.sessionID, lines.join("\n"));
        return;
      }

      if (action === "delete" || action === "rm") {
        const fileId = filteredArgs[2]?.trim();
        if (!fileId) {
          await sendCommandMessage(
            input.sessionID,
            "▣ Anthropic Files\n\nUsage: /anthropic files delete <file_id> [--account <email>]",
          );
          return;
        }
        const res = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}`, {
          method: "DELETE",
          headers: authHeaders,
        });
        if (!res.ok) {
          const errBody = await res.text();
          await sendCommandMessage(
            input.sessionID,
            `▣ Anthropic Files (error) [${label}]\n\nHTTP ${res.status}: ${errBody}`,
          );
          return;
        }
        fileAccountMap.delete(fileId);
        await sendCommandMessage(input.sessionID, `▣ Anthropic Files [${label}]\n\nDeleted: ${fileId}`);
        return;
      }

      if (action === "download" || action === "dl") {
        const fileId = filteredArgs[2]?.trim();
        if (!fileId) {
          await sendCommandMessage(
            input.sessionID,
            "▣ Anthropic Files\n\nUsage: /anthropic files download <file_id> [output_path] [--account <email>]",
          );
          return;
        }
        const outputPath = filteredArgs.slice(3).join(" ").trim();
        const metaRes = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}`, { headers: authHeaders });
        if (!metaRes.ok) {
          const errBody = await metaRes.text();
          await sendCommandMessage(
            input.sessionID,
            `▣ Anthropic Files (error) [${label}]\n\nHTTP ${metaRes.status}: ${errBody}`,
          );
          return;
        }
        const meta = (await metaRes.json()) as { filename: string };
        const savePath = outputPath ? resolve(outputPath) : resolve(meta.filename);
        const res = await fetch(`${apiBase}/v1/files/${encodeURIComponent(fileId)}/content`, { headers: authHeaders });
        if (!res.ok) {
          const errBody = await res.text();
          await sendCommandMessage(
            input.sessionID,
            `▣ Anthropic Files (error) [${label}]\n\nDownload failed (HTTP ${res.status}): ${errBody}`,
          );
          return;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        writeFileSync(savePath, buffer);
        const sizeKB = (buffer.length / 1024).toFixed(1);
        await sendCommandMessage(
          input.sessionID,
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
      await sendCommandMessage(input.sessionID, helpLines.join("\n"));
      return;
    } catch (err) {
      await sendCommandMessage(input.sessionID, `▣ Anthropic Files (error)\n\n${(err as Error).message}`);
      return;
    }
  }

  // Interactive CLI command is not compatible with slash flow.
  if (primary === "manage" || primary === "mg") {
    await sendCommandMessage(
      input.sessionID,
      "▣ Anthropic\n\n`manage` is interactive-only. Use granular slash commands (switch/enable/disable/remove/reset) or run `opencode-anthropic-auth manage` in a terminal.",
    );
    return;
  }

  // Route remaining commands through the CLI command surface.
  const cliArgs = [...args];
  if (cliArgs.length === 0) cliArgs.push("list");

  // Avoid readline prompts in slash mode.
  if (
    (primary === "remove" || primary === "rm" || primary === "logout" || primary === "lo") &&
    !cliArgs.includes("--force")
  ) {
    cliArgs.push("--force");
  }

  const result = await runCliCommand(cliArgs);
  const heading = result.code === 0 ? "▣ Anthropic" : "▣ Anthropic (error)";
  const body = result.stdout || result.stderr || "No output.";
  await sendCommandMessage(input.sessionID, [heading, "", body].join("\n"));
  await reloadAccountManagerFromDisk();
}
