# Verification and coverage

## Evidence baselines

Evidence below distinguishes merged `main` from the separate, unmerged PR #15. It applies only to the stated commit/run; rerun CI after documentation or code changes before making claims about the new revision.

### Merged `main`

- Commit: `3c1bfec622759b7e3eb92253e601fe6645bf198b`
- Successful workflow: [run 46151035003](https://github.com/layhadarries/Dev3Proj/actions/runs/46151035003)
- Reported jobs: build, typecheck, lint, workspace tests, high-severity dependency audit gate, secret scanning and live Devnet integration.

### PR #15 (not merged)

- PR #15 remains separate from the main baseline: [pull request](https://github.com/layhadarries/Dev3Proj/pull/15).
- Recorded totals on the PR evidence head: **118 security + 99 agent + 170 web = 387 workspace tests**.
- The checked-in live Devnet integration harness contains six read-only test cases (six unique scenario labels); no wallet signing or transaction submission.
- Four synthetic HTTPS verifier harness tests passed; synthetic responses are not a deployed-host test.
- [Run 46152422986](https://github.com/layhadarries/Dev3Proj/actions/runs/46152422986) was run at an earlier PR head (`40ec329`): checks and secrets passed; its Devnet job was skipped. Do not assign its results to a later PR commit.
- The PR security report also contains explicitly attributed teammate reports. Those are not independent reproduction by CI.

Do not combine the PR #15 counts or scenarios with merged-main results unless and until that PR is merged and the resulting main commit is verified.

## Scope and evidence limits

- Workspace tests include unit/adversarial fixtures, mocked RPC, route/server tests, and mock-wallet browser regression where the workflow runs it. A mock wallet is not a real extension.
- Live Devnet scenarios make public RPC reads and do not sign or submit. They are not transaction-submission or real-funds evidence.
- CI does not prove production ingress behavior, deployed HTTPS headers, wallet-extension compatibility, or all possible RPC/network states.
- No authorized deployed HTTPS origin was available for a live smoke test; deployment verification remains pending.
- No Mainnet or real-fund testing is claimed.
- Coverage measures exercised code, not security assurance.

## Dependency advisory assessment (T-04, 28 November 2026)

The recorded successful audit report identifies four moderate advisories through `@solana/web3.js > jayson`; the high-severity gate passes. Installed lockfile versions in that report were `jayson@4.3.0`, `uuid@8.3.2`, and `stream-json@1.9.1`.

| Advisory | Installed | Reported patched range | Assessment |
|---|---|---|---|
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | uuid 8.3.2 | >=11.1.1 | Application use of affected UUID methods with caller-supplied buffers has not been established. |
| [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) | stream-json 1.9.1 | >=3.5.0 | Transitive SDK dependency; reachability requires separate assessment. |
| [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x) | stream-json 1.9.1 | >=3.6.0 | No application use of JSONC entry points has been established. |
| [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc) | stream-json 1.9.1 | >=3.6.0 | Application exploitability has not been established. |

The firewall's read-only RPC uses `lossless-json`; the web submission/status SDK uses the transitive transport stack. These are preliminary reachability notes, not exemptions or proof of non-exploitability. The audit is not clean or a certification.

## Browser and route coverage

The workflow includes mock-wallet Chromium regression scenarios and deterministic HTTP/server tests. The tests cover route dispatch, origin, authentication, quotas and transaction outcomes; header tests cover CSP, HSTS and nonce forwarding. Full rendered React component line/branch coverage is not measured. Teammate-reported browser/live-wallet results remain attributed in [Issue #2](https://github.com/layhadarries/Dev3Proj/issues/2); they are not independently rerun results for the final integrated commit.

## Deployed HTTPS verification (pending)

The repository includes a credential-free smoke-check harness, tested against synthetic responses in CI. Run it only against an owner-authorized Devnet deployment:

```sh
node scripts/verify-https.mjs https://YOUR-AUTHORIZED-DEVNET-ORIGIN
```

It checks production CSP/nonce refresh, HSTS and other browser headers, unauthenticated and cross-origin refusal, and unknown-route behavior. It sends no credentials, wallet keys, valid intents or signed transactions; it follows no redirects and does not print response bodies. A synthetic test is not a live deployment test.

Record the authorized URL, exact deployed commit, date, browser/wallet versions and each result. The URL and deployed commit are currently unavailable, so no deployed HTTPS verification is claimed. For real wallet testing, use only a disposable Devnet wallet with test SOL; never publish cookies, wallet secrets or API keys.

## Scope

The MVP covers Devnet-only legacy SOL transfers with one signer, explicit intent confirmation, deterministic inspection, simulation, warning acknowledgement, wallet signing, exact signed-byte verification, controlled submission and receipt reconciliation. SPL, Token-2022, lookup tables, Anchor workflows, Mainnet and distributed session state remain outside scope.
