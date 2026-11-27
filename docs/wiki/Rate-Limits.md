# Rate limiting and resource protection

## Identity model

Forwarded IP headers are ignored. The Next.js request boundary does not expose
a verified peer address. Every request uses the conservative `unattributed`
fallback. Forwarded values cannot change or reset quotas.

## Endpoint policies

The current fixed-window implementation has:

- Public challenge: 12/min
- Public sign-in: 12/min
- Parse: session/wallet 30/min and global 60/min
- Stage: session/wallet 20/min and global 240/min
- Confirm: session/wallet 12/min
- Build: session/wallet 8/min and global 30/min
- Explain: session/wallet 30/min
- Handoff: session/wallet 12/min
- Submit: session/wallet 8/min

Exact route policies and in-flight limits are maintained in
`docs/SECURITY_API.md`.

## Concurrency

In-flight reservations cover AI parsing, transaction build/simulation,
handoff verification and submit/confirmation. The process-wide active limit is
16, with stricter operation and wallet limits. Excess requests return 429;
reservations release in `finally`.

## Storage and recovery

The limiter holds at most 10,000 keys. Expired entries are reclaimed
incrementally. Live entries are not evicted to make room. Restart resets
process-local quotas. New keys fail closed if the store is full.

No distributed DDoS, Redis or load-balancing enforcement is implemented.
