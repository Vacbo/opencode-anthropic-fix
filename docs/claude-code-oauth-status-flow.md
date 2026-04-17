# Claude Code OAuth status flow

This note captures what the project observed in fresh **login-only** Claude Code sessions exported from Proxyman and explains why the CLI keeps using `/api/oauth/usage` for quota display.

## User-flow view

### When the user logs in

Claude Code does not appear to perform a single “login request” and stop. In the fresh login-only HARs, the visible flow looked like this:

1. authenticate and obtain a usable OAuth bearer
2. fetch account-level context
3. fetch quota/status context
4. fetch CLI/bootstrap context
5. establish a remote code session and worker presence

That is why the post-login flow fans out into multiple endpoints instead of a single token exchange.

## Observed login-only flow

Fresh HAR sources:

- `manifests/reports/proxyman/live-login/login-session.har`
- `manifests/reports/proxyman/live-login/login-session-2026-04-15T23-32-55Z.har`

Observed OAuth/account/bootstrap endpoints:

1. `GET /api/oauth/account/settings`
2. `GET /api/oauth/profile`
3. `GET /api/oauth/claude_cli/roles`
4. `GET /api/oauth/usage`
5. `GET /api/claude_cli/bootstrap`

Observed adjacent login/session endpoints:

- `POST /v1/code/sessions`
- `POST /v1/code/sessions/.../bridge`
- `GET /v1/code/sessions/.../worker`
- `GET /v1/code/sessions/.../worker/events/stream`
- `POST /v1/code/sessions/.../client/presence`
- `POST /v1/code/sessions/.../worker/heartbeat`
- `PUT /v1/code/sessions/.../worker`
- `POST /api/event_logging/v2/batch`

## How each endpoint links into the user flow

| User-visible phase | Endpoint | Why it appears there |
|---|---|---|
| Login completed, account context loads | `/api/oauth/profile` | Identifies the user/account/org/application behind the OAuth credential |
| Login completed, account flags load | `/api/oauth/account/settings` | Pulls account-level settings and feature flags |
| Login completed, CLI entitlement/role context loads | `/api/oauth/claude_cli/roles` | Gives the CLI role/permission context after login |
| Login completed, quota/status UI loads | `/api/oauth/usage` | Returns the bucket data that powers the quota bars |
| Login completed, CLI feature/bootstrap state loads | `/api/claude_cli/bootstrap` | Initializes CLI-side runtime feature/config state |
| CLI starts or resumes a remote coding session | `/v1/code/sessions` and `/v1/code/sessions/...` | Establishes and maintains the remote session/worker graph |

## Why `/api/oauth/usage` is the quota endpoint

In the fresh HAR, `/api/oauth/usage` is the **only observed endpoint** returning the quota-bucket shape used by the CLI bars:

- `five_hour`
- `seven_day`
- `seven_day_sonnet`

That makes it the correct endpoint for quota display.

The other observed OAuth endpoints appear to serve adjacent purposes:

- `/api/oauth/profile` — account, organization, and application metadata
- `/api/oauth/account/settings` — user/account settings flags and feature toggles
- `/api/oauth/claude_cli/roles` — CLI role/permission context
- `/api/claude_cli/bootstrap` — CLI/bootstrap feature config

## Auth/header model observed in the HAR

### `/api/oauth/usage`

- `Authorization: Bearer <oauth access token>`
- `anthropic-beta: oauth-2025-04-20`

### `/api/oauth/profile`

- `Authorization: Bearer <oauth access token>`
- `User-Agent: axios/1.13.6`
- `Accept: application/json, text/plain, */*`

### `/api/oauth/account/settings`

- `Authorization: Bearer <oauth access token>`
- `User-Agent: claude-code/<version>`
- `anthropic-beta: oauth-2025-04-20`

## Project implications

The project should keep using `/api/oauth/usage` for quota bars.

The newly observed `/api/oauth/profile` call is useful for enriching the CLI display when a reused Claude Code credential does not have a stored email. We use it as a fallback metadata source for account labels.

We do **not** treat `/api/claude_code/settings` or `/api/claude_code/policy_limits` as the quota endpoint based on the fresh login-only captures. They may still matter in other flows, but they were not the source of quota-bar data here.
