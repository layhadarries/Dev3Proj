# Legacy SOL pipeline validation — 2026-11-27

| Stage | Deterministic checks | Live evidence |
|---|---|---|
| Decoder and comparison | Build, typecheck, lint; 60 tests passed | Decoder is offline. |
| Verification and simulation | Build, typecheck, lint; 62 tests passed | Same-bank simulation at confirmed slot `526831348`. |
| Wallet handoff | Build, typecheck, lint; 82 tests passed | Isolated Node integration suite: 5 passed, 0 failed, 0 skipped. |

### Observed Devnet PASS

Message hash `fb705c730a06f023008ba6a2ffe2799859b7ce495b09be1ef5f6f4588dfab17f`; recent blockhash `Az4seoiQt2dZbPhwZVj5sCPPDCxBfjEywr62VWiaLrSG`. Simulation slot `526831872`, 150 compute units, estimated and simulated fee 5,000 lamports. Payer `964koDACp6GNSW8uL2J49CTa7kuFSQWPErgKMKK1E9QH`: −500,005,000 lamports. Recipient `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`: +500,000,000. System Program: zero change.

### Rejection and signature evidence

- Demo scenarios `extra`, `recipient`, `amount` used real recent blockhashes and blocked during decoding/comparison (`EXTRA_TRANSFER`, `RECIPIENT_MISMATCH`, `AMOUNT_MISMATCH`). They did not need simulation.
- `tamper` passed live simulation and freshness checks before modification. The modified wire bytes returned `TX_MODIFIED`.
- Correct payer signature, missing signature, wrong key, changed signature count, changed message, expiry, fee changes, altered policy, forged report and reuse were tested with deterministic RPC fixtures and ephemeral test-only keys. These are **not** live signed transactions. No wallet approval, submission, confirmation or Explorer transaction signature is claimed.
- Live commands assert expected verdicts and fail on unavailable RPC. Public balances, fees, slots and hashes can change. Reproduce using [SECURITY_API.md](SECURITY_API.md).

For a private read-only run with your own Devnet payer, use `node packages/security/scripts/wallet-evidence.mjs "$PAYER" > wallet-run.json` after building. This report contains identifying public addresses and serialized messages. Keep it local; the default output filename is gitignored.
