import { OAUTH_BETA_FLAG } from "../constants.js";

export interface OAuthBearerHeaderOptions {
    extraBetas?: readonly string[];
    includeOauthBeta?: boolean;
}

export function buildOAuthBearerHeaders(
    accessToken: string,
    options: OAuthBearerHeaderOptions = {},
): Record<string, string> {
    const { extraBetas = [], includeOauthBeta = true } = options;
    const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
    };
    const betas: string[] = [];
    if (includeOauthBeta) betas.push(OAUTH_BETA_FLAG);
    for (const beta of extraBetas) {
        if (beta && !betas.includes(beta)) betas.push(beta);
    }
    if (betas.length > 0) {
        headers["anthropic-beta"] = betas.join(",");
    }
    return headers;
}
