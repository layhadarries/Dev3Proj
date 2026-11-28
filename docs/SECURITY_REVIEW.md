# SOL firewall hardening review — 2026-11-27

**Scope:** Node security package, public exports, shared-contract consumption, legacy decoder, RPC evidence validation, fee and spending policies, signed-byte binding, demo and CI. No changes to teammate modules. This is a defensive review and regression record, not a proof against every possible input.

**Changes:** Recheck the authenticated wallet, intent, network and policy after awaited RPC calls. Bound lifetime with both elapsed monotonic time and the service clock. Limit allocations on the wallet handoff path; reject non-integer signature limits. Tests exercise competing prepare/consume calls, a wallet change during refresh and every truncated prefix of a canonical transfer fixture, alongside existing forged-report, signature, expiry and tamper cases.

**Integration boundary:** Account/network changes must invalidate the frontend session too. Require authentication and a single-use confirmation at the API boundary; never let an HTTP request supply `deps`, raw RPC evidence, acknowledgement state or the original report object. Limit request body size *before* JSON parsing, use a sign-only wallet API, and submit only the signed snapshot checked by the same service. TLS and the RPC operator remain trusted. A fresh simulation cannot guarantee eventual execution.

**Dependencies:** `pnpm audit` initially reported 11 entries. Removing unused SPL tooling eliminated the unpatched `bigint-buffer` high finding; updating Vitest eliminated the test-stack advisories, including two critical `tinypool` entries. Five entries remain:

| Dependency | Severity | Follow-up |
|---|---|---|
| Zod 3, including the shared workspace | High (`GHSA-mrhx-c7xc-m3w5`) | Coordinate migration to patched Zod 4 with shared-contract owners. Bound ingress data before validation. The RPC client limits responses to 128 KiB. Limits are mitigation, not a dependency fix. |
| `jayson` → `uuid` | Moderate (`GHSA-w5hq-g745-h8pq`) | Track the Solana SDK transport dependency. Firewall RPC uses direct fetch, not Jayson's transport. |
| `jayson` → `stream-json` | Three moderate (`GHSA-528h-pc64-c93x`, `GHSA-hqr4-qq8f-hg3x`, `GHSA-mjw6-4jj6-33hc`) | Track upstream. Firewall RPC uses `lossless-json`. Do not force incompatible transitive major versions. |

The high-severity audit gate intentionally remains red until the shared dependency is fixed. No advisory exemptions.

**Validation:** build, TypeScript, lint, 85 deterministic tests and all five isolated live Devnet scenarios passed locally. The demo consumed the exported package and shared JSON serializer. The CodeRabbit file validated against its published v2 schema. Passing examples give evidence for the tested boundaries; they do not certify the application or wallet integrations.

**Repository setup (owner):** Enable Actions under Settings → Actions → General. Install the CodeRabbit GitHub App for this repository at <https://github.com/apps/coderabbitai>, then open a PR into a configured base branch and verify it reviews. Under Settings → Rules → Rulesets, require the `checks` and `secrets` jobs on the integration branch after their first runs. Devnet runs separately on pushes and manual dispatch so network failures are distinguishable. The available repository role can push but is not admin; these settings are not asserted active. Never attach private wallet evidence to PRs or CI artifacts.

## Current dependency status — 2026-11-29

The dependency findings above are a **historical snapshot from 27 November**. The shared-contract migration from Zod 3 to Zod 4 addressed the recorded high-severity Zod finding `GHSA-mrhx-c7xc-m3w5`; current package manifests use Zod 4. The latest verified main CI run, [46151035003](https://github.com/layhadarries/Dev3Proj/actions/runs/46151035003), passed its high-severity audit gate. The PR #15 audit also passed that gate on its evidence head.

This is not a completely clean dependency audit. Four moderate transitive advisories remain through the Solana SDK/Jayson dependency path:

| Advisory | Dependency | Current note |
|---|---|---|
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `uuid` | Transitive through `jayson` / Solana SDK; application reachability has not been established. |
| [GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x) | `stream-json` | Transitive through `jayson`; application reachability requires continued assessment. |
| [GHSA-hqr4-qq8f-hg3x](https://github.com/advisories/GHSA-hqr4-qq8f-hg3x) | `stream-json` | Transitive through `jayson`; JSONC entry-point use by this application has not been established. |
| [GHSA-mjw6-4jj6-33hc](https://github.com/advisories/GHSA-mjw6-4jj6-33hc) | `stream-json` | Transitive through `jayson`; application exploitability has not been established. |

The firewall's read-only RPC uses `lossless-json`, while the web submission/status SDK uses the transitive transport stack. These reachability notes are not exemptions or proof of non-exploitability. The high-severity gate passing is not a clean audit, independent audit certification, or proof of safety.

## Current implementation and evidence boundary — 2026-11-29

The integrated application is no longer at the proposed milestones described in the earlier historical review. It includes server-owned session-bound confirmation, independent legacy SOL decoding and Devnet simulation, post-wallet signed-byte verification, controlled one-shot submission and external transaction analysis. The external analyzer returns an informational report only; it does not authorize a wallet handoff or submission. Current supported scope and residual risks are documented in [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) and [SECURITY_TEST_REPORT.md](SECURITY_TEST_REPORT.md).

Main baseline `3c1bfec622759b7e3eb92253e601fe6645bf198b` passed CI run `46151035003`, including build, typecheck, lint, tests, secret scanning and its Devnet job. PR #15 is a separate, still-unmerged evidence change; its report records 118 security, 99 agent and 170 web tests, [eight read-only Devnet scenarios](https://github.com/layhadarries/Dev3Proj/blob/d88d96e1706f0510aab3265a11c3a7f77e6b43ee/docs/SECURITY_TEST_REPORT.md#final-security-demonstration--2026-11-29) (six on merged `main`), and four synthetic HTTPS tests. It does not claim real wallet-extension or deployed-HTTPS verification. Historical validation counts above remain historical and are not replaced by these later counts.
