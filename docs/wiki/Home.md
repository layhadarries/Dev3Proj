# SolGuard

**Trust nothing. Sign with confidence.**

SolGuard is an intent-aware, pre-sign transaction firewall for Solana Devnet. It
turns natural language into a proposed transfer, asks the user to confirm a
server-issued card, inspects the resulting transaction, simulates it, compares
its effects with the confirmed intent and prevents a mismatch from reaching the
wallet signing flow.

The integrated app can broadcast on Devnet after explicit wallet signing; its
separate read-only demo commands do not submit transactions.

## The problem

A transaction can be valid for the Solana runtime and still differ from the
user's request. An AI parser, malicious dApp or compromised browser code can
change a recipient, amount or instruction set. SolGuard separates extraction
from authorization: the AI proposes a draft, but deterministic code and explicit
human confirmation establish the approval boundary.

## Intended audience

- Hackathon judges evaluating the MVP
- Developers integrating the agent, web app or security package
- Security researchers assessing assumptions and residual risk
- Maintainers operating or extending the demonstration

## Current MVP

- Legacy, single-signer SOL System transfers
- Natural-language parsing with deterministic grounding
- Wallet authentication using Ed25519 challenge signatures
- Browser-bound authentication contexts and session cookies
- Strict server confirmation gateway
- Decode, simulation, fee, balance and intent comparison
- PASS, WARN and BLOCK verdicts
- Sign-only wallet handoff
- Exact signed-byte verification before Devnet broadcast
- Confirmed/finalized commitment reconciliation
- Informational unsigned-transaction analysis endpoint (not an authorization path)
- CSP, CSRF/origin checks, rate limits and process-local in-flight limits

## Explicitly unsupported

SPL/Token-2022 transfers, other instruction families, Mainnet, custody of
private keys and on-chain enforcement are not MVP capabilities.

## Documentation

- [Getting started](Getting-Started)
- [Installation](Installation)
- [Quick start](Quick-Start)
- [Configuration](Configuration)
- [Architecture](Architecture)
- [Repository structure](Repository-Structure)
- [Transaction lifecycle](Transaction-Lifecycle)
- [API reference](API-Reference)
- [Security architecture](Security-Architecture)
- [Threat model](Threat-Model)
- [Authentication](Authentication)
- [AI security](AI-Security)
- [Transaction firewall](Transaction-Firewall)
- [Rate limiting](Rate-Limits)
- [Browser security](Browser-Security)
- [Testing](Testing)
- [Verification and coverage](Verification)
- [Penetration testing](Penetration-Testing)
- [Deployment](Deployment)
- [Troubleshooting](Troubleshooting)
- [Architecture decisions](Architecture-Decisions)
- [Limitations and roadmap](Limitations)

## Evidence label

The repository distinguishes:

- **Implemented**: present in source and covered by deterministic tests
- **Locally verified**: reported by commands in a local checkout
- **CI-verified**: reported by GitHub Actions
- **Live Devnet**: read-only or signed Devnet evidence, clearly marked

SolGuard has not been independently audited and must not be presented as
guaranteed protection.

For current evidence and pending verification, see
[Verification and coverage](Verification) and [Limitations](Limitations).
