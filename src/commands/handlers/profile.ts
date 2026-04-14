import type { AnthropicAuthConfig } from "../../config.js";
import { loadConfigFresh, saveConfig } from "../../config.js";
import { listSignatureProfiles, resolveSignatureProfile } from "../../profiles/index.js";

export interface ProfileHandlerDeps {
    sendCommandMessage: (sessionID: string, message: string) => Promise<void>;
    config: AnthropicAuthConfig;
}

export async function handleProfileCommand(sessionID: string, args: string[], deps: ProfileHandlerDeps): Promise<void> {
    const { sendCommandMessage, config } = deps;
    const requestedProfile = args[1]?.trim();

    if (!requestedProfile) {
        const fresh = loadConfigFresh();
        const currentProfile = resolveSignatureProfile(fresh.signature_profile);
        const lines = [
            "▣ Anthropic Profile",
            "",
            `current: ${currentProfile.id}`,
            `name: ${currentProfile.name}`,
            `description: ${currentProfile.description}`,
            "",
            "available:",
            ...listSignatureProfiles().map((profile) => `  ${profile.id} — ${profile.name}`),
            "",
            "Set with: /anthropic profile <profile-id>",
        ];
        await sendCommandMessage(sessionID, lines.join("\n"));
        return;
    }

    try {
        const nextProfile = resolveSignatureProfile(requestedProfile);
        saveConfig({ signature_profile: nextProfile.id });
        Object.assign(config, loadConfigFresh());
        await sendCommandMessage(sessionID, `▣ Anthropic Profile\n\nprofile = ${nextProfile.id}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await sendCommandMessage(sessionID, `▣ Anthropic Profile (error)\n\n${message}`);
    }
}
