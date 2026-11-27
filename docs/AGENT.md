# Agent package and integration

Contracts: `packages/shared` (decimal strings on the wire, `bigint` in code via `parseIntent` and
`parseReport`). Run `pnpm install && pnpm build` before importing the packages.

## Flow

1. UI calls `parse` with `{ message }` and gets `ready` (with `draft`), `needs_clarification` or `unsupported`.
2. UI shows the full recipient and amount from the draft. The user confirms.
3. UI calls `build` with `{ draft, payer, confirmed: true }` and gets `{ intent, transaction }`.
4. Same server process: `verify(parseConfirmedSolIntent(intent), messageBytes, deps)`.
5. UI calls `explain` with the report in wire form (`serializeReport(report)`).
6. Wallet handoff and signed check: follow `SECURITY_API.md` (`prepareWalletApproval`, sign only,
   then `verifySigned`). Never pass the builder's bytes straight to the wallet.

## Next.js route

```ts
import { agentHandlers, llmFromEnv } from "@solguard/agent";
import { getRecentBlockhash } from "@solguard/security";

export const POST = agentHandlers({
  rpc: {
    async getLatestBlockhash() {
      const recent = await getRecentBlockhash(); // checks the cluster is Devnet
      return { blockhash: recent.blockhash, lastValidBlockHeight: Number(recent.lastValidBlockHeight) };
    },
  },
  llm: llmFromEnv(process.env),
}).parse;
```

Export one handler per route file (`.parse`, `.build`, `.explain`). Tested on 27 November with
Next.js 15.5.29 (`next build` and `next start`) against live Devnet and the local model. The app's
`tsconfig.json` needs `"moduleResolution": "bundler"`; without it the package types are not found.

## Proposed changes to `packages/shared`

Agreed by Taz on 27 November, not yet applied; the agent enforces the first three itself for now.
Zod also needs upgrading to 4.6.6 or later (high-severity advisory; CI audits at that level).

- Add `BuiltTransaction` (see `packages/agent/src/builder.ts`).
- Bound intent amounts to u64 and reject `payer === recipient`.
- Reject reports whose verdict or severities contradict the findings, or that pass without a simulation.
- Open point: `build` creates the intent from the client's `confirmed: true`. Per
  `SECURITY_ARCHITECTURE.md`, the signing gate still needs a trusted, single-use confirmation record
  (Taz owns this).

## Running the model

`./scripts/local-llm.sh` serves Qwen3 4B (open-weight, Apache-2.0) on `127.0.0.1:8089` with llama.cpp
(Linux x86_64, about 2.5 GB on first run, no API key). Set the `LLM_*` values from `.env.example`.

On a Ryzen 7 8845HS (CPU only), looser phrasing took about 9-11 s; simple commands are instant.
A hosted deployment cannot reach a model on your laptop: demo locally, or point `LLM_*` at a hosted
OpenAI-compatible API.

Live check, with the `LLM_*` variables exported: `pnpm --filter @solguard/agent exec tsx tests/llm-live.ts`.

## What the model can do

It gets the user's message and no tools. Its answer is accepted only if the recipient and amount
are exactly what the user typed. It cannot sign, submit, build or change a verdict.
Simple commands never reach it. Explanations are fixed text per rule ID, not model output.

## Notes for integration

- `explain` words a report; it does not authenticate it. Gate signing on the engine's own output.
- `verifySigned` rejects a message the wallet changed, including added priority-fee instructions.
- A transfer that leaves a new account below the rent-exempt minimum fails simulation.
