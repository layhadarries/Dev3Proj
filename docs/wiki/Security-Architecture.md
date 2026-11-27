# Security architecture

SolGuard uses defence in depth and server-owned authority.

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

## External trust assumptions

- The browser and its wallet extension may show or mutate data.
- The public RPC operator may return stale or misleading evidence.
- The host can observe and control process-local state.
- The model provider is untrusted and has no tools or signing capability.
- Confirmation UI copy and explicit gesture are application-level obligations.
