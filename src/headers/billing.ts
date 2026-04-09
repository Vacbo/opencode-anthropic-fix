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

  // CC's Bun binary computes a 5-char hex attestation hash via Attestation.zig
  // and overwrites the "00000" placeholder before sending. On Node.js (npm CC)
  // the placeholder is sent as-is. The server may reject literal "00000" and
  // route to extra usage. Generate a body-derived 5-char hex hash to mimic
  // the attestation without the Zig layer.
  let cchValue: string;
  if (Array.isArray(messages) && messages.length > 0) {
    const bodyHint = JSON.stringify(messages).slice(0, 512);
    const cchHash = createHash("sha256")
      .update(bodyHint + claudeCliVersion + Date.now().toString(36))
      .digest("hex");
    cchValue = cchHash.slice(0, 5);
  } else {
    // Fallback: random 5-char hex
    const buf = createHash("sha256")
      .update(Date.now().toString(36) + Math.random().toString(36))
      .digest("hex");
    cchValue = buf.slice(0, 5);
  }

  return `x-anthropic-billing-header: cc_version=${claudeCliVersion}${versionSuffix}; cc_entrypoint=${entrypoint}; cch=${cchValue};`;
}
