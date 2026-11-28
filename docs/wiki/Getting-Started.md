# Getting started

SolGuard is a Node.js/pnpm monorepo containing a Next.js web app and three
TypeScript workspace packages.

## Minimum experience

You should understand JSON APIs and basic Solana transaction concepts. For a
live Devnet demo, use a throwaway funded wallet and never paste a seed phrase
into the application or repository.

## Paths

- Read-only security demos: no wallet, signing or transaction submission; public Devnet RPC reads are required
- Integrated web demo: sign-only wallet flow and controlled Devnet submission
- Developer setup: build, tests, coverage and lint
- Security review: package source and adversarial tests

See [Installation](Installation), [Quick start](Quick-Start), and
[Configuration](Configuration).

The current scope is limited to Devnet legacy single-signer SOL transfers.
Use a disposable wallet funded only with test SOL. SolGuard has not been
independently audited; do not use it with real funds.
