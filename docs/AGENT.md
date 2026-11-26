# Agent package and integration

Contracts: `packages/shared/src/index.ts`. Amounts are `bigint` in code, decimal strings in JSON.

## Flow

1. UI calls `parse` with `{ message }` and gets `ready` (with `draft`), `needs_clarification` or `unsupported`.
2. UI shows the full recipient and amount from the draft. The user confirms.
3. UI calls `build` with `{ draft, payer, confirmed: true }` and gets `{ intent, transaction }`.
4. Security: `verify(IntentSchema.parse(intent), messageBytes, deps)`.
5. UI calls `explain` with the report in wire form (`z.encode(SecurityReportSchema, report)`).
6. Wallet: `new VersionedTransaction(VersionedMessage.deserialize(messageBytes))`.

## Next.js route

```ts
import { agentHandlers, llmFromEnv } from "@solguard/agent";
import { Connection } from "@solana/web3.js";

export const POST = agentHandlers({
  rpc: new Connection(process.env.SOLANA_RPC_URL!),
  llm: llmFromEnv(process.env),
}).parse;
```

Add `transpilePackages: ["@solguard/agent", "@solguard/shared"]` to `next.config`.

## What the model can do

It gets the user's message and no tools. Its answer is accepted only if the recipient and amount
are exactly what the user typed. It cannot sign, submit, build or change a verdict.
Simple commands never reach it. Explanations are fixed text per rule ID, not model output.

## Notes for integration

- `explain` words a report; it does not authenticate it. Gate signing on the engine's own output.
- Wallets may add priority-fee instructions when signing; `verifySigned` should account for this.
- A transfer that leaves a new account below the rent-exempt minimum fails simulation.
