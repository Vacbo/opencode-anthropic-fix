// ---------------------------------------------------------------------------
// Interactive CLI account-management prompts
// ---------------------------------------------------------------------------

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { AccountManager } from "../accounts.js";

/**
 * Show the main account menu and return the user's choice.
 */
export async function promptAccountMenu(
    accountManager: AccountManager,
): Promise<"add" | "fresh" | "manage" | "cancel"> {
    const accounts = accountManager.getAccountsSnapshot();
    const currentIndex = accountManager.getCurrentIndex();
    const rl = createInterface({ input: stdin, output: stdout });

    try {
        console.log(`\n${accounts.length} account(s) configured:`);
        for (const acc of accounts) {
            const name = acc.email || `Account ${acc.index + 1}`;
            const active = acc.index === currentIndex ? " (active)" : "";
            const disabled = !acc.enabled ? " [disabled]" : "";
            console.log(`  ${acc.index + 1}. ${name}${active}${disabled}`);
        }
        console.log("");

        while (true) {
            const answer = await rl.question("(a)dd new, (f)resh start, (m)anage, (c)ancel? [a/f/m/c]: ");
            const normalized = answer.trim().toLowerCase();
            if (normalized === "a" || normalized === "add") return "add";
            if (normalized === "f" || normalized === "fresh") return "fresh";
            if (normalized === "m" || normalized === "manage") return "manage";
            if (normalized === "c" || normalized === "cancel") return "cancel";
            console.log("Please enter 'a', 'f', 'm', or 'c'.");
        }
    } finally {
        rl.close();
    }
}

/**
 * Show the manage-accounts sub-menu (toggle/delete accounts).
 */
export async function promptManageAccounts(accountManager: AccountManager): Promise<void> {
    const accounts = accountManager.getAccountsSnapshot();
    const rl = createInterface({ input: stdin, output: stdout });

    try {
        console.log("\nManage accounts:");
        for (const acc of accounts) {
            const name = acc.email || `Account ${acc.index + 1}`;
            const status = acc.enabled ? "enabled" : "disabled";
            console.log(`  ${acc.index + 1}. ${name} [${status}]`);
        }
        console.log("");

        while (true) {
            const answer = await rl.question("Enter account number to toggle, (d)N to delete (e.g. d1), or (b)ack: ");
            const normalized = answer.trim().toLowerCase();

            if (normalized === "b" || normalized === "back") return;

            // Delete: d1, d2, etc.
            const deleteMatch = normalized.match(/^d(\d+)$/);
            if (deleteMatch) {
                const idx = parseInt(deleteMatch[1], 10) - 1;
                if (idx >= 0 && idx < accounts.length) {
                    accountManager.removeAccount(idx);
                    console.log(`Removed account ${idx + 1}.`);
                    return;
                }
                console.log("Invalid account number.");
                continue;
            }

            // Toggle: just the number
            const num = parseInt(normalized, 10);
            if (!isNaN(num) && num >= 1 && num <= accounts.length) {
                const newState = accountManager.toggleAccount(num - 1);
                console.log(`Account ${num} is now ${newState ? "enabled" : "disabled"}.`);
                continue;
            }

            console.log("Invalid input.");
        }
    } finally {
        rl.close();
    }
}
