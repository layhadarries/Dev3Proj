# Troubleshooting

| Problem | Likely cause | Safe action |
|---|---|---|
| Wallet will not connect | Unsupported extension or CSP/wallet event blocked | Verify extension, HTTPS/Origin and browser console |
| Challenge rejected | Missing/pre-auth cookie, wrong origin or expired challenge | Start sign-in again; do not reuse a signature |
| Session expired | One-hour TTL or logout/revocation | Sign in again; existing approvals are invalid |
| Origin 403 | `APP_ORIGIN` differs from browser origin | Set exact canonical HTTPS origin |
| HTTP 429 | Per-route/session/wallet/global or in-flight limit | Wait for `Retry-After`; do not retry submit |
| Insufficient Devnet balance | Payer cannot cover transfer and fees | Use a throwaway funded Devnet wallet |
| SIM_FAILED/BLOCK | Simulation or intent mismatch | Stop; inspect the finding and draft a new transfer |
| Spending limit block | Transfer plus fees exceed 1 SOL by default | Stop or use an approved server policy |
| RPC timeout | Provider unavailable/stale | No resubmit; reconcile by signature and status |
| Unconfirmed 504 | Broadcast/confirmation outcome uncertain | Never press submit again; reconcile signature externally |
| Model unavailable | Missing LLM config or provider failure | Use simple supported syntax or configure server model |
| CSP violation | Inline script/style or unsupported wallet resource | Review nonce/CSP and wallet compatibility |

Do not repeat a transaction after an ambiguous submit response. The server
cannot prove underlying RPC acceptance was absent after a broadcast timeout.
