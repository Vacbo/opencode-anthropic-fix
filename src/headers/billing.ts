import { createHash } from "node:crypto";
import { CCH_PLACEHOLDER } from "./cch.js";
import { isFalsyEnv } from "../env.js";

export function buildAnthropicBillingHeader(claudeCliVersion: string, messages: unknown[]): string {
    if (isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";

    // CC derives the 3-char cc_version suffix from the first user message using
    // SHA-256 with salt "59cf53e54c78" and positions [4,7,20]. The cch field is
    // emitted here as the literal placeholder "00000" and replaced later, after
    // full-body serialization, by replaceNativeStyleCch() in src/headers/cch.ts.
    let versionSuffix = "";
    if (Array.isArray(messages)) {
        // Find first user message (CC uses first non-meta user turn)
        const firstUserMsg = messages.find(
            (m) => m !== null && typeof m === "object" && (m as Record<string, unknown>).role === "user",
        ) as Record<string, unknown> | undefined;
        if (firstUserMsg) {
            // Extract text from string or content-block array
            let text = "";
            const content = firstUserMsg.content;
            if (typeof content === "string") {
                text = content;
            } else if (Array.isArray(content)) {
                const textBlock = (content as Array<Record<string, unknown>>).find((b) => b.type === "text");
                if (textBlock && typeof textBlock.text === "string") {
                    text = textBlock.text;
                }
            }
            if (text) {
                const salt = "59cf53e54c78";
                const picked = [4, 7, 20].map((i) => (i < text.length ? text[i] : "0")).join("");
                const hash = createHash("sha256")
                    .update(salt + picked + claudeCliVersion)
                    .digest("hex");
                versionSuffix = `.${hash.slice(0, 3)}`;
            }
        }
    }

    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "sdk-cli";

    return `x-anthropic-billing-header: cc_version=${claudeCliVersion}${versionSuffix}; cc_entrypoint=${entrypoint}; cch=${CCH_PLACEHOLDER};`;
}
