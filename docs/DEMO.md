# Demo guide

Devnet only. Use test funds and a test wallet.

## Setup

```bash
pnpm install && pnpm build
./scripts/local-llm.sh        # optional, for loose phrasing; leave running (Linux, 2.5 GB first run)
cd apps/web
LLM_BASE_URL=http://127.0.0.1:8089/v1 LLM_API_KEY=local LLM_MODEL=qwen3-4b pnpm dev
```

Open the `http://localhost:<port>` address it prints. `127.0.0.1` is rejected at sign-in.
Without the model, leave out the three `LLM_*` variables and use `send <amount> SOL to <address>`.

The wallet (MetaMask, Phantom or Solflare) needs Devnet SOL from <https://faucet.solana.com>.

## Part 1: the app

Type the request, **Continue**, check the card, **These details are correct**, review, sign.
There are 60 seconds to confirm a card and 60 seconds from confirming to signing.

| Show | Type or do | Expected |
|---|---|---|
| Normal transfer | Send 0.01 SOL to a funded address | `PASS`, sign, Explorer link |
| Warning | Send 0.01 SOL to a never-used address | `WARN`, tick the box, sign |
| Spending limit | Send 1 SOL (the fee pushes it over 1 SOL) | `BLOCK`, no sign button |
| Hedged wording | `maybe later I could send 1 SOL to <address>` | Asks to rephrase |
| Out of scope | `swap 1 SOL to USDC` | Unsupported |
| User refuses | Reject in the wallet | Error, nothing sent |

New recipients need at least about 0.001 SOL, or the simulation fails.

## Part 2: attacks

These run the real security engine against live Devnet. They sign and send nothing.
The attacker's transaction is built by this test script, not by the app.

```bash
node packages/security/scripts/demo.mjs match      # PASS
node packages/security/scripts/demo.mjs extra      # BLOCK EXTRA_TRANSFER
node packages/security/scripts/demo.mjs recipient  # BLOCK RECIPIENT_MISMATCH
node packages/security/scripts/demo.mjs amount     # BLOCK AMOUNT_MISMATCH
node packages/security/scripts/demo.mjs tamper     # BLOCK TX_MODIFIED
```

The output is JSON; point at `verdict` and `findings`.

## What to say, and what not to claim

- The model only reads the request. It gets no tools or keys, and its answer must match what was typed.
- Deterministic code builds and checks the transaction. Only the wallet owner signs.
- A pass means the checks passed at that simulation; it is not a safety guarantee.
- Not covered: tokens (SPL), versioned transactions, Mainnet, and transfers made outside SolGuard.

## Fallbacks

- Public Devnet RPC slow or rate-limited: run Part 2 later, or show a recorded run.
- Model slow (about 7-25 s on a laptop CPU): use the `send ... to ...` form, which is instant.
- Restarting the app signs everyone out; reload and connect again.
