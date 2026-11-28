# Known limitations and roadmap

## Current limitations

- **Narrow transaction scope:** Devnet legacy single-signer SOL System transfers with supported compute-budget settings only. SPL, Token-2022, versioned messages/address lookup tables, swaps, Anchor and arbitrary program instructions are unsupported and fail closed.
- **No Mainnet/on-chain enforcement:** the application policy is server-side. The default 1 SOL spending ceiling includes fees but is not enforced by a Solana program.
- **Simulation is an observation:** state can change before landing; simulation does not guarantee execution, confirmation or finality.
- **RPC trust and availability:** verification relies on the pinned public Devnet RPC for identity, fees, simulation, blockhash freshness and status. Missing or inconsistent evidence blocks or yields an uncertain outcome.
- **Process-local state:** sessions, challenges, confirmation gateway, rate buckets and in-flight limits are in memory. Restart invalidates pending state; multiple processes do not share state or quotas.
- **Uncertain submission:** broadcast has a 10-second application deadline. The SDK write transport receives a per-request `AbortSignal`; on timeout the application aborts that local HTTP request and reconciles the expected signature for up to 30 seconds. Aborting does not prove the provider never received or accepted the transaction. SolGuard never automatically resends; users must reconcile uncertain outcomes.
- **Limited wallet assurance:** real extension compatibility and deployed HTTPS behavior require separate human testing. Mock-wallet tests are not extension tests.
- **Limited coverage scope:** SolGuard protects only the transfer flow routed through this service; other wallet activity is outside its boundary.
- **Dependency findings:** four moderate transitive advisories remain. The high-severity audit gate passes, but the audit is not clean.
- **No independent audit:** no security certification or guarantee is claimed.

## Future work, not current capability

- Shared session and rate-limit storage or carefully validated affinity.
- Trusted ingress peer identity and distributed abuse controls.
- SPL/Token-2022 and additional transaction formats.
- Persistent security evidence and broader wallet compatibility testing.
- Provider-specific failover and load testing.
- Mainnet only after a separate threat model, policy review and explicit authorization.

See [Security architecture](Security-Architecture) for trust boundaries and
[Verification](Verification) for what evidence has and has not been collected.
