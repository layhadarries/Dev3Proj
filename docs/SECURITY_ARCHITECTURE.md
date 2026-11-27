# Security implementation plan

The foundation on `feat/solana-security` supplied the pnpm workspace, strict TypeScript, ESLint, Vitest, shared Zod schemas, web3.js v1, SPL Token dependency and message hash. The SOL pipeline on `feat/devnet-transaction-firewall` implements the typed read-only RPC client, legacy decoder, simulation checks and signing handoff. Mocks represent fixtures only. See [the integration contract](SECURITY_API.md) for the implemented scope.

| Milestone | Gate before depending on this layer |
|---|---|
| 0: foundation | Reject non-Devnet configuration; document the trusted confirmation boundary and stable wire contract. |
| 1: reads | Check genesis, bound requests, validate account data and preserve integer precision. No send API. |
| 2: simulation | Simulate original unsigned message without replacing its blockhash; require complete same-bank evidence for supported writable accounts. |
| 3: decoding | Accept canonical legacy System transfers first; reject trailing data, unexpected keys, signers and instructions. |
| 4–5: intent and policy | Compare exact payer, recipient, amount, fees and simulation deltas; enforce spending ceilings independent of proposal. |
| 6: token analysis | Resolve owner, mint, authorities and extension semantics before enabling any token transfer. |
| 7–8: signing boundary | Bind message hash, wallet, network, intent and expiry in trusted single-use state; recheck at handoff. |
| 10–12: validation and delivery | Test each layer with isolated fixtures; run live Devnet separately. Review configuration, CI and evidence before enabling approval. |
| 9: optional vault | Only after integrated off-chain tests and a successful live demonstration. |

## Integration decisions

The confirmation component must obtain explicit user authorization separately from the AI proposal. An intent ID or timestamp supplied by the AI is not authorization. Retain the existing `@solguard/shared` decimal-string wire amounts and `payer` field. The trusted session supplies the network and wallet separately. `WARN` is the review verdict and requires explicit acknowledgement at handoff. Consumers must never treat mock reports, an empty findings array, `aggregateVerdict` or a client-supplied message hash as a signing capability.

## Threat boundaries

Treat transaction bytes, labels, logs, metadata and AI output as untrusted data. Reject incomplete RPC evidence rather than substitute fixture data. Pin the public endpoint and genesis identity; this still trusts the RPC operator and TLS. Simulation can become stale before execution. Never log credential-bearing URLs, raw exceptions or transaction payloads. Application-level checks cannot stop unrelated wallet signatures. No signing keys are needed by this package.
