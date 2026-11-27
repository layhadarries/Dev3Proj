# SOL firewall: team integration

Run the security package in a trusted Node service. Install with `pnpm install --frozen-lockfile` and build from the repository root with `pnpm build`. Workspace consumers import from `@solguard/security`; use `serializeReport` from `@solguard/shared` for JSON. No signing keys or credentialed RPC URL are needed.

**Teammate quick start:** Run `node packages/security/scripts/demo.mjs match` and `node packages/security/scripts/demo.mjs tamper` after building. The [executable consumer example](../packages/security/scripts/demo.mjs) imports the public package by name, parses wire intent, verifies unsigned bytes, prepares a wallet handoff and serializes a display report. The tamper path exercises rejection; valid-signature coverage uses ephemeral keys only in deterministic tests.

## Verification → wallet → signed verification

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
