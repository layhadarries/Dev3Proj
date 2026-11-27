# System architecture

```mermaid
flowchart LR
    U[User browser] -->|Wallet + JSON| W[Next.js web app]
    W --> AUTH[Session/authentication]
    W --> API[API route dispatcher]
    API --> AG[Agent parser/builder]
    API --> GW[Confirmation gateway]
    GW --> SEC[Security engine]
    SEC --> RPC[Devnet RPC]
    GW --> WAL[Wallet handoff]
    W --> RL[Rate and in-flight limits]
```

## Components

- **Frontend**: Next.js UI, wallet adapter, confirmation and warning review.
- **Web API**: strict JSON handlers, Origin/Fetch Metadata checks, session
  resolution, rate limits and transport composition.
- **Agent**: natural-language parsing and unsigned transaction construction.
- **Shared contracts**: Zod schemas and wire serialization for intent,
  transaction and security reports.
- **Security engine**: deterministic decode, simulation, policy and integrity
  checks.
- **Confirmation gateway**: process-local, one-time server state binding
  wallet, network, intent and approval phases.
- **Wallet**: client-side Ed25519 login and sign-only transaction approval.
- **RPC**: pinned public Devnet endpoint for reads, simulation and broadcast.

## Trust boundaries

```mermaid
flowchart TD
    N[Untrusted: user text, LLM, HTTP body, headers, wallet bytes] --> D[Deterministic application boundary]
    D --> S[Trusted server policy and confirmation state]
    S --> X[Sign-only wallet]
    X --> Y[Untrusted RPC/transport result]
    Y --> D
```

The browser, AI, network, RPC and transaction bytes are untrusted by default.
The Node server owns confirmation state and policy. The RPC operator is trusted
for evidence accuracy but can still cause unknown or stale results.
