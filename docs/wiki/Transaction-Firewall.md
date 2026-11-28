# Transaction firewall

The current firewall supports canonical legacy System transfer transactions
with optional compute-budget instructions.

## Verdict rules

- **BLOCK**: stop signing or submission.
- **WARN**: continue only after explicit server acknowledgement.
- **PASS**: required checks passed at the observed simulation slot.

PASS does not guarantee execution finality.

## Checks

The engine verifies:

- payer, recipient and integer lamport amount
- exact legacy instruction shape
- allowed programs and instruction variants
- additional instructions
- extra signers
- priority/total fee limits
- decoded simulation evidence
- payer/recipient and simulated balance-vector consistency/change
- blockhash freshness
- exact message hash
- exact signed message bytes and payer signature before submission
- expected-signature reconciliation to confirmed/finalized status after broadcast

The default server spending limit is 1,000,000,000 lamports (1 SOL), including
fees. It is server-configurable only through
`SOLGUARD_MAX_SPEND_LAMPORTS` and rejects invalid u64 values.

## Commitment semantics

`processed` is provisional. It does not produce definitive success or failure.
Only coherent confirmed/finalized status and error evidence terminalize a
transaction. Missing, contradictory or malformed status stays unknown until
timeout.
