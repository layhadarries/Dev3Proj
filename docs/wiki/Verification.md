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

[PR #5](https://github.com/layhadarries/Dev3Proj/pull/5) proposes dedicated deterministic transaction-security tests, mock-wallet browser regression and detailed audit logging. Until merged, that step is not part of the recorded main workflow. Its coverage includes:

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

## Dependency advisory assessment (T-04, 28 November 2026)

The successful PR #8 checks job (run 46140545994) reports four moderate advisories and passes the high-severity gate. It does not print advisory IDs. The lockfile on main retains `jayson@4.3.0`, `uuid@8.3.2`, and `stream-json@1.9.1`. The previous security review identifies the following candidate advisories; confirm the exact current IDs and paths from the detailed audit output proposed in PR #5 before closing T-04.

| Advisory | Relevant behavior | Preliminary assessment |
| --- | --- | --- |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | UUID v3/v5/v6 output-buffer bounds | No application use of those methods with caller-supplied buffers has been established. |
| [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) | Streaming path-filter CPU exhaustion | Firewall RPC uses lossless-json rather than the SDK transport; assess SDK dependency reachability separately. |
| [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x) | JSONC comment parsing CPU exhaustion | No application use of JSONC entry points has been established. |
| [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc) | Previously reported stream-json advisory | Exact advisory details and current dependency path still need confirmation. |

These are preliminary reachability observations, not exemptions, proof of non-exploitability, or a clean audit. Do not force incompatible transitive major-version overrides during the demo freeze. Track compatible upstream fixes, review the SDK response path, and rerun frozen-lockfile installation, build, tests and audit after any coordinated dependency change.

## Browser and route coverage (T-05)

PR #5 now proposes running the existing Playwright mock-wallet browser script in CI, including matching, missing and mismatched receipt scenarios. This is separate from V8 unit-test coverage and from a live wallet extension. The script intercepts API requests, so it does not demonstrate real server ingress or blockchain behavior. The existing HTTP and server tests exercise route dispatch, origin, authentication, quotas and transaction outcomes; the security-header tests exercise CSP, HSTS and nonce forwarding. No fresh component line/branch percentage is claimed. Full rendered React component coverage and a rerun on the integrated UI revision remain outstanding.

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
