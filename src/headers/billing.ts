import { createHash } from "node:crypto";
import { isFalsyEnv } from "../env.js";

export function buildAnthropicBillingHeader(claudeCliVersion: string, messages: unknown[]): string {
  if (isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";

  // CC derives a 3-char hash from the first user message content using SHA-256
  // with salt "59cf53e54c78", extracting chars at positions [4,7,20] and appending
  // the CLI version, then taking the first 3 hex chars of that combined string.
  let versionSuffix = "";
  if (Array.isArray(messages)) {
    const firstUserMsg = messages.find(
      (m) =>
        m !== null &&
        typeof m === "object" &&
        (m as Record<string, unknown>).role === "user" &&
        typeof (m as Record<string, unknown>).content === "string",
    ) as Record<string, unknown> | undefined;
    if (firstUserMsg) {
      const text = firstUserMsg.content as string;
      const salt = "59cf53e54c78";
      const picked = [4, 7, 20].map((i) => (i < text.length ? text[i] : "")).join("");
      const hash = createHash("sha256")
        .update(salt + picked)
        .digest("hex");
      versionSuffix = `.${hash.slice(0, 3)}`;
    }
  }

  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "cli";
  // CC uses a fixed cch value "00000" in the billing template
  return `x-anthropic-billing-header: cc_version=${claudeCliVersion}${versionSuffix}; cc_entrypoint=${entrypoint}; cch=00000;`;
}
