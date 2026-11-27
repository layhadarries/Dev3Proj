# SOL firewall: team integration

Run the security package in a trusted Node service. Install with `pnpm install --frozen-lockfile` and build from the repository root with `pnpm build`. Workspace consumers import from `@solguard/security`; use `serializeReport` from `@solguard/shared` for JSON. No signing keys or credentialed RPC URL are needed.

**Teammate quick start:** Run `node packages/security/scripts/demo.mjs match` and `node packages/security/scripts/demo.mjs tamper` after building. The [executable consumer example](../packages/security/scripts/demo.mjs) imports the public package by name, parses wire intent, verifies unsigned bytes, prepares a wallet handoff and serializes a display report. The tamper path exercises rejection; valid-signature coverage uses ephemeral keys only in deterministic tests.

## Required application path: confirmation gateway

The Node server composition root creates one `createConfirmationGateway(policy)`
instance and owns the Devnet submission transport. For every request, pass a
`resolveSession: () => { sessionId, walletPublicKey, network: "devnet" }`
that reads the current authenticated server state on **each** call, including
after RPC awaits. Do not capture a stale identity snapshot or accept these
fields from JSON. Authenticate wallet ownership before binding it to the
session; rotate the session binding on logout, reconnect or account/cluster
change, even if the user later switches back.

| Gateway call | Server and frontend responsibilities |
| --- | --- |
| `stage(resolveSession, draft)` | Pass a strict `{ recipient, amountBaseUnits }` with a decimal-string amount. Display the returned card's wallet, recipient, amount, asset, network and expiry. Treat its UUID as a lookup key, not authentication. |
| `confirm(resolveSession, id)` | Call only from a dedicated, authenticated, CSRF-protected POST after the user explicitly confirms that card. The server stamps the intent; there is no `confirmed: true` input. |
| `intent(resolveSession, id)` | Read a defensive copy only before inspection and only after confirmation. Do not cache it as authority. |
| `inspect(resolveSession, id, proposal)` | Verify the builder's proposal against gateway state. Return `serializeReport(report)` for display, never as an approval token. Stop on `BLOCK`. |
| `acknowledgeWarning(resolveSession, id)` | Only for a dedicated, authenticated, CSRF-protected POST after the user explicitly acknowledges the displayed `WARN` for this ID. Never auto-acknowledge or forward a JSON flag. |
| `handoff(resolveSession, id)` | Return canonical base64 of the unsigned wire. A WARN without prior acknowledgement fails closed. Use a sign-only wallet method, never sign-and-send. Check the connected account and Devnet again; verify that the wallet adapter preserves the message byte-for-byte. |
| `submitAndConfirm(resolveSession, id, signedBytes, transport)` | Decode only bounded, canonical base64 into bytes at ingress. Inject a trusted Devnet transport that sends the exact provided bytes without recompilation. Do not accept a report, intent, hash, RPC URL or transport from the client. The transport owns RPC submission/confirmation semantics. |

**Ethan:** accept strict `{ confirmationId }` for Build. Inject request-bound
`readIntent(id)` and `inspect(id, proposal)` callbacks from the composition
root; type them using only `Intent`, `BuiltTransaction` and `SecurityReport`
from `@solguard/shared`. Call read → build → inspect; return the display report,
not the proposal bytes as a wallet payload. Agent source must not import
`@solguard/security`. If returning an intent for display, use `serializeIntent`.

**Zulayha:** use the server card as the confirmation UI's source of truth and
keep the same ID through Build, warning acknowledgement, handoff and submit.
Never infer approval from a client timestamp or editable report. BigInts are
decimal strings on the wire. Abort on wallet change or expired/missing state.

Each draft has 60 seconds; confirmation starts a separate 60-second window
for the remaining flow. RPC and blockhash checks can invalidate it sooner.
Inspect, handoff and submit reserve or consume their phase before awaiting RPC.
After a failed attempt, restart with a new draft rather than replaying the ID.
Map unavailable/foreign IDs to a generic 4xx, stale phase/expiry to a restart
response, and upstream failures to sanitized errors. On an ambiguous transport
failure, reconcile the transaction's status before authorizing another send.
Records are process-local and disappear on restart; multi-worker deployments
need session affinity. Rate-limit staging per principal; the process cap is not
a per-user quota. The gateway cannot enforce a user gesture by itself or
prevent a wallet from submitting outside this service.

## Web API routes

`apps/web/app/api/[...path]/route.ts` exposes the UI's POST contract. Every
route requires `application/json`, an exact `Origin` match and, when supplied,
`Sec-Fetch-Site: same-origin`; the UI does not need a custom CSRF header.
Production must set `APP_ORIGIN` to the canonical HTTPS origin (without a path
or trailing slash). The current Next.js `Request` handler does not expose a
verified socket peer address. Therefore the application **ignores**
`X-Forwarded-For` and `X-Real-IP`; every request uses one conservative
`unattributed` client bucket. Changing, chaining, malformed, IPv4, IPv6 or
oversized forwarded-header values cannot change this identity. This can make
the fallback limits shared by legitimate clients, but trusting a value the
runtime cannot authenticate would let callers evade them.

There is no trusted-proxy environment switch. Do not enable header-derived
identity by setting a variable or by assuming a provider's defaults. If a
future deployment adds reliable peer-address access, that integration must
document and verify its exact ingress boundary first. Any proxy in front of
this app should remove client-supplied forwarding headers and write its own
values for other infrastructure that consumes them; these app limits do not
trust or validate those values.

### Rate limits and resource controls

The server uses fixed 60-second per-process windows. Limits are reserved
synchronously before any `await`; requests over a quota receive HTTP 429,
`Retry-After` in seconds, and `Cache-Control: no-store`. The limiter is
bounded to 10,000 keys, sweeps at most 32 entries per request, and never
evicts a live quota to make room. If the store is full, a new identity fails
closed with 429; existing identities retain their counters. Rate keys include
only server-defined route names and validated session/wallet identities (or
the constant `unattributed`), not arbitrary client header values.

Public claimed-wallet limits use the validated wallet in the request only as
an additional abuse signal; it is not authentication. Authenticated wallet
limits use the wallet resolved from the server-side session and survive
session rotation/logout/re-authentication. Per-session limits are retained as
an additional layer.

On non-public endpoints, the server validates the Origin and resolves the
session before charging any authenticated-operation quota. A missing, invalid,
revoked or expired session consumes only a separate per-route unauthenticated
abuse bucket, then receives 401 (or 429 if that bucket is exhausted). It does
not consume the authenticated client fallback, session, wallet, per-process
route quota or in-flight capacity. A valid session is charged to its separate
client fallback, then the body is parsed and schema-validated; only then are
session, wallet and global operation quotas and any concurrency reservation
charged. Malformed authenticated bodies therefore use only the authenticated
client abuse bucket, not operation budgets. Public authentication endpoints
retain their existing limits and ordering.

The authenticated and unauthenticated client buckets both use the same
conservative `unattributed` identity, but have separate keys and counters.
Forwarded headers cannot move a request between or reset these buckets. This
preserves bounded protection for unauthenticated traffic without allowing it
to spend authenticated route budgets. Unauthenticated clients still share
their fallback bucket with each other, and authenticated clients share their
client fallback bucket with each other when a verified peer address is
unavailable.

The endpoint policy is:

| Endpoint | Per-client fallback | Public / session / wallet limits | Per-process route quota | In-flight policy |
| --- | ---: | --- | ---: | --- |
| `/api/session/challenge` | 60/min | public 12/min; claimed wallet 5/min; session storage 5 active challenges per wallet | 120/min | — |
| `/api/session` | 60/min | public 12/min; claimed wallet 10/min | 120/min | — |
| `/api/session/logout` | none | none; logout remains available | none | — |
| `/api/parse` | 120/min per auth state | session 30/min; authenticated wallet 30/min | 60/min, authenticated only | AI/parse group 4, wallet 2; 16 total |
| `/api/stage` | 120/min per auth state | session/wallet 20/min | 240/min, authenticated only | — |
| `/api/confirm` | 120/min per auth state | session/wallet 12/min | 240/min, authenticated only | — |
| `/api/build` | 120/min per auth state | session/wallet 8/min | 30/min, authenticated only | build group 4, wallet 2; 16 total |
| `/api/explain` | 120/min per auth state | session/wallet 30/min | 300/min, authenticated only | — |
| `/api/acknowledge` | 120/min per auth state | session/wallet 12/min | 120/min, authenticated only | — |
| `/api/handoff` | 120/min per auth state | session/wallet 12/min | 60/min, authenticated only | handoff/RPC group 8, wallet 2; 16 total |
| `/api/submit` | 120/min per auth state | session/wallet 8/min | 30/min, authenticated only | submit/confirmation group 4, wallet 1; 16 total |

Quota windows start with the first request for that key. Expiry allows a new
window; the default limiter clock is monotonic, not wall-clock time. New keys
cannot displace active keys. Expired entries are reclaimed incrementally;
while the bounded store is full, new keys may receive 429 until reclamation
reaches expired entries. Challenge/session stores remain capped at 10,000
records, challenges at five per wallet, and the confirmation gateway at 2,048
records. The API body cap remains 32 KiB.

The in-flight limiter reserves synchronously before invoking the AI, blockhash,
simulation, handoff freshness/fee checks, broadcast or confirmation polling.
It limits the combined expensive work to 16 concurrent operations, with the
lower per-operation and per-wallet limits in the table. No waiting queue is
created; excess requests immediately receive 429 and `Retry-After: 1`.
Reservations are released in `finally` on either success or failure, and
release is idempotent. Transaction submission remains one-shot in the
confirmation gateway; a rate limit or uncertain outcome does not trigger an
automatic retry or a second broadcast.

These are provisional single-instance MVP ceilings, selected to preserve the
existing session/route limits while bounding aggregate expensive work. They
have not been load-tested. Because state is process-local, each process has
independent rate buckets and in-flight counts; restart clears them. Multiple
instances can each enforce their own quotas, multiplying the effective
aggregate allowance, and sessions/gateway state also require affinity. This
is not distributed abuse prevention or infrastructure-level DDoS protection.
Use one trusted Node process for the hackathon deployment; distributed
coordination/shared storage and provider-specific trusted-IP integration are
not implemented.

`SOLGUARD_MAX_SPEND_LAMPORTS` is a server-only canonical decimal u64 setting
for the **total debit including network fees**. It defaults to
`1000000000` lamports (1 SOL); malformed or out-of-u64 values fail during
server initialization. Request bodies and AI output cannot change this policy.

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/session/challenge` | `{ wallet }` | `{ message }` |
| `POST /api/session` | `{ wallet, signature }` | `{ wallet }`, sets an HttpOnly, SameSite=Strict cookie |
| `POST /api/session/logout` | `{}` | `{ ok: true }`, expires the current cookie |
| `POST /api/parse` | `{ message }` | agent parse result |
| `POST /api/stage` | `{ recipient, amountBaseUnits }` | server-owned confirmation card |
| `POST /api/confirm` | `{ id }` | `{ intent }` |
| `POST /api/build` | `{ confirmationId }` | `{ transaction, report }` |
| `POST /api/explain` | the report object (not `{ report }`) | deterministic explanation |
| `POST /api/acknowledge` | `{ id }` | `{ ok: true }` |
| `POST /api/handoff` | `{ id }` | `{ wire }` (base64 unsigned transaction) |
| `POST /api/submit` | `{ id, signed }` | `{ signature }` |

Challenges bind the wallet, origin, timestamp and a random nonce; their
Ed25519 signatures are verified server-side and are single-use. The opaque
session token is held in an in-memory server-side session and bound to that
wallet and Devnet. A new successful sign-in revokes earlier sessions for the
same wallet and the cookie presented by that browser; logout revokes the
current token. Bodies are streamed with a 32 KiB cap and strict field
validation. All public errors use `{ error }` without internal RPC details.
Sessions and gateway records are process-local; use one Node process or
session-affine routing, and expect a restart to invalidate pending sessions.

The web submit transport is pinned to `https://api.devnet.solana.com`. It
forwards only the exact signed bytes after `submitAndConfirm` verifies the
signature and transaction. Do not configure this demo for mainnet or use
funded wallets.

## Low-level verification (diagnostics and standalone demo)

These primitives are not a substitute for the gateway in application routes:
they cannot establish user confirmation or warning acknowledgement.

1. Obtain confirmation independently of the AI. Present the **Devnet** network, payer, recipient and integer base-unit amount. Bind the confirmed data to the authenticated user, connected wallet and a single request. Never take wallet identity, clock, policy, RPC client, or acknowledgement from the AI. `parseConfirmedSolIntent` validates the existing intent wire format (decimal string amount, UUID, `kind: "transfer"`, `asset: {type:"SOL"}`, `payer`, `recipient`, `confirmedAt` in epoch ms). A valid schema is not evidence of user confirmation.
2. Call `verify(intent, messageBytes, deps)` for a serialized legacy **message**, or `verifyUnsigned(intent, unsignedWireBytes, deps)` for a full unsigned wire transaction. Do not pass base64 text as bytes. Enforce input size limits at the API ingress. Do not round-trip through transaction compilation. Use the same trusted session and frozen policy for the whole approval; if anything changes, discard it and verify again.

   ```ts
   const deps = { network: "devnet" as const, walletPublicKey: session.wallet,
     maxFeeLamports: 105_000n, maxSpendLamports: session.maxTotalDebit };
   const intent = parseConfirmedSolIntent(session.confirmedIntent);
   const report = await verify(intent, messageBytes, deps);
   ```

3. `BLOCK` means stop. `WARN` means a previously unfunded destination; display the actual finding and obtain a separate explicit acknowledgement. `PASS` means the required checks passed at the simulation slot. Keep the **original report object** in the trusted session; send only its serialized display copy to the UI. Do not use a posted report/hash as an approval token. `report.generatedAt + APPROVAL_TTL_MS` is the expiry (60 seconds from analysis start). Discard abandoned requests.
4. Immediately before wallet approval, call `prepareWalletApproval(intent, messageBytes, report, deps, userAcknowledgedWarning)`. It throws on failure, consumes the handoff once, and returns full unsigned wire bytes. It checks the original report, intent, wallet, network, immutable message hash, expiry, fee and recent blockhash. If a client reconstructs a wallet transaction, compare its serialized message byte-for-byte with the returned wire's message (`wire.subarray(65)`, single signer only). On wallet/account/network changes, abort. Use a **sign-only** wallet operation; sign-and-send bypasses the post-signature check.
5. Back on the same service, retain a private snapshot of the exact signed wire bytes. Call `await verifySigned(intent, signedSnapshot, report, deps)` **before** submission. This checks the one required Ed25519 signature against the exact message and payer, rechecks freshness and fee, and consumes the local approval. Only forward that same immutable snapshot on success (`PASS`, or the already acknowledged `WARN`). The package never submits. On error, timeout, `BLOCK`, restart, wallet modification or duplicate call, discard the approval. Never retry a failed handoff by reusing a hash.

`rpc` and `now` dependency overrides are for trusted tests. The default client uses the pinned Devnet endpoint. Only service-authored policy may narrow the two allowed programs. Defaults: total fee cap 105,000 lamports, priority cap 100,000 lamports; configure an application spending limit explicitly. Total spend includes the fee. Without an explicit compute unit limit the priority-fee check conservatively uses 1.4 million units.

## Supported evidence and boundaries

- One canonical legacy System transfer; one writable signer (payer); distinct writable recipient. Optional single compute-unit limit and price. Reject other programs, instruction variants, unused accounts, multisig, nonce and lookup tables.
- Fee request uses the verified message bytes. Unsigned simulation adds exactly one zero signature slot; signature verification is disabled **only** for this simulation and the blockhash is never replaced. Compare fee, same-bank pre/post balances for every message key and returned writable-account states. Require plain system accounts, no inner instructions or token movements, and no unsupported/missing evidence. An `RPC_UNAVAILABLE` can mean an older node lacks required evidence.
- `decodeTransaction` and `compareTransfer` support diagnostics; neither issues approvals. Display simulation logs as escaped text, not trusted instructions.
- Confirmed simulation is not execution finality. Trust assumptions include the RPC operator, the host, and the user's confirmation UI. An account can change after simulation. Signing protection only covers transactions using this integration.
- Records are local to one Node process. Use authenticated, session-bound routing to that process. A JSON round trip or process restart deliberately invalidates the record. Enforce single-use confirmed requests at the integration boundary; verifying the same intent afresh issues a new record. No distributed replay store, wallet connection or API route is included.

## Run it yourself

```sh
pnpm build
node packages/security/scripts/demo.mjs match
node packages/security/scripts/demo.mjs extra
node packages/security/scripts/demo.mjs recipient
node packages/security/scripts/demo.mjs amount
node packages/security/scripts/demo.mjs tamper
node --test packages/security/tests/integration/devnet.mjs
```

All commands use public addresses, with no signing or submission. `match` also exercises the pre-wallet handoff. To use your own **Devnet** accounts, append the payer and recipient public keys after the scenario: `node packages/security/scripts/demo.mjs match "$PAYER" "$RECIPIENT"`. For `PASS`, use a funded plain system payer with enough SOL for 0.5 SOL plus fees and an existing plain system recipient. An unfunded recipient can produce `WARN` or a rent-related simulation failure. The demo's public addresses are examples, not wallets controlled by the project. Commands exit nonzero if the expected outcome is not observed.
