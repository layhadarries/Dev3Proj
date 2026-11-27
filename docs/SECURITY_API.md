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
node packages/security/scripts/demo.mjs warn
node packages/security/scripts/demo.mjs extra
node packages/security/scripts/demo.mjs recipient
node packages/security/scripts/demo.mjs amount
node packages/security/scripts/demo.mjs fee
node packages/security/scripts/demo.mjs tamper
pnpm --filter @solguard/security test
node --test packages/security/tests/integration/devnet.mjs
```

The CLI demos use the real exported engine and live, read-only Devnet RPC. They do not sign or submit transactions. `match` also exercises the unsigned wallet handoff; `tamper` changes those unsigned bytes before signed-wire verification. `warn` generates a fresh recipient address with no known private key. Use a funded plain system payer with enough SOL for 0.5 SOL plus fees; use an existing plain system recipient for `match` and `tamper`. To use your own **Devnet** accounts for the other transfer scenarios, append payer and recipient public keys after the scenario: `node packages/security/scripts/demo.mjs recipient "$PAYER" "$RECIPIENT"`. The demo's default public addresses are examples, not wallets controlled by the project. Commands exit nonzero if the expected verdict and finding are not observed.

| Scenario | Command or fixture test | Expected result |
|---|---|---|
| Legitimate transfer | `demo.mjs match` | Live Devnet `PASS`; exact intended transfer and simulation evidence. |
| New destination | `demo.mjs warn` | Live Devnet `WARN` / `RECIPIENT_NEW_ACCOUNT`; destination is generated for the run and never signed for. |
| Recipient substitution | `demo.mjs recipient` | `BLOCK` / `RECIPIENT_MISMATCH`. |
| Amount manipulation | `demo.mjs amount` | `BLOCK` / `AMOUNT_MISMATCH`. |
| Hidden second transfer | `demo.mjs extra` | `BLOCK` / `EXTRA_TRANSFER`. |
| Excessive fee request | `demo.mjs fee` | `BLOCK` / `EXCESSIVE_PRIORITY_FEE`; requests a high compute-unit price, but never submits it. |
| Transaction tampering | `demo.mjs tamper` | Live simulation first, then `BLOCK` / `TX_MODIFIED` after changing the unsigned wire message. |
| Replay / repeated handoff | `pipeline.test.ts`: “consumes handoffs and signed approvals only once under concurrent calls” and “gates the exact signed snapshot … and consumes it once” | Deterministic RPC fixture; second or concurrent use is rejected and transport is called once. |
| Unauthorized confirmation | `pipeline.test.ts`: “reads only confirmed intents …” and “gates the exact signed snapshot on authenticated confirmation …” | Deterministic RPC fixture; pre-confirmation, foreign-session and client-asserted confirmation attempts are rejected. |

`pnpm --filter @solguard/security test` runs the real decoder, verifier and gateway against deterministic injected RPC fixtures (not live RPC). The explicit integration command runs all seven live scenarios and fails if Devnet is unavailable or the expected evidence is not returned. Neither command signs or sends a transaction; the only transport-send assertions are mocked unit fixtures.
