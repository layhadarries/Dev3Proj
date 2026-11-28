# Security architecture

SolGuard uses defense in depth and server-owned authority. It is a Devnet-only
MVP for legacy single-signer SOL transfers, not an audited or guaranteed
protection product. See the integrated [security architecture](../SECURITY_ARCHITECTURE.md)
for the detailed state machine and evidence boundaries.

## Guarantees implemented

- Wallet challenge signatures prove possession of the Ed25519 wallet key.
- Pre-auth and session cookies are HttpOnly and SameSite=Strict.
- Confirmation IDs are bound to session, wallet and Devnet network.
- The gateway only retrieves intent after confirmed phase.
- Reports, acknowledgements and intents are server state, not client capabilities.
- Unsigned handoff and signed submission use exact byte snapshots.
- Submission authorization is single-use.
- A 1 SOL default spending cap applies to transfer debit plus fees.
- Invalid, missing or contradictory evidence fails closed.
- Blocked transactions never reach wallet approval.
- Only supported transaction instructions are accepted; the shared rule-ID
  catalogue contains reserved IDs that do not correspond to implemented detectors.
- Submission aborts the local HTTP request at its deadline, but cannot prove
  that a remote RPC provider did not receive the transaction.

## External trust assumptions

- The browser and its wallet extension may show or mutate data.
- The public RPC operator may return stale or misleading evidence.
- The host can observe and control process-local state.
- The model provider is untrusted and has no tools or signing capability.
- Confirmation UI copy and explicit gesture are application-level obligations.
- Session, gateway, rate-limit and in-flight state are process-local.
