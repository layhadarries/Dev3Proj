# Agent package and integration

Contracts: `packages/shared` (decimal strings on the wire, `bigint` in code via `parseIntent` and
`parseReport`). Run `pnpm install && pnpm build` before importing the packages.

## Flow

1. UI calls `parse` with `{ message }` and gets `ready` (with `draft`), `needs_clarification` or `unsupported`.
2. App route: `gateway.stage(session, draft)` returns the confirmation card. Show network, wallet,
   full recipient, amount and expiry.
3. On an explicit, CSRF-protected click: `gateway.confirm(session, id)`.
4. UI calls `build` with `{ confirmationId }` only and gets `{ transaction, report }`. The handler
   reads the gateway-held intent, builds from it and runs `gateway.inspect`. A 409 means start again.
5. UI calls `explain` with the report. A `BLOCK` report has already consumed the confirmation.
   For `WARN`, an explicit, CSRF-protected click calls `gateway.acknowledgeWarning(session, id)`.
6. App route: `gateway.handoff`, sign only in the wallet, then `gateway.submitAndConfirm`. See
   `SECURITY_API.md`. Never pass the builder's bytes to the wallet.

The card expires 60 seconds after `stage`. `confirm` starts a new 60-second window for the rest.

## Next.js route

```ts
// lib/gateway.ts: one instance per server process. Keep it on globalThis, because `next dev`
// can evaluate the module again while compiling a route, which loses pending confirmations.
const shared = globalThis as typeof globalThis & { solguardGateway?: ReturnType<typeof createConfirmationGateway> };
export const gateway = (shared.solguardGateway ??= createConfirmationGateway());

// app/api/build/route.ts
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
  confirmations: (request) => {
    const session = () => sessionFor(request); // yours: server-side state, never the request body
    return {
      intent: (id) => gateway.intent(session, id),
      inspect: (id, built) => gateway.inspect(session, id, built),
    };
  },
}).build;
```

Export one handler per route file (`.parse`, `.build`, `.explain`). The app's `tsconfig.json` needs
`"moduleResolution": "bundler"`; without it the package types are not found. Routes sharing the
gateway must run in the same Node process. Tested with Next.js 15.5.29 in `next dev` and
`next start`, from `stage` to `handoff`, with a fixed test session (no real authentication or CSRF).

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
