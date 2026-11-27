# Testing

## Test layers

- Vitest unit and adversarial tests
- Deterministic injected RPC fixtures
- Mocked LLM response tests
- Mocked wallet and submission tests
- Next.js route tests
- Read-only live Devnet test script
- Optional live browser scenarios
- V8 statement/branch/function/line coverage

## Commands

```bash
pnpm test
pnpm --filter @solguard/security exec vitest run --coverage
pnpm --filter @solguard/agent exec vitest run --coverage
pnpm --filter @solguard/web exec vitest run --coverage
pnpm lint
pnpm typecheck
pnpm build
pnpm audit --audit-level high
```

Live read-only Devnet:

```bash
node --test packages/security/tests/integration/devnet.mjs
```

Coverage is evidence of exercised code, not security assurance.
