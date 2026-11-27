# Authentication and session security

## Challenge lifecycle

1. Browser POSTs `{ wallet }` to `/api/session/challenge`.
2. Server validates the Base58 public key and Origin.
3. Server creates or reuses a random browser authentication context.
4. It sets a short-lived HttpOnly, SameSite=Strict pre-auth cookie.
5. It signs no data; it creates a challenge containing origin, wallet, nonce,
   timestamp and `Solana Devnet`.
6. Browser requests wallet signing of the challenge bytes.
7. Server verifies the Ed25519 signature and browser context.
8. It atomically consumes the challenge and context.
9. It creates a random opaque session bound to the wallet and network.
10. Successful sign-in revokes previous same-wallet sessions and presented
   browser session.

## Challenge protections

- Contexts expire after 10 minutes.
- Challenges expire after 5 minutes.
- A context has at most three outstanding challenges.
- Challenge and context maps are capped at 10,000 records.
- Failed signatures do not consume or evict unrelated challenges.
- Replay uses no challenge twice.

## Session cookie

Development: `solguard_session=...`.
Production: `__Host-solguard_session=...`.

Both use `Path=/`, `HttpOnly`, `SameSite=Strict`, a one-hour lifetime and
`Secure` in production.

## Process-local limitation

Sessions, challenges and auth contexts are in-memory. Restart invalidates them.
Multiple processes require sticky routing or shared storage. No distributed
revocation or infrastructure DDoS protection is implemented.
