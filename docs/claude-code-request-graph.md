# Claude Code request graph

This note documents the **request graph** Claude Code appears to execute around login, status/bootstrap, title generation, quota probing, remote code-session setup, and the final chat request.

It is based on two evidence sources:

1. **Fresh Proxyman HAR captures** from real local Claude Code runs
2. **Local code tracing** in this repo where we intentionally modeled request classes that were already visible on the wire

The important conclusion is simple:

> Claude Code does **not** behave like “one user turn = one HTTP request”.
>
> It behaves like a **request graph** with multiple specialized calls before and around the main model invocation.

## Evidence sources

- `manifests/reports/proxyman/live-login/login-session.har`
- `manifests/reports/proxyman/live-login/login-session-2026-04-15T23-32-55Z.har`
- `manifests/reports/proxyman/minimal-hi-2026-04-15T22-59-13-765Z/`
- `src/request/body.ts`

## Graph overview

```text
Login / bootstrap flow
  ├─ /api/oauth/account/settings
  ├─ /api/oauth/profile
  ├─ /api/oauth/claude_cli/roles
  ├─ /api/oauth/usage
  ├─ /api/claude_cli/bootstrap
  ├─ /v1/code/sessions
  └─ /v1/code/sessions/... worker/presence/heartbeat/events

Single visible “chat turn” flow
  ├─ quota probe           (Haiku, max_tokens=1, no stream)
  ├─ title generation      (Haiku, streamed, 32000)
  └─ main inference        (Opus, streamed, 64000)
```

## User-flow view

The easiest way to read this graph is as a sequence of user-visible phases:

1. **User logs in**
2. **Claude Code loads account, quota, and bootstrap context**
3. **Claude Code creates or resumes a remote coding session**
4. **User submits a visible chat turn**
5. **Claude Code may issue a quota probe and/or title generation request before the main answer request**

So the graph is not just “background noise.” It is how Claude Code links the user’s visible session lifecycle to its backend state.

## 1. Login and bootstrap graph

Fresh login-only HARs showed these endpoints in the same session:

### OAuth/account/bootstrap endpoints

- `GET /api/oauth/account/settings`
- `GET /api/oauth/profile`
- `GET /api/oauth/claude_cli/roles`
- `GET /api/oauth/usage`
- `GET /api/claude_cli/bootstrap`

### Remote session graph

- `POST /v1/code/sessions`
- `POST /v1/code/sessions/.../bridge`
- `GET /v1/code/sessions/.../worker`
- `GET /v1/code/sessions/.../worker/events/stream`
- `POST /v1/code/sessions/.../client/presence`
- `POST /v1/code/sessions/.../worker/heartbeat`
- `PUT /v1/code/sessions/.../worker`

### Interpretation

This implies Claude Code does more than “login and then wait for the first chat request.”

It appears to establish:

1. **account context** (`profile`, `roles`, `settings`)
2. **quota/status context** (`usage`)
3. **bootstrap/config state** (`claude_cli/bootstrap`)
4. **remote session state** (`/v1/code/sessions` + worker endpoints)

That remote-session setup matters because later requests in the same HAR used a different bearer token class for worker/session endpoints than for the OAuth/account endpoints.

### User-flow linkage

- **User logs in** → OAuth/account/bootstrap endpoints fire
- **Claude Code becomes ready** → remote session endpoints appear
- **Quota/status UI becomes meaningful** → `/api/oauth/usage` provides bucket data
- **Session title appears** → title-generator Haiku request
- **Main answer appears** → Opus request

## 2. Quota/profile/status graph

Observed login-only endpoints and likely purpose:

| Endpoint                      | Observed auth               | Why it exists                                |
| ----------------------------- | --------------------------- | -------------------------------------------- |
| `/api/oauth/usage`            | Bearer + `oauth-2025-04-20` | Returns the quota buckets used for CLI bars  |
| `/api/oauth/profile`          | Bearer                      | Returns account/org/application metadata     |
| `/api/oauth/account/settings` | Bearer + `oauth-2025-04-20` | Returns account-level feature/settings flags |
| `/api/oauth/claude_cli/roles` | Bearer                      | Returns role/permission context              |
| `/api/claude_cli/bootstrap`   | Bearer + `oauth-2025-04-20` | Returns CLI bootstrap/config features        |

The key point is that **quota bars** come from `/api/oauth/usage`, not from `settings` or `policy_limits`, because it is the only observed endpoint returning the bucket shape:

- `five_hour`
- `seven_day`
- `seven_day_sonnet`

That is why the project continues to use `/api/oauth/usage` for quota display.

## 3. Title / probe / main inference graph

Fresh HAR inspection of the message path showed three distinct request classes:

### A. Quota probe

- model: `claude-haiku-4-5-20251001`
- first user text: `quota`
- `max_tokens: 1`
- no `stream`

This is not a user-facing completion. It is a tiny specialized request.

### B. Title generation

- model: `claude-haiku-4-5`
- first user text begins with: `Generate a title for this conversation:`
- `max_tokens: 32000`
- `stream: true`

This is a session-title / conversation-title request, not the main answer.

### C. Main inference

- model: `claude-opus-4-6`
- `max_tokens: 64000`
- `stream: true`
- carries the real user-turn hook/prompt content

### Why this matters

This is **not** a model redirect chain like “Haiku failed, then it retried on Opus.”

It is an intentional sequence of **different-purpose requests**:

1. tiny probe
2. cheap title generation
3. real answer generation

### User-flow linkage

For a human user, this often feels like “I typed one message.”

But the observed flow is:

1. tiny quota probe
2. title-generation request
3. main model request

That is why looking at only the final `/v1/messages` call can lead to false conclusions about redirects or fallback behavior.

The project’s request-class modeling in `src/request/body.ts` now reflects that evidence.

## 4. Remote session / worker graph

The login/bootstrap HAR also showed a second-stage token/session model:

- OAuth/account endpoints used one bearer token class
- worker/session endpoints used another bearer token class on `/v1/code/sessions/...`

That suggests Claude Code mints or receives a **session-scoped credential** after bootstrap for the worker/session graph.

Observed worker/session endpoints included:

- `/v1/code/sessions/.../worker`
- `/v1/code/sessions/.../worker/events/stream`
- `/v1/code/sessions/.../worker/heartbeat`
- `/v1/code/sessions/.../client/presence`

This is a meaningful reverse-engineering result because it shows the CLI is not just a thin `/v1/messages` wrapper. It maintains a session model with background worker traffic.

## 5. Clean `hi` run: Claude-Code-specific endpoint cluster

A clean, isolated OG Claude Code `hi` run captured in:

- `manifests/reports/proxyman/live-hi/claude-hi-clean.har`

showed this endpoint cluster for a single visible user turn:

1. `GET /api/claude_code/settings` → 404
2. `POST /api/eval/sdk-zAZezfDKGoZuXXKe` → 200
3. `POST /v1/messages?beta=true` → 200
4. `GET /api/claude_code/policy_limits` → 200
5. `POST /api/claude_code/metrics` → 200
6. `POST /api/event_logging/v2/batch` → 200

### Important auth finding

The **same `x-api-key`** was reused across:

- `claude_code/settings`
- `claude_code/policy_limits`
- `claude_code/metrics`
- the successful main `/v1/messages` request

In the clean HAR, that key classifies as:

- prefix: `sk-ant-api03-...`
- length: `108`

It is **not** the same value as the observed OAuth access bearer token class (`sk-ant-oat01-...`).

That means the successful Claude Code message path is using a **distinct API-key credential**, not simply reusing the stored OAuth access token under a different header name.

That makes the key look like a **Claude-Code-issued session/client credential**, not just a one-off message-only key.

### Important negative finding

The clean HAR did **not** show Datadog tracing headers such as:

- `traceparent`
- `x-datadog-trace-id`
- `x-datadog-parent-id`

So while there is clearly telemetry traffic (`/api/eval/...` and `/api/event_logging/v2/batch`), this capture does not prove Datadog header propagation on the wire.

Another important negative finding: exhaustive local searches in likely Claude Code storage locations found **no persistent `sk-ant-api...` key outside transcripts/history files**. That suggests the working API key is either obtained dynamically or stored somewhere outside the ordinary config/state files we searched.

### Why this matters for parity

This is the strongest current reason **not** to “fix” the plugin by simply forcing some API key on `/v1/messages`.

The observed key is tied to a broader Claude-Code-specific endpoint cluster. If that key is obtained through a post-login/session transition we have not yet reproduced, then using the wrong key path can succeed technically while still consuming the wrong billing/usage bucket.

This also means the project should **not** assume that the visible OAuth token refresh/bootstrap flow is sufficient to reconstruct the real Claude Code quota-preserving message path.

## 6. Project implications

The project should reason about Claude Code as a **graph of endpoint classes**, not a single API call.

### Immediate modeling choices already justified

- keep quotas on `/api/oauth/usage`
- use `/api/oauth/profile` as a fallback identity source for CLI display
- treat title generation as a separate Haiku request class
- treat the tiny `quota` call as a separate probe request class

### Things that should not be assumed from this graph alone

- that `settings` or `policy_limits` replace quota bars
- that Haiku → Opus means fallback/retry
- that the worker/session bearer token can be synthesized from the OAuth token without more evidence

## 7. Current replication status

What the project now partially replicates:

- quota/status endpoint choice for OAuth quota bars
- profile lookup for CLI identity fallback
- title-generator and quota-probe request-class shaping
- main inference request shaping for the message path

What remains only partially understood:

- full bootstrap semantics of `/api/claude_cli/bootstrap`
- exact role/settings interplay after login
- remote worker/session token issuance and reuse

## 8. Bottom line

The main reverse-engineering lesson is:

> Claude Code is a **stateful client with multiple endpoint classes**, not just a single `/v1/messages` caller.

Any parity work that only looks at the final model request will miss:

- login/bootstrap context
- status/quota calls
- title/probe side requests
- remote code-session worker traffic
