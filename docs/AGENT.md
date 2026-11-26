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

## Running the model

`./scripts/local-llm.sh` serves Qwen3 4B (open-weight, Apache-2.0) on `127.0.0.1:8089` with llama.cpp
(Linux x86_64, about 2.5 GB on first run, no API key). Set the `LLM_*` values from `.env.example`.

On a Ryzen 7 8845HS (CPU only), looser phrasing took about 9-11 s; simple commands are instant.
A hosted deployment cannot reach a model on your laptop: demo locally, or point `LLM_*` at a hosted
OpenAI-compatible API.

Live check: `npx tsx packages/agent/tests/llm-live.ts` with the `LLM_*` variables exported.

## What the model can do

It gets the user's message and no tools. Its answer is accepted only if the recipient and amount
are exactly what the user typed. It cannot sign, submit, build or change a verdict.
Simple commands never reach it. Explanations are fixed text per rule ID, not model output.

## Notes for integration

- `explain` words a report; it does not authenticate it. Gate signing on the engine's own output.
- Wallets may add priority-fee instructions when signing; `verifySigned` should account for this.
- A transfer that leaves a new account below the rent-exempt minimum fails simulation.
