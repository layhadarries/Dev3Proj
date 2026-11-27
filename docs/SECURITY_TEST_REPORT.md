# Legacy SOL pipeline validation — 2026-11-27

| Stage | Deterministic checks | Live evidence |
|---|---|---|
| Decoder and comparison | Build, typecheck, lint; 60 tests passed | Decoder is offline. |
| Verification and simulation | Build, typecheck, lint; 62 tests passed | Same-bank simulation at confirmed slot `526831348`. |
| Wallet handoff | Build, typecheck, lint; 82 tests passed | Isolated Node integration suite: 5 passed, 0 failed, 0 skipped. |
| Confirmation gateway hardening | Build, typecheck, lint; 96 Vitest tests passed (9 files: unit + adversarial, mocked RPC fixtures) | Live Devnet Node suite: 5 passed, 0 failed (real RPC, public addresses, no signing/submission). `pnpm audit --audit-level high` exit 0 (4 moderate, transitive via `@solana/web3.js`). `gitleaks git` exit 0 (25 commits, no leaks). |

### Observed Devnet PASS

Message hash `fb705c730a06f023008ba6a2ffe2799859b7ce495b09be1ef5f6f4588dfab17f`; recent blockhash `Az4seoiQt2dZbPhwZVj5sCPPDCxBfjEywr62VWiaLrSG`. Simulation slot `526831872`, 150 compute units, estimated and simulated fee 5,000 lamports. Payer `964koDACp6GNSW8uL2J49CTa7kuFSQWPErgKMKK1E9QH`: −500,005,000 lamports. Recipient `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`: +500,000,000. System Program: zero change.

### Rejection and signature evidence

- Demo scenarios `extra`, `recipient`, `amount` used real recent blockhashes and blocked during decoding/comparison (`EXTRA_TRANSFER`, `RECIPIENT_MISMATCH`, `AMOUNT_MISMATCH`). They did not need simulation.
- `tamper` passed live simulation and freshness checks before modification. The modified wire bytes returned `TX_MODIFIED`.
- Correct payer signature, missing signature, wrong key, changed signature count, changed message, expiry, fee changes, altered policy, forged report and reuse were tested with deterministic RPC fixtures and ephemeral test-only keys. These are **not** live signed transactions. No wallet approval, submission, confirmation or Explorer transaction signature is claimed.
- Live commands assert expected verdicts and fail on unavailable RPC. Public balances, fees, slots and hashes can change. Reproduce using [SECURITY_API.md](SECURITY_API.md).

For private read-only evidence, build first and use an ignored local directory:

```sh
umask 077
mkdir -p .local-evidence
node packages/security/scripts/wallet-evidence.mjs --new-demo-wallet > .local-evidence/demo-wallet.json
```

This generates an independent ephemeral Devnet demonstration wallet, retains only its public key, and requests no funding. With zero lamports its otherwise matching transfer must block during simulation. The runner also tests static intent mismatches; an unfunded wallet cannot exercise a successful handoff. For the funded path, pass `"$PAYER"` in place of `--new-demo-wallet`, or omit the argument and set `SOLGUARD_TEST_PAYER`.

Keep original RPC responses local and unmodified. Do not publish personal addresses, credentials, or identifying evidence without the owner's explicit permission. To share a demonstration, use a separate demonstration wallet and review the artifact before publication.

## Security test coverage analysis — 2026-11-27

**Branch:** `feat/security-hardening`
**Synchronization:** merged `feat/web-ui` at `32fe924` into this branch with merge commit `e0099d6`; the HTTP security headers commit `95bc584` remains in history.

### Test count

Coverage additions were measured against the complete suite after branch synchronization, including Ethan's parser-hardening tests.

| Area | Before | After |
| --- | ---: | ---: |
| Security engine | 96 | 96 |
| AI agent | 85 | 92 |
| Web application | 52 | 62 |
| **Total** | **233** | **250** |

The 17 added tests target untested boundaries: model clarification and unsupported responses, requests without a configured model, malformed model response content, an unconfirmed intent returned by a resolver, empty agent request bodies, HTTP origin/address/rate-limit/body/error handling, actual API route dispatch, and CSP nonce forwarding plus HTTPS HSTS/HMR behavior.

### Coverage before and after

V8 coverage was collected with `@vitest/coverage-v8` 4.1.12. The same source include patterns were used before and after: all TypeScript sources in `packages/security` and `packages/agent`, and `apps/web` server/client libraries, API routes, app components, and middleware.

| Package | Metric | Before | After |
| --- | --- | ---: | ---: |
| Security engine | Statements | 92.03% | 92.03% |
|  | Branches | 88.95% | 88.95% |
|  | Functions | 96.07% | 96.07% |
|  | Lines | 93.84% | 93.84% |
| AI agent | Statements | 94.55% | 99.31% |
|  | Branches | 87.87% | 97.97% |
|  | Functions | 100.00% | 100.00% |
|  | Lines | 96.61% | 99.15% |
| Web application | Statements | 71.40% | 75.78% |
|  | Branches | 63.49% | 68.03% |
|  | Functions | 67.34% | 69.38% |
|  | Lines | 76.23% | 80.80% |

#### Security-critical module coverage after additions

| Scope | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Security transaction decoder and verification | 92.76% | 90.41% | 100.00% | 94.44% |
| Agent parser, handlers, and LLM client | 100.00% | 98.61% | 100.00% | 100.00% |
| Web server and CSP middleware | 87.84% | 80.06% | 88.51% | 93.12% |
| Web HTTP boundary helpers | 97.75% | 95.95% | 90.00% | 98.80% |
| Web session store | 89.87% | 79.31% | 100.00% | 93.85% |
| CSP helper and middleware | 100.00% | 90.00% | 100.00% | 100.00% |

The 90% line-and-branch target is met for the measured security decoder/verification and agent parsing/authorization modules, and for the focused HTTP and CSP helpers. It is **not** met for the complete web server/middleware scope or session-store branches.

### Security scenarios exercised

The combined tests cover authentication failures, expired and replayed challenges, session expiration/revocation/rotation, cross-session confirmation access, CSRF/origin rejection, malformed and oversized requests, rate-limit boundaries, prompt injection and altered model output, spending-cap boundaries, transaction-byte/signature verification, duplicate submission prevention, concurrent approval consumption, RPC failures and timeouts, CSP headers, and fail-closed error responses. The added tests specifically increased coverage of model output parsing and browser-facing HTTP/CSP boundaries.

### Remaining gaps and limitations

- Web-wide coverage remains 80.80% line and 68.03% branch. The unrendered React transfer UI and portions of wallet/client flow account for much of the remaining gap; the current tests do not mount the UI in a browser test environment.
- Web server plus middleware branches are 80.06%, and session-store branches are 79.31%. Uncovered paths include rare resource-cap/eviction conditions and combinations of route-level failure handling. These gaps are not reported as vulnerabilities.
- Security-engine aggregate branch coverage is 88.95%, below 90%; decoder/verification branches are 90.41%. Some configuration and RPC transport branches remain unexercised.
- RPC, wallet signatures, broadcast/confirmation, and LLM behavior are tested with deterministic fixtures or mock responses. They do not establish behavior against every real wallet extension, RPC provider, external model, production ingress/proxy, or adversarial network schedule. Concurrency tests exercise selected races, not load or stress behavior.
- No vulnerability was demonstrated by the tests run. This coverage exercise is not proof of absence of vulnerabilities or a substitute for a dedicated security audit.

### Verification

Passed after the final test additions:

- `pnpm test` — 250 tests passed.
- V8 coverage runs for `@solguard/security`, `@solguard/agent`, and `@solguard/web`.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`

The coverage provider was added as a root development dependency at the same version as Vitest; no runtime dependency or application behavior was changed for coverage collection.

## Rate-limit and resource-abuse hardening

### Test count and coverage

The rate-limit changes were measured against the synchronized 250-test suite:

| Area | Before | After |
| --- | ---: | ---: |
| Security engine | 96 | 96 |
| AI agent | 92 | 92 |
| Web application | 62 | 71 |
| **Total** | **250** | **259** |

Coverage was collected with the existing V8 provider and the same complete
source-file scope used above.

| Package | Metric | Before | After |
| --- | --- | ---: | ---: |
| Security engine | Statements / branches / functions / lines | 92.03% / 88.95% / 96.07% / 93.84% | 92.03% / 88.95% / 96.07% / 93.84% |
| AI agent | Statements / branches / functions / lines | 99.31% / 97.97% / 100.00% / 99.15% | 99.31% / 97.97% / 100.00% / 99.15% |
| Web application | Statements / branches / functions / lines | 75.78% / 68.03% / 69.38% / 80.80% | 79.03% / 72.50% / 73.24% / 83.49% |

| Rate-limit-related scope after changes | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| HTTP limiter, in-flight limiter, and HTTP helpers | 97.74% | 95.68% | 94.44% | 99.17% |
| Endpoint policies in the web application | 86.98% | 78.57% | 90.47% | 93.07% |
| Web server and middleware | 90.84% | 84.01% | 92.78% | 95.19% |
| Session store (unchanged) | 89.87% | 79.31% | 100.00% | 93.84% |

The newly introduced limiter decisions exceed 90% branch coverage. The wider
route-policy, web-server/middleware and session-store scopes remain below 90%
branch coverage; their remaining untested branches include existing request
handling and session-store paths as well as policy error combinations.

### Scenarios and verification

New deterministic tests cover spoofed and malformed forwarded headers,
unattributed client identity, limiter boundary and storage-capacity behavior,
monotonic-clock handling, incremental expiry, concurrent reservation and
idempotent release, claimed-wallet abuse limits, wallet quota persistence
across session rotation, global parse quotas across wallets, and preventing
AI/RPC calls when quotas or concurrency caps reject a request. Tests use
instrumented mocks and controlled promises; no real transaction was signed or
submitted, and no live AI/RPC or load test was performed.

Passed:

- `pnpm test` — 259 tests (96 security, 92 agent, 71 web).
- V8 coverage runs for all three tested packages.
- `pnpm lint`, `pnpm typecheck`, and `pnpm build`.
- `pnpm audit --audit-level high` — exit 0; four moderate dependency findings
  remain, with no high-severity finding reported by this thresholded check.

No dependency or environment-variable changes were made. No new vulnerability
was demonstrated. The trusted client IP is unavailable through the current
Next.js request boundary, so forwarded headers remain ignored and clients share
a conservative fallback bucket. Rate-limit, session, and in-flight state are
process-local: restarts clear quotas, multiple instances enforce independent
limits, and this is not distributed DDoS protection. Limits are provisional
single-instance MVP settings and have not been load-tested.

## Authenticated quota isolation

Review found that `invoke()` previously charged the common per-client and
per-route global buckets before resolving the session on non-public routes.
Because client identity is conservatively `unattributed`, unauthenticated
requests could consume global budgets intended to bound authenticated
operations. Origin validation already ran first; the defect was the ordering
of session resolution and quota charging.

The handler now keeps unauthenticated abuse counters in a distinct per-route
namespace. A protected request must pass Origin validation and resolve a
valid session before it can charge the authenticated client fallback. Its
body must also pass JSON/schema validation before session, wallet, global
operation, or in-flight budgets are charged. Missing, invalid, revoked and
expired sessions consume only the bounded unauthenticated fallback and are
rejected; they cannot invoke AI or blockchain RPC services. Public challenge,
sign-in and logout handling was not redesigned.

Regression tests cover cross-origin rejection, 120 unauthenticated protected
requests followed by a 121st-request 429 in the separate abuse bucket,
preserving the authenticated parse quota and AI availability, invalid and
expired sessions attempting expensive builds, zero RPC calls for rejected
builds, successful authenticated parsing/building after the attempts, and
existing authenticated wallet quota enforcement.

### Verification

- `pnpm test` — 261 tests passed (96 security, 92 agent, 73 web).
- V8 coverage — security 92.03% / 88.95% / 96.07% / 93.84%;
  agent 99.31% / 97.97% / 100.00% / 99.15%;
  web 79.08% / 72.41% / 73.24% / 83.84%
  (statements / branches / functions / lines).
- `pnpm lint`, `pnpm typecheck`, `pnpm build` passed.
- `pnpm audit --audit-level high` passed; four moderate dependency findings
  remain, with no high-severity finding reported at this threshold.

Unauthenticated requests still share a per-route fallback bucket because
there is no verified peer address; enough unauthenticated traffic can cause
other unauthenticated requests to receive 429, but does not spend authenticated
operation budgets. Authenticated requests also share the authenticated client
fallback identity; per-session, per-wallet and global limits remain layered
alongside it. All counters are process-local, reset on restart and independent
between instances. The checks were deterministic and mocked; no production
ingress, live provider, or load/stress behavior was tested.
