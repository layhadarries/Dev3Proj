# Transaction lifecycle

```mermaid
sequenceDiagram
    participant U as User
    participant W as Web app
    participant A as Agent
    participant G as Server gateway
    participant S as Security engine
    participant R as Devnet RPC
    participant X as Wallet

    U->>W: Connect wallet; sign challenge
    W->>A: Parse request text
    A-->>W: Proposed draft or clarification
    W->>G: stage(session, draft)
    G-->>W: Server-owned card, draft expiry
    U->>W: Explicitly confirm card
    W->>G: confirm(id)
    G-->>W: Confirmed server intent
    W->>A: build(confirmationId)
    A->>G: Read intent; inspect unsigned proposal
    G->>S: Decode, compare and verify
    S->>R: Cluster identity, fee, simulation, freshness
    R-->>S: RPC evidence
    S-->>G: PASS, WARN or BLOCK
    alt BLOCK
        G-->>W: Stop; no wallet handoff
    else PASS
        G-->>W: Verified approval
    else WARN
        G-->>W: Warning; require separate acknowledgement
        U->>W: Explicitly acknowledge warning
        W->>G: acknowledge(id)
        G-->>W: Acknowledged
    end
    W->>G: handoff(id)
    G-->>W: One-use unsigned transaction
    W->>X: Sign-only request
    X-->>W: Signed transaction bytes
    W->>G: submit(id, signed bytes)
    G->>S: Verify exact inspected message and payer signature
    S-->>G: Verified snapshot
    G->>R: Broadcast once
    R-->>G: Signature or ambiguous transport result
    G->>R: Reconcile expected signature status
    R-->>G: Confirmed, failed or unresolved
    G-->>W: Success, failure or uncertain outcome
```

## Stop conditions

- Invalid, oversized or ambiguous HTTP input.
- Missing, expired, revoked or changed wallet session.
- Draft, intent, phase, expiry or session binding mismatch.
- BLOCK verdict; WARN without separate explicit acknowledgement.
- Unsupported instruction, invalid fee/spending policy or missing/inconsistent RPC evidence.
- Stale blockhash or changed inspected message.
- Invalid payer signature, signed-byte mutation, expired approval or replay.
- Duplicate/concurrent submission.
- Broadcast deadline or unresolved RPC status.

An uncertain broadcast is not evidence that nothing was sent. The app aborts its local HTTP request on deadline and reconciles by the expected signature; it never automatically resubmits. A user should check the displayed signature before beginning another transfer.
