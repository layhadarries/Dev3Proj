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
