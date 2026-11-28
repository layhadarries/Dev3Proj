# Verification and coverage

## Current evidence

The merged `main` baseline and the later PR #15 evidence head are distinct:

- Merged `main`: `3c1bfec622759b7e3eb92253e601fe6645bf198b`.
- PR #15 evidence head: `a03d3de545102a3cc42cd3bb4930f7c9d702be9b`.
- Earlier PR #15 workflow on `40ec329`: [run 46152422986](https://github.com/layhadarries/Dev3Proj/actions/runs/46152422986), checks and secret scanning passed; Devnet job skipped for the PR event.

PR #15's independently executed report records 387 workspace tests (118
security, 99 agent, 170 web), eight read-only live Devnet scenarios, and HTTPS
synthetic tests 4/4. Its Devnet
demonstrations did not sign or submit transactions. These results are distinct
from teammate-reported browser results and do not claim real wallet-extension
or deployed-HTTPS verification.

The workflow runs:

- Workspace build, typecheck, lint and tests
- High-severity dependency audit gate
- Secret scanning
- Devnet integration checks on pushes to main

[PR #5](https://github.com/layhadarries/Dev3Proj/pull/5) added dedicated deterministic transaction-security tests, mock-wallet browser regression and detailed audit logging. Its coverage includes:

- Exact transaction and signed-receipt matching
- Invalid, missing and mismatched receipt handling
- Ambiguous submission outcomes
- Confirmation-status classification
- Server-side verification and request boundaries
- Duplicate-submission protections represented by the flow and server tests

## Verified branch snapshot

[Main CI run 46151035003](https://github.com/layhadarries/Dev3Proj/actions/runs/46151035003) passed on `3c1bfec`. Its live harness runs six cases once each: `match`, `extra`, `recipient`, `amount`, `tamper`, `unsupported`. The [unmerged PR #15 report](https://github.com/layhadarries/Dev3Proj/blob/d88d96e1706f0510aab3265a11c3a7f77e6b43ee/docs/SECURITY_TEST_REPORT.md#final-security-demonstration--2026-11-29) includes `warn` and `fee` for eight total. The earlier revision and CI run cited above are historical evidence, not runs on the latest PR head (`d88d96e`).

## Evidence limits

- The reported CI results are evidence for the commit and workflow run above; rerun CI after subsequent changes.
- Unit and integration tests use deterministic fixtures and mocks where documented. They do not replace live wallet-extension testing.
- The Devnet job does not prove production ingress or deployed-HTTPS behavior.
- Real browser-wallet smoke testing, including rejection, reload recovery and sign-out through the deployed application, remains separate verification work.
- No Mainnet or real-fund test has been performed.
- The dependency workflow gates high-severity findings. Moderate advisories require individual assessment and are not, by themselves, proof that the application is exploitable.

## Dependency advisory assessment (T-04, 28 November 2026)

The [successful PR #5 run 46143168135](https://github.com/layhadarries/Dev3Proj/actions/runs/46143168135) at commit `9ac4230` confirms exactly four moderate advisories; the high-severity audit gate passes. All four dependency paths run through `@solana/web3.js > jayson` in the web, security and agent workspaces. The main lockfile retains `jayson@4.3.0`, `uuid@8.3.2`, and `stream-json@1.9.1`.

| Advisory | Installed | Reported patched range | Assessment |
| --- | --- | --- | --- |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | uuid 8.3.2 | >=11.1.1 | No application use of affected UUID methods with caller-supplied buffers has been established. |
| [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) | stream-json 1.9.1 | >=3.5.0 | Transitive SDK dependency; reachability through the SDK requires separate assessment. |
| [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x) | stream-json 1.9.1 | >=3.6.0 | Same dependency path; no application use of JSONC entry points has been established. |
| [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc) | stream-json 1.9.1 | >=3.6.0 | Same dependency path; application exploitability has not been established. |

The security engine's RPC client uses lossless-json, not the SDK transport; the web application does use the SDK for submission and confirmation. The dependency audit therefore cannot be dismissed simply because the firewall uses a different parser. These are preliminary reachability observations, not exemptions, proof of non-exploitability, or a clean audit. Defer incompatible transitive major-version overrides until coordinated compatibility testing; track upstream fixes and rerun frozen-lockfile installation, build, tests and audit after any dependency change.

## Browser and route coverage (T-05)

PR #5 run 46143168135 passed all three mock-wallet Chromium scenarios (empty, mismatched and matching receipt), each with one submit. This is separate from V8 coverage and live extension testing; the browser script intercepts API calls. The HTTP and server tests cover route dispatch, origin, authentication, quotas and transaction outcomes; the security-header tests cover CSP, HSTS and nonce forwarding. Full rendered React component line/branch coverage remains unmeasured. Ethan's agent separately reported successful combined-branch tests on the earlier PR revisions in [Issue #2](https://github.com/layhadarries/Dev3Proj/issues/2#issuecomment-7238875337); those are teammate-reported, not independently rerun results for the final integrated commit.


## Deployed HTTPS security smoke test (awaiting deployment)

The credential-free ingress harness is present and its synthetic regression suite passes, but an authorized deployment URL is not available. GitHub deployment records are empty and repository documentation does not identify a real deployment. Await an owner-provided canonical origin; do not use the example origin below as a target. Then run:

```sh
node scripts/verify-https.mjs https://OWNER-PROVIDED-ORIGIN
```

It checks production CSP and nonce refresh, HSTS, other browser security headers, unauthenticated and cross-origin refusal, and unknown-route handling using seven bounded requests. It sends no credentials, wallet keys, valid intents or signed transactions, follows no redirects and does not print response bodies. The harness is tested against synthetic responses in CI. This is not a live wallet test; the deployed URL and exact deployed commit must still be recorded separately.

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
