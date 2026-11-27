# Threat model

## Assets

- User wallet authorization
- Confirmed recipient and amount
- Single-use approval state
- Signed transaction bytes
- Browser session and pre-auth context
- RPC/model availability

## Actors

- Honest user
- Malicious natural-language user or prompt injection source
- Malicious dApp/builder
- Remote AI provider
- Compromised browser script
- RPC operator or network adversary
- Resource-abusing direct API client

## STRIDE summary

| Category | Example | Implemented control / residual risk |
|---|---|---|
| Spoofing | Fake wallet or session | Ed25519 challenge, bound cookie, origin checks; real browser extension remains to be assessed |
| Tampering | Recipient/amount/message mutation | Strict schemas, exact hash/byte verification, replay checks |
| Repudiation | User claims no confirmation | Server confirmation state; no durable audit in MVP |
| Info disclosure | Secrets, cookies, RPC detail | No keys, no-store responses, sanitized errors |
| DoS | Challenges, AI, RPC, concurrent submit | Context/global limits, in-flight reservations, bounded maps |
| Elevation | AI asks to sign/submitting/report | No tools, no secrets, no approval token, independent gateway |

Public wiki pages must not publish reproduction details for unresolved
vulnerabilities. Sensitive findings belong in a private maintainer location.
