# Verification and coverage

## Evidence at the latest documented challenge commit

Source: `feat/security-hardening` commit `36172a4eac29dd04b1eb53af6059ae398d799223`.

Verified locally in the development session:

| Area | Result |
|---|---|
| Workspace tests | 295 (96 security, 93 agent, 106 web) |
| Security coverage | 92.03% statements, 88.95% branches, 96.07% functions, 93.84% lines |
| Agent coverage | 99.31%, 97.97%, 100%, 99.15% |
| Web coverage | 89.74%, 83.71%, 92.14%, 94.42% |
| Session store | 91.50% statements, 84.53% branches, 100% functions, 96.62% lines |
| Lint | Passed |
| Typecheck | Passed |
| Production build | Passed |
| Audit | Passed threshold; 4 moderate advisories |

## Limits of evidence

- Mocked RPC, wallet and model behavior is not live provider evidence.
- Live browser tests and real extension tests remain separate results.
- Live Devnet integration does not imply production ingress testing.
- No live mainnet or real-fund test was performed.
- CI status must be checked separately on the relevant commit/PR.

Canonical measurements and caveats are in
`docs/SECURITY_TEST_REPORT.md`.
