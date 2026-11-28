# SolGuard

**Trust nothing. Sign with confidence.**

SolGuard is an intent-aware transaction firewall for Solana. A transaction can be valid for the network and still do something its signer never intended. SolGuard independently checks the transaction against a user-confirmed intent before the transaction is presented for wallet signing.

The MVP is **Devnet-only**, for **single-signer legacy SOL transfers**. Transaction construction is deterministic; verification is independent of the natural-language parser; the wallet remains non-custodial and signs only.

> **In one sentence:** an AI may help interpret a request, but it cannot authorize the transaction.

[Demo guide](docs/DEMO.md) · [Security evidence](docs/SECURITY_TEST_REPORT.md) · [API reference](docs/wiki/API-Reference.md) · [Architecture](docs/SECURITY_ARCHITECTURE.md)

## Why intent verification matters

A user asks to send 0.5 SOL. A malicious or compromised builder can produce an executable transaction with the requested transfer **and** a second transfer to an attacker. The runtime can accept both instructions; execution validity does not prove that the user approved both.

SolGuard compares three different things:

| Evidence | Question |
|---|---|
| Confirmed intent | What did the user explicitly approve? |
| Decoded instructions | What does this exact transaction ask Solana to execute? |
| Devnet simulation | What effects did the RPC report for this message at the observed slot? |

Simulation is not intent verification: it estimates execution against observed state. SolGuard separately decodes and compares the instruction set and simulated balance changes with the confirmed recipient, amount, payer, fee and spending policy. The parser is treated as untrusted input, not as an authority.

## Two workflows

### Intent-based transfer

```mermaid
flowchart LR
    U[User request] --> P[Parser proposes fields]
    P --> C[User confirms server-owned intent]
    C --> B[Deterministic builder]
    B --> V[Independent decoder and verifier]
    V -->|BLOCK| Stop[Stop: no wallet handoff]
    V -->|PASS| H[Server one-use handoff]
    V -->|WARN| A[User explicitly acknowledges]
    A --> H
    H --> W[Wallet sign-only]
    W --> S[Server verifies signed message and payer signature]
    S --> T[One controlled Devnet broadcast]
    T --> R[Receipt/status reconciliation]
```

1. The parser proposes a recipient and amount from user text. A deterministic fallback handles simple “send … SOL to …” requests when no LLM is configured.
2. The server creates a draft; the user confirms the structured fields explicitly. The parser does not create authorization.
3. Deterministic code builds an unsigned legacy transaction.
4. The security engine independently decodes it, checks policy and requests Devnet fee, simulation and freshness evidence.
5. `BLOCK` stops the transfer. `WARN` requires a separate session-bound acknowledgement. Only then can the server issue the one-use wallet handoff.
6. The wallet signs; SolGuard checks the returned wire’s exact message and payer signature against the inspected approval.
7. The server broadcasts once and reconciles the signature. An uncertain result is not automatically rebroadcast.

### External transaction analysis

An authenticated user provides an unsigned legacy transaction plus an independently specified recipient and canonical base-unit amount. The API decodes and verifies it against that intent and returns a report. The payer comes from the authenticated wallet session, not the request.

Analysis is **informational**. It does not confirm an intent, acknowledge a warning, create a wallet handoff, sign, or submit. See the [analyzer API contract](docs/wiki/API-Reference.md#post-apianalyze).

## Verdicts

| Verdict | Meaning |
|---|---|
| **PASS** | Required checks succeeded for the inspected transaction and confirmed intent at the observed simulation state. This is not a guarantee of later execution. |
| **WARN** | A recognized condition (currently a zero-balance/new recipient account) requires explicit acknowledgement before transfer handoff. |
| **BLOCK** | Verification failed, required evidence is missing/inconsistent, or an unsupported instruction was encountered. The transfer flow does not offer signing for it. |

Current decoder support is intentionally narrow: canonical legacy System Program transfers and optional bounded compute-budget settings. Other programs and instruction families fail closed. Shared contract rule IDs include reserved token-specific rules that are **not implemented detectors**.

## Security model

- **Authorization is explicit and server-owned.** A browser session binds the wallet and Devnet identity. Confirmation records are bound to that session and move through draft, confirmed, checking, verified, preparing and handed phases. State is consumed before asynchronous work where needed to prevent replay/concurrent reuse.
- **Expiry uses two clocks.** Draft and post-confirmation windows are checked against wall-clock expiry and a monotonic deadline. Confirmation prepares and validates the new intent, timestamps and expiries before atomically committing the state transition.
- **The transaction is treated as hostile bytes.** The engine accepts canonical legacy messages only, requires one payer signer, rejects unsupported/extra instructions and compares exact payer, recipient and lamport amount.
- **Fees and spending are server policy.** Estimated total fee and priority fee are checked before simulation; the configured spending cap compares transfer amount plus fee. Its default is 1 SOL, configured with `SOLGUARD_MAX_SPEND_LAMPORTS`. This is server-side application policy, **not an on-chain limit**.
- **Simulation is independent evidence.** The Devnet RPC is pinned and cluster identity checked. Fee, simulation, balance vectors and blockhash freshness are validated. A compromised or unavailable RPC remains a trust/availability risk.
- **Approval binds exact bytes.** SHA-256 identifies the inspected message. The signed wire must contain that exact message and a valid Ed25519 payer signature. The server uses a private snapshot and single-use handoff; concurrent or replayed submissions fail closed.
- **Submission is controlled and conservative.** The write transport has an application deadline and aborts its HTTP request on timeout, sends at most once, derives the expected signature from the verified signed bytes and reconciles status. Aborting cannot prove the RPC provider did not receive or accept the transaction. Unknown outcomes are surfaced as uncertain; no automatic rebroadcast occurs.

These controls reduce specific risks; they do not guarantee safety or replace independent security review.

## Reproducible demonstrations

The command-line scenarios use public Devnet RPC reads; they do not need a wallet, API key, signature or transaction submission. They do need the public Devnet RPC to be available.

```sh
pnpm install --frozen-lockfile
pnpm build
node packages/security/scripts/demo.mjs match       # PASS
node packages/security/scripts/demo.mjs extra       # BLOCK EXTRA_TRANSFER (multiple transfer instructions)
node packages/security/scripts/demo.mjs recipient   # BLOCK RECIPIENT_MISMATCH
node packages/security/scripts/demo.mjs amount      # BLOCK AMOUNT_MISMATCH
node packages/security/scripts/demo.mjs tamper      # BLOCK TX_MODIFIED
node packages/security/scripts/demo.mjs unsupported # BLOCK UNSUPPORTED_INSTRUCTION
```

The `warn` case uses a random 32-byte public address. The fee case is rejected before simulation. Other early-detection BLOCK cases do not all reach simulation. In `tamper`, the unsigned message first passes verification/simulation, then local wire bytes are changed and signed-wire verification rejects them; no wallet signs. Run the full live, read-only suite with:

```sh
node --test packages/security/tests/integration/devnet.mjs
```

It runs six live test cases: match, extra, recipient, amount, tamper (twice), and unsupported. This is separate from deterministic fixture tests, mocked RPC tests, mock-wallet browser tests and any real wallet testing. The live harness currently does not cover WARN or the fee demo.

## Engineering evidence

| Evidence | Result | Source |
|---|---|---|
| Merged-main CI | At the last verified repository state, run `46151035003` passed checks, secret scan and Devnet job at main `3c1bfec` | [GitHub Actions](https://github.com/layhadarries/Dev3Proj/actions/runs/46151035003) |
| PR #15 evidence (not merged into main) | 118 security + 99 agent + 170 web = **387 workspace tests**; six read-only live Devnet test cases; HTTPS synthetic tests 4/4 | [PR #15](https://github.com/layhadarries/Dev3Proj/pull/15), [detailed report](docs/SECURITY_TEST_REPORT.md) |
| PR #15 CI | Build, typecheck, lint, workspace tests, mock-wallet browser regression, high-severity audit gate and secret scanning passed on the earlier evidence head; PR Devnet job skipped | [Run `46152422986`](https://github.com/layhadarries/Dev3Proj/actions/runs/46152422986) |
| Dependency audit | High-severity gate passes; four moderate transitive advisories remain | [Advisory assessment](docs/wiki/Verification.md#dependency-advisory-assessment-t-04-28-november-2026) |

These GitHub results are a dated snapshot from the audit, not a claim about the documentation PR's checks or current live repository status. The 387 is the workspace test total only; it does not add live demos, browser scenarios, contract probes or duplicate regression invocations. Teammate-reported live wallet submissions and browser results are labelled separately in the security report. Real wallet-extension and deployed-HTTPS checks remain separate and are not claimed here.

## Getting started

### Requirements

- Node.js 24 and pnpm 12.23.0 (the verified CI versions; the root manifest requires Node.js >=20).
- Git and access to the public Solana Devnet RPC for live demos.

### Install and run locally

The repository’s GitHub default branch may be `readme-only`; explicitly check out the integrated `main` branch:

```sh
git clone https://github.com/layhadarries/Dev3Proj.git
cd Dev3Proj
git switch main
pnpm install --frozen-lockfile
pnpm build
cd apps/web
pnpm dev
```

Open `http://localhost:3000`. Development infers the request origin; if using another origin, set `APP_ORIGIN` to that exact origin. Production requires `APP_ORIGIN` to be the canonical HTTPS origin. The app is Devnet-pinned and does not require wallet credentials just to start.

Without `LLM_*` configuration, simple supported transfer syntax uses the deterministic parser; other phrasing asks for clarification. To use an optional OpenAI-compatible chat-completions service, configure all three **server-side only**:

```dotenv
LLM_BASE_URL=https://your-approved-provider.example/v1
LLM_API_KEY=...
LLM_MODEL=...
```

Do not commit secrets or paste them into the browser. `.env.example` documents the local `scripts/local-llm.sh` setup. No LLM is needed for builds, tests or the security demo commands above.

Run checks:

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @solguard/security test
pnpm audit --audit-level high
node --test scripts/verify-https.test.mjs
```

The browser application can initiate Devnet transactions only after wallet interaction. Do not connect a funded wallet or approve a transaction unless intentionally performing an authorized test with disposable Devnet funds.

## Architecture

```mermaid
flowchart TB
    U[User] --> UI[Browser UI]
    UI <-->|challenge and sign-only approval| W[Wallet extension]
    UI -->|same-origin API| API[Next.js server and API]
    API --> AUTH[Session and origin boundary]
    API --> AG[Agent parser]
    AG -->|untrusted proposal| BUILDER[Deterministic transaction builder]
    API --> GW[Confirmation gateway<br/>session-bound state]
    BUILDER --> GW
    GW --> ENGINE[Independent security engine]
    SH[Shared validated schemas] --> API
    SH --> AG
    SH --> BUILDER
    SH --> ENGINE
    ENGINE -->|identity, fee, simulation, freshness reads| RPC[Solana Devnet RPC]
    ENGINE --> GW
    GW -->|one-use handoff only after PASS or acknowledged WARN| UI
    UI -->|signed wire| GW
    GW -->|verified snapshot; one controlled send| SUB[Submission transport]
    SUB --> RPC
    RPC -->|status observation| SUB
```

The AI parser never connects to the wallet or submission transport. The agent package proposes/builds; the server gateway and independent engine control the authorization boundary. Shared schemas validate data but do not themselves grant authority.

### Repository map

```text
apps/web/                 Next.js interface, API routes, sessions and transport
packages/agent/            Natural-language parser, deterministic builder, explanations
packages/security/         Independent decoder, Devnet verification, gateway and tests
packages/shared/           Runtime schemas and wire serialization
docs/                      Technical, security, demo and verification documentation
docs/wiki/                 GitHub Wiki Markdown export
scripts/                    Local model helper and HTTPS verifier
.github/workflows/          Build/test, audit, secret scan and Devnet CI
```

`packages/security` does not depend on the agent or web application; its workspace boundary allows deterministic testing independently of the UI and parser.

## Supported scope and limitations

- Devnet only; one legacy SOL System Program transfer, one payer signer, and supported compute-budget settings.
- SPL, Token-2022, versioned transactions/address lookup tables, arbitrary programs, swaps and Mainnet are unsupported. Unsupported instructions fail closed.
- Simulation observes a point in time; state, fees and transaction landing conditions can change.
- The public RPC is a trust and availability dependency. RPC success is evidence, not a cryptographic guarantee of all network state.
- Session, confirmation, challenge, rate-limit and in-flight state are process-local; restart invalidates state and multiple workers do not share quotas.
- An ambiguous broadcast may have reached the provider. SolGuard reconciles by expected signature and does not automatically rebroadcast, but cannot promise provider-side cancellation.
- Protection applies only to transactions routed through SolGuard; it cannot constrain other wallet activity.
- The server spending cap is not enforced by the Solana program/on-chain.
- Four moderate transitive dependency advisories remain. The high-severity audit gate passes; this is not a clean audit or a certification.
- SolGuard has not been independently audited. No safety guarantee is claimed.

### Roadmap

Possible future work, not current functionality: SPL/Token-2022 support, additional transaction formats, shared/distributed session storage, broader wallet compatibility, and Mainnet support after a separate threat and policy review.

## Team

SolGuard is built by **Zettabyte**. The repository attributes workstreams as follows:

| Contributor | Responsibilities |
|---|---|
| **Megaguy32** | Agent/parser, natural-language interpretation, transaction construction and agent tests |
| **Taz (Tazio)** | Security engine, backend, deterministic verification, sessions, transaction integrity and adversarial testing |
| **Zulayha** | Frontend, wallet experience, visual design, presentation and demo |

## Built before and during the hackathon

> The [Dev3pack hackathon rules](https://hack.dev3pack.xyz/faq) ask teams to be transparent about pre-existing work and work completed during the event.

The hackathon runs **27–29 November 2026**.

- **Before (26 November):** the first README, the project scaffold, a first version of the shared data contracts and security checks, and a first version of the request parser and transaction builder with a script for a local open-weight model.
- **During (27–29 November):** the Devnet security engine and confirmation step, the adaptation and hardening of the parser and builder, the web app and server, wallet signing, Devnet submission, further tests, CI and documentation.

AI coding assistants were used. The commit history shows the dates.

## Documentation

| Area | Guides |
|---|---|
| Getting started | [Install and run](docs/wiki/Installation.md), [quick start](docs/wiki/Quick-Start.md), [configuration](docs/wiki/Configuration.md), [demo](docs/DEMO.md) |
| Architecture and integration | [System architecture](docs/wiki/Architecture.md), [security architecture](docs/SECURITY_ARCHITECTURE.md), [Solana integration](docs/SOLANA_INTEGRATION.md), [agent integration](docs/AGENT.md), [API reference](docs/wiki/API-Reference.md) |
| Security and threat model | [Threat model](docs/wiki/Threat-Model.md), [transaction firewall](docs/wiki/Transaction-Firewall.md), [authentication](docs/wiki/Authentication.md), [AI security](docs/wiki/AI-Security.md), [security review history](docs/SECURITY_REVIEW.md) |
| Testing and verification | [Security test report](docs/SECURITY_TEST_REPORT.md), [verification wiki](docs/wiki/Verification.md), [testing guide](docs/wiki/Testing.md), [penetration-testing methodology](docs/wiki/Penetration-Testing.md) |
| Deployment and operations | [Deployment notes](docs/wiki/Deployment.md), [browser security](docs/wiki/Browser-Security.md), [rate limits](docs/wiki/Rate-Limits.md), [troubleshooting](docs/wiki/Troubleshooting.md) |
| Known limitations | [Limitations and roadmap](docs/wiki/Limitations.md) |

## Contributing

SolGuard handles security-sensitive transaction data. Keep contributions focused; preserve fail-closed behavior; add regression tests for security-relevant changes; document what was tested and what was not. Do not include private keys, seed phrases, credential-bearing RPC URLs, private audit artifacts or personal wallet evidence in issues, commits or CI logs. Coordinate changes to shared wire contracts with the team.

## License

No license file or approved license decision is present in the repository. Reuse and redistribution terms remain for the team to decide; no license is implied here.
