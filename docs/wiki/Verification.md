# Verification and coverage

## Current evidence

The current source of truth is the merged main commit:

- Commit: 74cb7e6396b0f034971d07c2519729d1e27db209
- Latest successful main workflow: run 46054922795
- Open pull requests at the last repository review: none

The workflow runs:

- Workspace build, typecheck, lint and tests
- Dedicated transaction-security regression tests
- High-severity dependency audit gate
- Secret scanning
- Devnet integration checks on pushes to main

The dedicated regression coverage exercises the existing deterministic tests for:

- Exact transaction and signed-receipt matching
- Invalid, missing and mismatched receipt handling
- Ambiguous submission outcomes
- Confirmation-status classification
- Server-side verification and request boundaries
- Duplicate-submission protections represented by the flow and server tests

## Evidence limits

- The reported CI results are evidence for the commit and workflow run above; rerun CI after subsequent changes.
- Unit and integration tests use deterministic fixtures and mocks where documented. They do not replace live wallet-extension testing.
- The Devnet job does not prove production ingress or deployed-HTTPS behavior.
- Real browser-wallet smoke testing, including rejection, reload recovery and sign-out through the deployed application, remains separate verification work.
- No Mainnet or real-fund test has been performed.
- The dependency workflow gates high-severity findings. Moderate advisories require individual assessment and are not, by themselves, proof that the application is exploitable.

## Scope

The MVP covers Devnet-only legacy SOL transfers with one signer, explicit intent confirmation, deterministic inspection, simulation, warning acknowledgement, wallet signing, exact signed-byte verification, controlled submission and receipt reconciliation.

SPL tokens, Token-2022, lookup tables, Anchor workflows, Mainnet and durable multi-process session state remain outside the MVP scope.
