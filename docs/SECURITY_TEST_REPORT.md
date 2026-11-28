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

## API route-dispatch hardening

Review finding: the Next.js catch-all route indexed a normal JavaScript
object with an untrusted `path.join("/")` string. JavaScript inherited names
such as `constructor`, `prototype`, `toString`, `valueOf` and `__proto__`
could resolve to non-handler values or prevent a valid 404 response.

Remediation: route dispatch now uses an explicit `Map` allowlist containing
only the eleven registered API handlers. Empty, nested, malformed, mixed-case,
unknown and inherited-property names return the existing JSON 404 response
with `Cache-Control: no-store`. The dispatch decision is exported for direct
tests, but no wildcard or dynamic handler loading was introduced.

The synchronized latest UI branch also added compute-budget instructions to
the mock server transaction fixtures. The web RPC fixture now derives
simulation balance-vector width from the actual legacy message account count
and preserves the 5,001-lamport fee and four-account evidence shape. This
was a test-fixture compatibility update only; no transaction policy or builder
behavior was changed for this finding.

Regression coverage includes all registered routes, inherited names,
constructor/prototype names, mixed-case and malformed segments, JSON 404
content type and non-cacheable responses. Unsupported routes use no
authentication, agent, RPC or submit handler. Valid routes retain their
existing handlers and security checks.

Verification for this finding:

- Complete suite before the route fix: 296 tests (96 security, 93 agent,
  107 web).
- Complete suite after the route fix: 297 tests (96 security, 93 agent,
  108 web).
- Web V8 coverage: 90.02% statements, 84.10% branches, 92.46% functions,
  94.56% lines.
- Route-dispatch decision branches are covered by direct helper and HTTP
  catch-all tests, including inherited-property names and malformed paths.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` and
  `pnpm audit --audit-level high` passed. Audit remains at four moderate
  dependency findings and no high-severity finding at this threshold.

## Bounded transaction broadcast

### Test count and coverage

The complete suite at the synchronized branch baseline was 272 tests:
96 security, 93 agent and 83 web tests. The focused broadcast work added
6 web tests, for 278 tests total after the change: 96 security, 93 agent and
89 web tests.

V8 coverage for the final synchronized implementation was:

| Package | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Security engine | 92.03% | 88.95% | 96.07% | 93.84% |
| AI agent | 99.31% | 97.97% | 100.00% | 99.15% |
| Web application | 89.86% | 82.98% | 91.36% | 94.67% |

The web broadcast and submission scope is covered by deterministic tests for:

- successful broadcast and confirmed status;
- a broadcast that never resolves;
- a broadcast that resolves after the application deadline;
- a broadcast that throws before returning a signature;
- timeout reconciliation with confirmed, unknown and RPC-failure outcomes;
- mismatched RPC signatures;
- duplicate and concurrent submission attempts;
- in-flight capacity release and replay protection;
- late promise resolution/rejection without an automatic second broadcast.

No real funds or live transaction were used. The tests use controlled
promises, deterministic clocks or small injected deadlines, mocked signature
statuses and mocked transports. They prove application control flow but do not
prove the behavior of every Solana RPC endpoint or network schedule.

### Transport limitation

The installed `@solana/web3.js` `Connection.sendRawTransaction` API exposes no
AbortSignal or request-cancellation handle. The application therefore applies
a 10-second `Promise.race` deadline and reconciles by the signature derived
from the exact verified signed bytes. A timeout cannot prove that the underlying
RPC request was not accepted or that underlying network work stopped. Late
promise resolution and rejection are observed, no second broadcast is issued,
and the submission concurrency reservation is released through `finally`.

### Verification

Passed:

- Combined `pnpm test`: 278 tests (96 security, 93 agent, 89 web).
- V8 coverage for security, agent and web.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm audit --audit-level high`: exit 0; 4 moderate dependency findings and
  no high-severity finding at the requested threshold.

## Transaction commitment accuracy

The complete suite increased from 278 to 286 tests after direct
commitment-classification coverage: 96 security, 93 agent and 97 web tests.
Focused tests cover processed-success, processed-error and missing-status
sequences, confirmed/finalized success and failure, contradictory metadata,
malformed statuses, RPC polling failure and late responses. Processed status
is never promoted to definitive success or failure.

Final V8 coverage: security 92.03% statements / 88.95% branches /
96.07% functions / 93.84% lines; agent 99.31% / 97.97% / 100.00% /
99.15%; web 89.84% / 83.76% / 92.08% / 94.32%. The web application
classification and submission implementation now has its new processed,
contradictory, missing-status and definitive terminal outcomes exercised
deterministically.

The web submission implementation now requires explicit or legacy-valid
confirmed/finalized commitment with coherent error evidence. Confirmation
processing has the existing 30-second deadline; the broadcast deadline remains
10 seconds. No test broadcasted funds or used a live wallet. Mocked RPC and
controlled clocks exercise fork-sensitive status transitions but cannot prove
all provider schedules or network behavior.

## Authentication challenge browser binding

The complete suite increased to 295 tests: 96 security, 93 agent and 106 web
tests. Nine focused web tests were added for browser-context binding and
challenge lifecycle boundaries.

V8 coverage after the authentication changes:

| Package | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Security engine | 92.03% | 88.95% | 96.07% | 93.84% |
| AI agent | 99.31% | 97.97% | 100.00% | 99.15% |
| Web application | 89.74% | 83.71% | 92.14% | 94.42% |

The session-store scope is 91.50% statements, 84.53% branches, 100.00%
functions and 96.62% lines. It remains below the 90% branch target; uncovered
branches are mainly rare session expiry, context eviction and cookie-format
combinations. Critical authentication decisions exercised by the suite include
missing/forged/expired browser context, context-origin mismatch, expired
challenges, incorrect wallet/signature, replay, concurrent consumption, wrong
browser, same-wallet multiple browser contexts, targeted challenge abuse,
per-context issuance limits, global storage exhaustion and cookie security
attributes.

The public challenge and sign-in endpoints no longer charge claimed-wallet
quotas. A public wallet address is treated only as a draft input and never as
proof of identity. Each browser context is limited to three outstanding
challenges and both challenge and auth-context maps are capped at 10,000
records. Failed authentication does not consume or evict the challenge.
Successful authentication atomically consumes the matched challenge and
invalidates that browser's auth context while preserving session rotation.

Tests use ephemeral Ed25519 keys and deterministic cookie values. They do not
test a real wallet extension or browser cookie jar, trusted ingress, process
distribution or load behavior. Process-local auth-context and challenge maps
do not protect against a distributed attacker across separate server instances;
shared deployment affinity or storage remains required for stronger guarantees.

## Authentication challenge browser binding

The complete suite before this task was 286 tests (96 security, 93 agent,
97 web). Authentication challenge hardening adds deterministic browser,
expiry, replay, cross-wallet and storage-boundary coverage. The final test
count will be recorded after the complete suite completes.

The implementation adds a 10-minute opaque pre-authentication cookie. Every
challenge is bound to that cookie's server record, the exact wallet, origin
and `Solana Devnet` text. A browser context may hold three outstanding
challenges. The challenge and authentication-context stores are both capped
at 10,000 records. Challenge-generation public claimed-wallet quotas were
removed because a public wallet address is not a verified identity and such a
quota can deny authentication to that wallet. Global and per-context limits
remain, as do public per-client and route quotas. Failed signatures do not
consume or evict another challenge.

Tested boundaries include missing/forged/expired context cookies, challenge
expiry/replay, wrong wallet/signature/origin, concurrent consumption,
same-wallet authentication from multiple contexts, targeted challenge abuse,
per-context 429 behavior, global 503 storage exhaustion, context/pruning
behavior, session rotation and logout. The tests use ephemeral Ed25519 keys
and mock browser cookie values. They do not prove real wallet-extension,
browser-cookie, ingress or process-distribution behavior.

## SG-01 submission receipt validation

The original audited revision was `a9825ae0ae855c7d549ea52e0bf99b686e7e2b0d`.
The synchronized remediation baseline is `3ffd70c6f0e064294047d32ec5352d73ca263f19`,
followed by the SG-01 implementation commit on `feat/security-hardening`.

Independent audit evidence was not available locally. The original failure
was reproduced locally using an empty successful submit response and a
mismatched signature. The previous UI could only become confirmed after the
flow resolved; the remediation requires runtime validation before confirmation.

The client now validates a strict `{ signature }` receipt. The signature must
be a canonical Base58 string that decodes to exactly 64 bytes and equals the
expected signature derived from the signed transaction before submission.
Malformed JSON, empty bodies, missing/null/non-string signatures, arrays,
objects, invalid Base58, wrong-length signatures, noncanonical encodings,
unexpected envelopes and mismatched signatures are treated as unknown
outcomes. The original signature, Explorer recovery link and unresolved
submission guard are retained. No retry or rebroadcast is dispatched.

Unit and browser verification used ephemeral keys and instrumented API
responses. The production Chromium regression passed three scenarios:

- Empty successful response: no "Confirmed on Devnet", unknown outcome,
  expected Explorer link retained, Continue blocked and one submit call.
- Structurally valid mismatched signature: no confirmation, unknown outcome,
  expected Explorer link retained, Continue blocked and one submit call.
- Matching 64-byte signature: legitimate confirmed state and one submit call.

Browser harness: `apps/web/tests/browser-sg01.cjs`, run from `apps/web` with
`pnpm browser:sg01`. It uses an injected ephemeral Phantom-compatible wallet
and mocks the application API; it sends no real transaction or funds.

The private audit archive and production-browser harness were not present
locally. Therefore the independent audit reproduction itself was not rerun;
the equivalent controlled Chromium and unit reproduction is recorded here.

Final SG-01 verification:

- Workspace tests: 317 passing (96 security, 93 agent, 128 web).
- Web V8 coverage: 90.15% statements, 84.61% branches, 92.56% functions,
  94.57% lines.
- Security/agent coverage remained 92.03/88.95/96.07/93.84 and
  99.32/97.97/100/99.16 respectively.
- Production Chromium: 3/3 SG-01 scenarios passed: empty response,
  mismatched signature and matching signature.
- Each browser scenario observed exactly one submit dispatch.
- No browser scenario displayed confirmation for an invalid/missing receipt.
- `pnpm lint`, `pnpm typecheck`, `pnpm build` passed.
- `pnpm audit --audit-level high` passed with four moderate findings and no
  high-severity finding at this threshold.
- Playwright 1.55.1 is a development-only browser test dependency.

## Submission SDK transport policy

The Devnet write connection explicitly disables the SDK HTTP rate-limit retry
loop, independently of the existing validator-side forwarding setting
(`maxRetries: 0`). Read-only status polling uses its own connection and retains
its prior behavior. Preflight, the one-shot gateway, application deadlines and
expected-signature reconciliation are unchanged.

Regression tests exercise the actual configured SDK write transport with an
injected synthetic fetch and check the exact signed wire, HTTP send attempt
count, expected-signature status lookup and replay rejection. They cover HTTP
200, 429, 500, 503 and an unresolved rate-limited submission. The tests do not
contact a live RPC or broadcast funds. These tests were executed in the final
workspace run below. This is deterministic mocked transport evidence, not proof
of provider behavior.
The application deadline still does not guarantee cancellation of underlying
network work or control retries by external infrastructure.

## Ledger status error representation

Solana JSON-RPC supports fieldless transaction-error variants as strings and
variants with associated data as objects. The classifier now recognizes known
fieldless variants (including AccountNotFound) only with definitive commitment
evidence. Processed observations and unknown strings remain provisional. Empty
objects and arrays are not definitive error evidence, and malformed legacy slot
metadata is rejected. Regression tests exercise confirmed, finalized, legacy,
processed and malformed statuses plus the authenticated submit response and
one-shot behavior. These tests were executed in the final workspace run below.
This does not claim independent browser or production-provider verification.

## Final seven-scenario security demonstration — 2026-11-28

**Source:** `origin/main` at `3c1bfec622759b7e3eb92253e601fe6645bf198b`, plus
the Tazio-owned demo-evidence changes based on commit
`5fff4038d66f35633b79e23e6c5b4bad66826d1f`.

**Commands executed**

```sh
pnpm build
node --test packages/security/tests/integration/devnet.mjs
pnpm --filter @solguard/security test
pnpm --filter @solguard/security typecheck
pnpm --filter @solguard/security build
pnpm lint
pnpm typecheck
pnpm test
pnpm audit --audit-level high
node --test scripts/verify-https.test.mjs
```

**Read-only live Devnet results:** the explicit Node integration suite ran eight
cases (the requested seven plus the existing unsupported-instruction regression):
8 passed, 0 failed, 0 skipped. Per-case actual verdict and first finding:

| Scenario | Expected | Actual | Finding/rule | Simulation |
|---|---|---|---|---|
| Legitimate transfer | PASS | PASS | none | Present; live read-only simulation |
| New recipient | WARN | WARN | `RECIPIENT_NEW_ACCOUNT` | Present; live read-only simulation |
| Hidden additional transfer | BLOCK | BLOCK | `EXTRA_TRANSFER` | None; rejected before simulation |
| Recipient substitution | BLOCK | BLOCK | `RECIPIENT_MISMATCH` | None; rejected before simulation |
| Amount manipulation | BLOCK | BLOCK | `AMOUNT_MISMATCH` | None; rejected before simulation |
| Excessive priority fee | BLOCK | BLOCK | `EXCESSIVE_PRIORITY_FEE` | None; cap rejects before simulation |
| Transaction tampering | BLOCK | BLOCK | `TX_MODIFIED` | None for modified wire; unsigned fixture was not approved |
| Existing unsupported-instruction regression | BLOCK | BLOCK | `UNSUPPORTED_INSTRUCTION` | None |

The live runner obtains a recent Devnet blockhash and performs RPC identity,
fee, simulation, and freshness reads when a scenario reaches those stages. The
new-recipient keypair is generated randomly; no known private key is used.
Controlled wire mutation in the tampering case is local test data only. These
scenarios do not load a key, request wallet approval, sign with a wallet, call a
submission transport, broadcast, or submit a transaction. They are live
read-only RPC observations; pipeline unit cases and browser harness evidence
elsewhere in this report are deterministic/mock evidence and are not real
wallet-extension tests.

**Verification results:** security suite 116 tests passed across 10 files;
agent suite 99 passed across 1 file; web suite 170 passed across 7 files;
`pnpm test` completed successfully. Security typecheck/build, root typecheck,
root lint, and full production build passed. HTTPS synthetic tests: 4 passed.
`pnpm audit --audit-level high` exited 0 and reported four moderate findings,
zero high findings at the requested threshold. `git diff --check` passed.
Build/test commands performed no transaction submission.

**Outstanding evidence:** no real wallet-extension test and no deployed HTTPS
verification were performed. GitHub reports no deployment records, and the
repository contains no configured or documented actual deployment URL; the
team must provide an authorized deployment URL before running the HTTPS
verifier. The audit-mentioned Python browser/wire probes are not present among
tracked repository files and were not recreated. Existing browser evidence
uses an injected/mock wallet and mocked API, not an extension or live
submission.
