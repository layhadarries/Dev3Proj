# Penetration-testing methodology

## Scope and authorization

Testing must use an isolated Devnet deployment, owner-authorized accounts and
synthetic test wallets. Do not test production or third-party infrastructure
without written authorization.

## Test areas

- Challenge replay, browser-context substitution and signature forgery
- Session expiry, logout and cross-wallet isolation
- Origin, CSRF and malformed JSON
- Per-wallet/session/global/concurrency quotas
- Prompt injection and altered model responses
- Recipient/amount/payer/message tampering
- Replay and duplicate broadcast
- RPC timeout, contradictory status and late response
- Spending boundaries
- CSP and headers
- Broadcast deadline and unconfirmed outcome

## Evidence

Record request/response metadata, expected and observed status, commit hash,
ephemeral wallet/public key, RPC test label and mock/live distinction. Never
publish private keys or secrets.

## Finding template

```text
Title:
Severity:
Affected files/routes:
Commit:
Preconditions:
Reproduction steps:
Observed result:
Expected result:
Evidence:
Impact:
Remediation recommendation:
Regression test:
```

Keep unresolved exploit details private until remediation and owner approval.
