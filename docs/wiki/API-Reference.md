# Web API reference

The Next.js API exposes POST-only JSON handlers through the catch-all route. The server checks exact same-origin `Origin` metadata and rejects cross-site Fetch Metadata when present. JSON responses use `Cache-Control: no-store`; errors are `{ "error": "safe message" }`. Request bodies are streamed with a 32 KiB cap and 10-second read deadline.

All endpoints are same-origin application routes, not a standalone public SDK. Protected routes require a valid wallet session cookie unless noted otherwise.

## Routes

| Endpoint | Authentication | Request | Success response |
|---|---|---|---|
| `POST /api/session/challenge` | Public | `{ "wallet": "<Base58 32-byte public key>" }` | `{ "message": "<challenge>" }`; sets a short-lived HttpOnly pre-auth context cookie |
| `POST /api/session` | Pre-auth context cookie | `{ "wallet": "<Base58 public key>", "signature": "<canonical base64 Ed25519 signature>" }` | `{ "wallet": "<Base58 public key>" }`; sets the authenticated session cookie and expires the pre-auth cookie |
| `POST /api/session/logout` | Public route; revokes the session cookie if present | `{}` | `{ "ok": true }`; expires the session cookie |
| `POST /api/parse` | Session | `{ "message": "<string, maximum 500 characters>" }` | `{ "status": "ready", "draft": { "recipient": "<Base58>", "amountBaseUnits": "<positive decimal>" }, "source": "rules" \| "llm" }`, or clarification/unsupported result |
| `POST /api/analyze` | Session | See [external analysis](#post-apianalyze) | `{ "report": SecurityReportWire }` |
| `POST /api/stage` | Session | `{ "recipient": "<Base58 public key>", "amountBaseUnits": "<positive canonical decimal u64>" }` | Server-owned confirmation card: `id`, `network`, `wallet`, `asset`, recipient, amount, expiry |
| `POST /api/confirm` | Session | `{ "id": "<UUID>" }` | `{ "intent": IntentWire }` |
| `POST /api/build` | Session | `{ "confirmationId": "<UUID>" }` | `{ "transaction": BuiltTransaction, "report": SecurityReportWire }` |
| `POST /api/explain` | Session | `SecurityReportWire` object | Deterministic explanation (presentation only) |
| `POST /api/acknowledge` | Session | `{ "id": "<UUID>" }` | `{ "ok": true }` |
| `POST /api/handoff` | Session | `{ "id": "<UUID>" }` | `{ "wire": "<canonical base64 unsigned transaction>" }` |
| `POST /api/submit` | Session | `{ "id": "<UUID>", "signed": "<base64 signed transaction>" }` | `{ "signature": "<Base58 transaction signature>" }` only after confirmed/finalized success |

Strict request schemas reject unknown fields. `/api/explain` instead parses the report with `SecurityReportWireSchema`: an otherwise valid report is accepted and unknown fields are stripped. Amounts are canonical positive decimal strings in lamports, not floating-point SOL.

## `POST /api/analyze`

This route inspects an unsigned external transaction against the user-supplied intended recipient and amount. It is read-only and returns information only; the report is not an authorization capability and cannot be passed to the transfer flow to create a wallet handoff.

### Authentication and request

A valid authenticated wallet session is required. The payer is taken from that session; clients cannot select the payer. Self-transfer recipients are rejected.

```json
{
  "recipient": "Base58-encoded 32-byte Solana public key",
  "amountBaseUnits": "500000000",
  "transactionBase64": "canonical standard base64"
}
```

The request object permits exactly these fields. It is additionally bounded by the shared 32 KiB body reader:

- `recipient`: string validated by `Base58PubkeySchema` as a valid 32-byte key.
- `amountBaseUnits`: canonical positive decimal string that fits u64; zero, signs, leading zeroes, exponent/decimal notation and floats are rejected.
- `transactionBase64`: standard padded base64 alphabet, length 4–1644 characters, divisible by four. After decoding it must round-trip byte-for-byte to the same base64, be greater than 65 bytes and at most 1232 bytes.

The security decoder then requires the supported **unsigned legacy transaction wire** shape: one zero-filled signature slot, a canonical legacy message (at most 1167 message bytes), one payer signer, supported System transfer and optional compute-budget instructions. Versioned messages, signed input and unsupported instructions fail closed. The instruction payer and recipient/amount must match the session-bound payer and request intent.

### Verification and response

The route constructs an internal intent from the session wallet, validated recipient and amount, then runs the same deterministic Devnet verifier. The success envelope is `{ "report": SecurityReportWire }`; the [wire schema](../../packages/shared/src/schemas.ts) serializes bigint amounts as decimal strings. PASS/WARN reports carry decoded instructions, fees and simulation evidence. A BLOCK report can have `simulation: null` if verification stopped before simulation or required evidence was unavailable.

After the asynchronous RPC verification, the server resolves the session again and checks that session ID, wallet and network are unchanged. A changed/expired session invalidates the response. The analyzer does not call the wallet, confirmation gateway, handoff, signing, submission or broadcast path.

### Limits and errors

`/api/analyze` is limited to **5 requests per minute per authenticated session and wallet**, **30 per minute globally**, **2 concurrent analysis operations**, **1 concurrent analysis per wallet**, and the shared **16 concurrent expensive-operation** ceiling. Limits are process-local. Invalid input returns 400; absent/expired session 401; cross-origin request 403; body too large 413; wrong content type 415; quota/concurrency limit 429 with `Retry-After`; session expiry or change during verification returns 409 (`AUTHENTICATED_DEVNET_SESSION_REQUIRED`). A verifier-handled RPC failure returns HTTP 200 with a `BLOCK` report (for example, `RPC_UNAVAILABLE`); inspect `report.verdict` and `report.findings`. Route-level failures that prevent a report can instead return a sanitized 502 or 503. All failures are non-cacheable.

## Common status codes

| Status | Meaning |
|---|---|
| `400` | Invalid request JSON/schema/value, self-transfer, or invalid signed payload |
| `401` | Missing/expired/revoked session or invalid/expired sign-in challenge |
| `403` | Origin or Fetch Metadata rejected |
| `404` | Route is not registered |
| `405` | Method other than POST |
| `408` | Request body read timed out |
| `409` | Confirmation phase/expiry/session binding is no longer valid |
| `413` | Request body exceeds 32 KiB |
| `415` | Content-Type is not supported JSON |
| `429` | Rate or concurrency limit; includes `Retry-After` |
| `502` | Sanitized upstream/internal failure, or a transaction confirmed failed on Devnet |
| `503` | Server origin/configuration/capacity is unavailable |
| `504` | Broadcast/confirmation outcome remains uncertain; do not resubmit |

The exact response can depend on which validation boundary rejects the request. Internal exceptions and RPC response bodies are not returned to callers.

## Authorization boundaries

- `parse`, `explain` and `analyze` do not authorize signing.
- `stage` creates a server draft. `confirm` is the explicit user confirmation transition.
- `build` reads confirmed server state and returns an inspected proposal/report; BLOCK consumes the flow.
- WARN requires a separate `acknowledge` action before `handoff`.
- `handoff` is session-bound and one-use. `/api/submit` consumes that handoff before asynchronous signed-wire checks and allows at most one controlled broadcast attempt.
- An uncertain HTTP 504 is not permission to send again. Reconcile the displayed expected signature first.

See [SECURITY_API.md](../SECURITY_API.md) for gateway constraints and [SECURITY_TEST_REPORT.md](../SECURITY_TEST_REPORT.md) for evidence categories.
