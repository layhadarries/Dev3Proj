# Verification and coverage

## Current evidence

The recorded baseline is the merged `main` commit below.

- Commit: 74cb7e6396b0f034971d07c2519729d1e27db209
- Latest successful main workflow: run 46054922795

The workflow runs:

- Workspace build, typecheck, lint and tests
- High-severity dependency audit gate
- Secret scanning
- Devnet integration checks on pushes to main

[PR #5](https://github.com/layhadarries/Dev3Proj/pull/5) proposes a dedicated CI step for existing deterministic transaction-security tests. Until merged, that step is not part of the recorded main workflow. Its coverage includes:

- Exact transaction and signed-receipt matching
- Invalid, missing and mismatched receipt handling
- Ambiguous submission outcomes
- Confirmation-status classification
- Server-side verification and request boundaries
- Duplicate-submission protections represented by the flow and server tests

## Evidence limits

- The reported CI results are evidence for the commit and workflow run above; rerun CI after subsequent changes.
- Unit and integration tests use deterministic fixtures and mocks where documented. They do not replace live wallet-extension testing.
- The Devnet job does not prove production ingress or deployed-HTTPS behavior.
- Real browser-wallet smoke testing, including rejection, reload recovery and sign-out through the deployed application, remains separate verification work.
- No Mainnet or real-fund test has been performed.
- The dependency workflow gates high-severity findings. Moderate advisories require individual assessment and are not, by themselves, proof that the application is exploitable.

## Deployed HTTPS security smoke test (pending)

Use a disposable Devnet wallet funded only with test SOL. Record the deployed URL, deployed commit, date, browser/wallet versions, result for each case, and Devnet Explorer signature for a confirmed transfer. Do not record cookies, wallet secrets, or API keys.

| Check | Expected result |
| --- | --- |
| Connect and approve sign-in | Session is established for the connected wallet; HTTPS session cookie is Secure, HttpOnly and SameSite=Strict. |
| Reject sign-in or wallet signature | No transaction is broadcast; the user can safely restart. |
| Confirm a small valid SOL transfer | Recipient, amount, fee and Devnet match the approved intent; wallet signs only after verification. |
| Complete the transfer | Receipt matches the signed transaction and Explorer confirms the same signature on Devnet. |
| Cancel or let approval expire | No submission occurs; a fresh confirmation is required. |
| Reload during a pending or unknown submission (if safely reproducible) | The prior signature is recoverable; no automatic resubmission or false success. Check Explorer before starting another transfer. |
| Sign out | The prior session no longer authorizes protected requests. |

Mark cases that cannot be reproduced as not tested, not passed. Record UI defects separately for the frontend owner. This checklist is a test plan, not evidence of a completed browser or deployment test.

## Scope

The MVP covers Devnet-only legacy SOL transfers with one signer, explicit intent confirmation, deterministic inspection, simulation, warning acknowledgement, wallet signing, exact signed-byte verification, controlled submission and receipt reconciliation.

SPL tokens, Token-2022, lookup tables, Anchor workflows, Mainnet and durable multi-process session state remain outside the MVP scope.
