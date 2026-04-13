import { confirm, isCancel, log, note, select } from "@clack/prompts";
import {
    type AccountSelectionStrategy,
    getConfigPath,
    loadConfig,
    saveConfig,
    VALID_STRATEGIES,
} from "../../config.js";
import { createDefaultStats, getStoragePath, loadAccounts, saveAccounts, type AccountMetadata } from "../../storage.js";
import { c, pad, shortPath } from "../formatting.js";
import { cmdStats } from "./auth.js";

type ManageAction = "switch" | "enable" | "disable" | "remove" | "reset" | "strategy" | "quit";

const STRATEGY_DESCRIPTIONS: Record<AccountSelectionStrategy, string> = {
    sticky: "Stay on one account until it fails or is rate-limited",
    "round-robin": "Rotate through accounts on every request",
    hybrid: "Prefer healthy accounts, rotate when degraded",
};

function cmdGroupHelp(group: "usage" | "config" | "manage") {
    const bin = "opencode-anthropic-auth";

    switch (group) {
        case "usage":
            console.log(`
${c.bold("Usage Commands")}

  ${pad(c.cyan("stats"), 20)}Show per-account usage statistics
  ${pad(c.cyan("reset-stats") + " [N|all]", 20)}Reset usage statistics
  ${pad(c.cyan("status"), 20)}Compact one-liner for scripts/prompts (alias: st)

${c.dim("Examples:")}
  ${bin} usage stats
  ${bin} usage status
`);
            return 0;
        case "config":
            console.log(`
${c.bold("Config Commands")}

  ${pad(c.cyan("show"), 20)}Show current configuration and file paths (alias: cfg)
  ${pad(c.cyan("strategy") + " [name]", 20)}Show or change selection strategy (alias: strat)

${c.dim("Examples:")}
  ${bin} config show
  ${bin} config strategy round-robin
`);
            return 0;
        case "manage":
            console.log(`
${c.bold("Manage Command")}

  ${pad(c.cyan("manage"), 20)}Interactive account management menu (alias: mg)

${c.dim("Examples:")}
  ${bin} manage
`);
            return 0;
    }
}

function renderManageAccounts(
    accounts: AccountMetadata[],
    activeIndex: number,
    currentStrategy: AccountSelectionStrategy,
) {
    console.log("");
    console.log(c.bold(`${accounts.length} account(s):`));
    for (let i = 0; i < accounts.length; i++) {
        const num = i + 1;
        const label = accounts[i].email || `Account ${num}`;
        const active = i === activeIndex ? c.green(" (active)") : "";
        const disabled = !accounts[i].enabled ? c.yellow(" [disabled]") : "";
        console.log(`  ${c.bold(String(num))}. ${label}${active}${disabled}`);
    }
    console.log("");
    console.log(c.dim(`Strategy: ${currentStrategy}`));
}

function buildManageTargetOptions(accounts: AccountMetadata[], activeIndex: number) {
    return accounts.map((account, index) => {
        const num = index + 1;
        const label = account.email || `Account ${num}`;
        const statuses = [index === activeIndex ? "active" : null, !account.enabled ? "disabled" : null].filter(
            Boolean,
        );

        return {
            value: String(index),
            label: `#${num} ${label}`,
            hint: statuses.length > 0 ? statuses.join(", ") : undefined,
        };
    });
}

export async function cmdConfig() {
    const config = loadConfig();
    const stored = await loadAccounts();

    log.info(c.bold("Anthropic Auth Configuration"));

    const generalLines = [
        `Strategy:          ${c.cyan(config.account_selection_strategy)}`,
        `Failure TTL:       ${config.failure_ttl_seconds}s`,
        `Debug:             ${config.debug ? c.yellow("on") : "off"}`,
    ];
    note(generalLines.join("\n"), "General");

    const healthLines = [
        `Initial:         ${config.health_score.initial}`,
        `Success reward:  +${config.health_score.success_reward}`,
        `Rate limit:      ${config.health_score.rate_limit_penalty}`,
        `Failure:         ${config.health_score.failure_penalty}`,
        `Recovery/hour:   +${config.health_score.recovery_rate_per_hour}`,
        `Min usable:      ${config.health_score.min_usable}`,
    ];
    note(healthLines.join("\n"), "Health Score");

    const bucketLines = [
        `Max tokens:      ${config.token_bucket.max_tokens}`,
        `Regen/min:       ${config.token_bucket.regeneration_rate_per_minute}`,
        `Initial:         ${config.token_bucket.initial_tokens}`,
    ];
    note(bucketLines.join("\n"), "Token Bucket");

    const fileLines = [
        `Config:          ${shortPath(getConfigPath())}`,
        `Accounts:        ${shortPath(getStoragePath())}`,
    ];
    if (stored) {
        const enabled = stored.accounts.filter((account) => account.enabled).length;
        fileLines.push(`Accounts total:  ${stored.accounts.length} (${enabled} enabled)`);
    } else {
        fileLines.push("Accounts total:  none");
    }
    note(fileLines.join("\n"), "Files");

    const envOverrides: string[] = [];
    if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
        envOverrides.push(`OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY}`);
    }
    if (process.env.OPENCODE_ANTHROPIC_DEBUG) {
        envOverrides.push(`OPENCODE_ANTHROPIC_DEBUG=${process.env.OPENCODE_ANTHROPIC_DEBUG}`);
    }
    if (envOverrides.length > 0) {
        log.warn("Environment overrides:\n" + envOverrides.map((override) => `  ${c.yellow(override)}`).join("\n"));
    }

    return 0;
}

export async function cmdStrategy(arg?: string) {
    const config = loadConfig();

    if (!arg) {
        log.info(c.bold("Account Selection Strategy"));

        const lines = VALID_STRATEGIES.map((strategy) => {
            const current = strategy === config.account_selection_strategy;
            const marker = current ? c.green("▸ ") : "  ";
            const name = current ? c.bold(c.cyan(strategy)) : c.dim(strategy);
            const description = current ? STRATEGY_DESCRIPTIONS[strategy] : c.dim(STRATEGY_DESCRIPTIONS[strategy]);
            return `${marker}${pad(name, 16)}${description}`;
        });
        log.message(lines.join("\n"));

        log.message(c.dim(`Change with: opencode-anthropic-auth strategy <${VALID_STRATEGIES.join("|")}>`));

        if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
            log.warn(
                `OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY} overrides config file at runtime.`,
            );
        }

        return 0;
    }

    const normalized = arg.toLowerCase().trim();
    if (!VALID_STRATEGIES.includes(normalized as AccountSelectionStrategy)) {
        log.error(`Invalid strategy '${arg}'. Valid strategies: ${VALID_STRATEGIES.join(", ")}`);
        return 1;
    }

    if (normalized === config.account_selection_strategy && !process.env.OPENCODE_ANTHROPIC_STRATEGY) {
        log.message(c.dim(`Strategy is already '${normalized}'.`));
        return 0;
    }

    saveConfig({ account_selection_strategy: normalized });
    log.success(`Strategy changed to '${normalized}'.`);

    if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
        log.warn(
            `OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY} will override this at runtime.`,
        );
    }

    return 0;
}

export async function cmdStatus() {
    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        console.log("anthropic: no accounts configured");
        return 1;
    }

    const config = loadConfig();
    const total = stored.accounts.length;
    const enabled = stored.accounts.filter((account) => account.enabled).length;
    const now = Date.now();

    let rateLimited = 0;
    for (const account of stored.accounts) {
        if (!account.enabled) continue;
        const resetTimes = account.rateLimitResetTimes || {};
        const maxReset = Math.max(0, ...Object.values(resetTimes));
        if (maxReset > now) rateLimited++;
    }

    let line = `anthropic: ${total} account${total !== 1 ? "s" : ""} (${enabled} active)`;
    line += `, strategy: ${config.account_selection_strategy}`;
    line += `, next: #${stored.activeIndex + 1}`;
    if (rateLimited > 0) {
        line += `, ${rateLimited} rate-limited`;
    }

    console.log(line);
    return 0;
}

export async function cmdResetStats(arg?: string) {
    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.warn("No accounts configured.");
        return 1;
    }

    const now = Date.now();

    if (!arg || arg === "all") {
        for (const account of stored.accounts) {
            account.stats = createDefaultStats(now);
        }
        await saveAccounts(stored);
        log.success("Reset usage statistics for all accounts.");
        return 0;
    }

    const idx = parseInt(arg, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= stored.accounts.length) {
        log.error(`Invalid account number. Use 1-${stored.accounts.length} or 'all'.`);
        return 1;
    }

    stored.accounts[idx].stats = createDefaultStats(now);
    await saveAccounts(stored);
    const name = stored.accounts[idx].email || `Account ${idx + 1}`;
    log.success(`Reset usage statistics for ${name}.`);
    return 0;
}

export async function cmdManage() {
    let stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        console.log(c.yellow("No accounts configured."));
        console.log(c.dim("Run 'opencode auth login' and select 'Claude Pro/Max' to add accounts."));
        return 1;
    }

    if (!process.stdin.isTTY) {
        console.error(c.red("Error: 'manage' requires an interactive terminal."));
        console.error(c.dim("Use 'enable', 'disable', 'remove', 'switch' for non-interactive use."));
        return 1;
    }

    while (true) {
        stored = await loadAccounts();
        if (!stored || stored.accounts.length === 0) {
            console.log(c.dim("No accounts remaining."));
            break;
        }

        const accounts = stored.accounts;
        const activeIndex = stored.activeIndex;
        const currentStrategy = loadConfig().account_selection_strategy;

        renderManageAccounts(accounts, activeIndex, currentStrategy);

        const action = await select<ManageAction>({
            message: "Choose an action.",
            options: [
                { value: "switch", label: "Switch", hint: "set the active account" },
                { value: "enable", label: "Enable", hint: "re-enable a disabled account" },
                { value: "disable", label: "Disable", hint: "skip an account in rotation" },
                { value: "remove", label: "Remove", hint: "delete an account from storage" },
                { value: "reset", label: "Reset", hint: "clear rate-limit and failure tracking" },
                { value: "strategy", label: "Strategy", hint: currentStrategy },
                { value: "quit", label: "Quit", hint: "exit manage" },
            ],
        });
        if (isCancel(action) || action === "quit") break;

        if (action === "strategy") {
            const strategy = await select<AccountSelectionStrategy>({
                message: "Choose an account selection strategy.",
                initialValue: currentStrategy,
                options: VALID_STRATEGIES.map((value) => ({
                    value,
                    label: value,
                    hint: value === currentStrategy ? "current" : undefined,
                })),
            });
            if (isCancel(strategy)) break;
            saveConfig({ account_selection_strategy: strategy });
            console.log(c.green(`Strategy changed to '${strategy}'.`));
            continue;
        }

        const target = await select<string>({
            message: "Choose an account.",
            initialValue: String(activeIndex),
            options: buildManageTargetOptions(accounts, activeIndex),
        });
        if (isCancel(target)) break;

        const idx = Number.parseInt(target, 10);
        const num = idx + 1;

        switch (action) {
            case "switch": {
                if (!accounts[idx].enabled) {
                    console.log(c.yellow(`Account ${num} is disabled. Enable it first.`));
                    break;
                }
                stored.activeIndex = idx;
                await saveAccounts(stored);
                const switchLabel = accounts[idx].email || `Account ${num}`;
                console.log(c.green(`Switched to #${num} (${switchLabel}).`));
                break;
            }
            case "enable": {
                if (accounts[idx].enabled) {
                    console.log(c.dim(`Account ${num} is already enabled.`));
                    break;
                }
                stored.accounts[idx].enabled = true;
                await saveAccounts(stored);
                console.log(c.green(`Enabled account #${num}.`));
                break;
            }
            case "disable": {
                if (!accounts[idx].enabled) {
                    console.log(c.dim(`Account ${num} is already disabled.`));
                    break;
                }
                const enabledCount = accounts.filter((account) => account.enabled).length;
                if (enabledCount <= 1) {
                    console.log(c.red("Cannot disable the last enabled account."));
                    break;
                }
                stored.accounts[idx].enabled = false;
                if (idx === stored.activeIndex) {
                    const nextEnabled = accounts.findIndex(
                        (account, accountIndex) => accountIndex !== idx && account.enabled,
                    );
                    if (nextEnabled >= 0) stored.activeIndex = nextEnabled;
                }
                await saveAccounts(stored);
                console.log(c.yellow(`Disabled account #${num}.`));
                break;
            }
            case "remove": {
                const removeLabel = accounts[idx].email || `Account ${num}`;
                const removeConfirm = await confirm({
                    message: `Remove #${num} (${removeLabel})?`,
                });
                if (isCancel(removeConfirm)) break;
                if (removeConfirm) {
                    stored.accounts.splice(idx, 1);
                    if (stored.accounts.length === 0) {
                        stored.activeIndex = 0;
                    } else if (stored.activeIndex >= stored.accounts.length) {
                        stored.activeIndex = stored.accounts.length - 1;
                    } else if (stored.activeIndex > idx) {
                        stored.activeIndex--;
                    }
                    await saveAccounts(stored);
                    console.log(c.green(`Removed account #${num}.`));
                } else {
                    console.log(c.dim("Cancelled."));
                }
                break;
            }
            case "reset": {
                stored.accounts[idx].rateLimitResetTimes = {};
                stored.accounts[idx].consecutiveFailures = 0;
                stored.accounts[idx].lastFailureTime = null;
                await saveAccounts(stored);
                console.log(c.green(`Reset tracking for account #${num}.`));
                break;
            }
        }
    }

    return 0;
}

export function cmdHelp() {
    const bin = "opencode-anthropic-auth";
    console.log(`
${c.bold("Anthropic Multi-Account Auth CLI")}

${c.dim("Usage:")}
  ${bin} [group] [command] [args]
  ${bin} [command] [args] ${c.dim("(legacy format, still supported)")}
  oaa [group] [command] [args] ${c.dim("(short alias)")}

${c.dim("Command Groups:")}
  ${pad(c.cyan("auth"), 22)}Authentication: login, logout, reauth, refresh
  ${pad(c.cyan("account"), 22)}Account management: list, switch, enable, disable, remove, reset
  ${pad(c.cyan("usage"), 22)}Usage statistics: stats, reset-stats, status
  ${pad(c.cyan("config"), 22)}Configuration: show, strategy
  ${pad(c.cyan("manage"), 22)}Interactive account management menu

${c.dim("Auth Commands:")}
  ${pad(c.cyan("login"), 22)}Add a new account via browser OAuth (alias: ln)
  ${pad(c.cyan("logout") + " <N>", 22)}Revoke tokens and remove account N (alias: lo)
  ${pad(c.cyan("logout") + " --all", 22)}Revoke all tokens and clear all accounts
  ${pad(c.cyan("reauth") + " <N>", 22)}Re-authenticate account N (alias: ra)
  ${pad(c.cyan("refresh") + " <N>", 22)}Attempt token refresh (alias: rf)

${c.dim("Account Commands:")}
  ${pad(c.cyan("list"), 22)}Show all accounts with status ${c.dim("(default, alias: ls)")}
  ${pad(c.cyan("switch") + " <N>", 22)}Set account N as active (alias: sw)
  ${pad(c.cyan("enable") + " <N>", 22)}Enable a disabled account (alias: en)
  ${pad(c.cyan("disable") + " <N>", 22)}Disable an account (alias: dis)
  ${pad(c.cyan("remove") + " <N>", 22)}Remove an account permanently (alias: rm)
  ${pad(c.cyan("reset") + " <N|all>", 22)}Clear rate-limit / failure tracking

${c.dim("Usage Commands:")}
  ${pad(c.cyan("stats"), 22)}Show per-account usage statistics
  ${pad(c.cyan("reset-stats") + " [N|all]", 22)}Reset usage statistics
  ${pad(c.cyan("status"), 22)}Compact one-liner for scripts/prompts (alias: st)

${c.dim("Config Commands:")}
  ${pad(c.cyan("config"), 22)}Show configuration and file paths (alias: cfg)
  ${pad(c.cyan("strategy") + " [name]", 22)}Show or change selection strategy (alias: strat)

${c.dim("Manage Commands:")}
  ${pad(c.cyan("manage"), 22)}Interactive account management menu (alias: mg)
  ${pad(c.cyan("help"), 22)}Show this help message

${c.dim("Group Help:")}
  ${bin} auth help         ${c.dim("# Show auth commands")}
  ${bin} account help      ${c.dim("# Show account commands")}
  ${bin} usage help        ${c.dim("# Show usage commands")}
  ${bin} config help       ${c.dim("# Show config commands")}

${c.dim("Options:")}
  --force           Skip confirmation prompts
  --all             Target all accounts (for logout)
  --no-color        Disable colored output

${c.dim("Examples:")}
  ${bin} login             ${c.dim("# Add a new account via browser")}
  ${bin} auth login        ${c.dim("# Same as above (group format)")}
  oaa login             ${c.dim("# Same as above (short alias)")}
  ${bin} logout 2          ${c.dim("# Revoke tokens & remove account 2")}
  ${bin} auth logout 2     ${c.dim("# Same as above (group format)")}
  ${bin} list              ${c.dim("# Show all accounts (default)")}
  ${bin} account list      ${c.dim("# Same as above (group format)")}
  ${bin} switch 2          ${c.dim("# Make account 2 active")}
  ${bin} account switch 2  ${c.dim("# Same as above (group format)")}
  ${bin} stats             ${c.dim("# Show token usage per account")}
  ${bin} usage stats       ${c.dim("# Same as above (group format)")}

${c.dim("Files:")}
  Config:   ${shortPath(getConfigPath())}
  Accounts: ${shortPath(getStoragePath())}
`);
    return 0;
}

export async function dispatchUsageCommands(args: string[]) {
    const subcommand = args[0] || "stats";
    const arg = args[1];

    switch (subcommand) {
        case "stats":
            return cmdStats();
        case "reset-stats":
            return cmdResetStats(arg);
        case "status":
        case "st":
            return cmdStatus();
        case "help":
        case "-h":
        case "--help":
            return cmdGroupHelp("usage");
        default:
            console.error(c.red(`Unknown usage command: ${subcommand}`));
            console.error(c.dim("Run 'opencode-anthropic-auth usage help' for usage."));
            return 1;
    }
}

export async function dispatchConfigCommands(args: string[]) {
    const subcommand = args[0] || "show";
    const arg = args[1];

    switch (subcommand) {
        case "show":
        case "cfg":
            return cmdConfig();
        case "strategy":
        case "strat":
            return cmdStrategy(arg);
        case "help":
        case "-h":
        case "--help":
            return cmdGroupHelp("config");
        default:
            console.error(c.red(`Unknown config command: ${subcommand}`));
            console.error(c.dim("Run 'opencode-anthropic-auth config help' for usage."));
            return 1;
    }
}

export async function dispatchManageCommands(args: string[]) {
    const subcommand = args[0] || "manage";

    switch (subcommand) {
        case "manage":
        case "mg":
            return cmdManage();
        case "help":
        case "-h":
        case "--help":
            return cmdGroupHelp("manage");
        default:
            console.error(c.red(`Unknown manage command: ${subcommand}`));
            console.error(c.dim("Run 'opencode-anthropic-auth manage help' for usage."));
            return 1;
    }
}
