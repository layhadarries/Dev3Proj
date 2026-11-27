# Architecture decisions

## Devnet-only MVP

The implementation deliberately excludes Mainnet and funded real-value
submission. This constrains blast radius while preserving the full Devnet
verification and demo architecture.

## Deterministic verification

The AI assists with extraction but never authorizes or signs. The security
engine verifies server-confirmed intent, decoded instructions and simulated
effects.

## Sign-only integration

The wallet receives an unsigned wire and returns a signed wire. The server
verifies exact signed bytes and broadcasts once. Sign-and-send bypasses that
server verification.

## One-shot confirmation

Each confirmation record has a phase and one-time transitions. Replay,
concurrency and cross-session access fail closed.

## Process-local state

For the hackathon, no external database or Redis was added. The trade-off is
simplicity and bounded process behavior at the cost of restart loss and
independent quotas across instances.

## Conservative resources

Time windows, body limits, in-flight reservations and storage caps reduce
unbounded work and memory consumption. Limits are not load-tested guarantees.
