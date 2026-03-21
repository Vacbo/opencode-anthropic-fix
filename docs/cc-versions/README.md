# Claude Code Version Fingerprints

Each file in this directory captures the exact fingerprint of a specific Claude Code version. When a new CC version is released, extract its fingerprint and save it here.

Use the `cc-version-tracker` or `cc-mimicry-auditor` skills to automate extraction.

## Current baseline

- [2.1.81.md](2.1.81.md) — Current alignment target (2026-03-21)
- [2.1.80.md](2.1.80.md) — Previous version (2026-03-20)

## Shared across versions (stable since 2.1.79)

These values have NOT changed between 2.1.79 and 2.1.81:

- **Production client ID**: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- **Staging client ID**: `22422756-60c9-4084-8eb7-27705fd5cf9a`
- **OAuth endpoints**: `platform.claude.com` (token, authorize, callback, revoke)
- **Claude AI authorize**: `claude.ai/oauth/authorize`
- **PKCE**: S256, base64url, 32-byte verifier
- **Token exchange**: Axios POST, `Content-Type: application/json`
- **OAuth beta**: `oauth-2025-04-20`
- **Identity string**: `You are Claude Code, Anthropic's official CLI for Claude.`
- **anthropic-version**: `2023-06-01`
- **Billing cch**: `00000` (fixed)
- **Billing hash salt**: `59cf53e54c78`, positions [4,7,20]

## Version-specific values

These values change per CC release and are documented in each version file:

- CLI version string (User-Agent, billing cc_version)
- Anthropic SDK version (x-stainless-package-version)
- Axios version (OAuth token UA)
- OAuth scopes (may expand over time)
- Beta flags (new flags added, old ones removed)
- BEDROCK_UNSUPPORTED set
- Default timeout
