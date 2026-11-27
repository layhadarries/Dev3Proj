# Transaction lifecycle

```mermaid
sequenceDiagram
    participant U as User/wallet
    participant W as Web app
    participant A as Agent
    participant G as Gateway
    participant S as Security engine
    participant R as Devnet RPC

    U->>W: Wallet challenge/sign-in
    W->>A: Natural-language request
    A-->>W: Grounded ParseResult or clarification
    W->>G: stage(server session, strict draft)
    G-->>U: Confirmation card
    U->>W: Explicit confirmation
    W->>G: confirm(id)
    W->>A: build(confirmationId)
    A->>G: read intent and inspect proposal
    G->>S: Decode/simulate/compare
    S->>R: Fresh blockhash, fee, simulation
    R-->>S: Evidence
    S-->>G: PASS/WARN/BLOCK
    G-->>U: Verified report and unsigned wire
    U->>W: Sign-only wallet approval
    W->>G: submit(signed bytes)
    G->>S: Verify exact signed bytes
    S->>R: Broadcast once
    R-->>W: Signature/status
    W->>R: Poll confirmed/finalized status
```

## Stop conditions

- Invalid, oversized or ambiguous HTTP input
- Missing/expired/revoked wallet session
- Draft or confirmation mismatch
- BLOCK verdict
- Missing warning acknowledgement for WARN
- Wallet or network change
- Stale blockhash or expiry
- Signed-message modification
- Broadcast deadline or RPC reconciliation failure
- Duplicate or concurrent submission

The transaction approval record is consumed at a phase transition or replay;
uncertain outcomes require reconciliation and never trigger automatic resubmit.
