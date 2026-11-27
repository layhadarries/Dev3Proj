# API reference

All routes use `POST`, `application/json`, exact same-origin `Origin` metadata
and an active CSRF-safe same-origin policy. Public errors use
`Cache-Control: no-store` and `{ "error": "safe message" }`.

## Authentication

| Route | Auth | Request | Response |
|---|---|---|---|
| `/api/session/challenge` | Public | `{ "wallet": "Base58" }` | `{ "message": "..." }` plus short-lived pre-auth cookie |
| `/api/session` | Pre-auth browser cookie | `{ "wallet": "Base58", "signature": "base64" }` | `{ "wallet": "Base58" }`, authenticated and expired pre-auth cookies |
| `/api/session/logout` | Public route; revokes supplied session cookie | `{}` | `{ "ok": true }` plus expired session cookie |

## Agent and confirmation

| Route | Auth | Request | Response |
|---|---|---|---|
| `/api/parse` | Session | `{ "message": "..." }` | `ready`, `needs_clarification`, or `unsupported` |
| `/api/stage` | Session | `{ "recipient": "Base58", "amountBaseUnits": "string" }` | Server-owned confirmation card |
| `/api/confirm` | Session | `{ "id": "UUID" }` | `{ "intent": IntentWire }` |
| `/api/build` | Session | `{ "confirmationId": "UUID" }` | `{ "transaction": BuiltTransaction, "report": SecurityReportWire }` |
| `/api/explain` | Session | Security report object | Deterministic explanation |
| `/api/acknowledge` | Session | `{ "id": "UUID" }` | `{ "ok": true }` |
| `/api/handoff` | Session | `{ "id": "UUID" }` | `{ "wire": "base64" }` |
| `/api/submit` | Session | `{ "id": "UUID", "signed": "base64" }` | `{ "signature": "Base58" }` |

## Status codes

- `400`: malformed JSON, strict schema or invalid value
- `401`: missing/expired/revoked session or challenge
- `403`: Origin/Fetch Metadata rejected
- `405`: non-POST request
- `409`: invalid, foreign or stale confirmation state
- `413`: body exceeds 32 KiB
- `415`: wrong content type
- `429`: rate limit or in-flight limit; include `Retry-After`
- `502`: confirmed on-chain transaction failure
- `504`: broadcast or confirmation outcome uncertain; do not submit again
- `503`: process capacity/configuration unavailable
