# Configuration

Only server-side environment values affect security policy.

| Variable | Required | Default | Format | Behavior |
|---|---:|---|---|---|
| `APP_ORIGIN` | Production: yes | Request origin in development | Exact canonical origin, no path/trailing slash | Required for exact Origin validation and HSTS-origin context |
| `SOLGUARD_MAX_SPEND_LAMPORTS` | No | `1000000000` | Canonical decimal u64 | Total transfer debit including fees; invalid values fail startup |
| `SOLANA_NETWORK` | No for app | `devnet` | `devnet` | Network identity; the implementation is Devnet-pinned |
| `SOLANA_RPC_URL` | No | `https://api.devnet.solana.com` | HTTPS RPC URL | Some standalone/integration code may expect this endpoint |
| `LLM_BASE_URL` | Optional | unset | OpenAI-compatible chat completion base | No model means parser-only behavior for supported forms |
| `LLM_API_KEY` | Optional | unset | Server secret | Sent only to the configured model endpoint |
| `LLM_MODEL` | Optional | unset | Model identifier | Required together with base URL and key |

Use `.env.example` as a template. Never commit an API key or private key.

## Examples

```dotenv
APP_ORIGIN=https://solguard.example
SOLGUARD_MAX_SPEND_LAMPORTS=1000000000
LLM_BASE_URL=http://127.0.0.1:8089/v1
LLM_API_KEY=local-placeholder
LLM_MODEL=qwen3-4b
```

The spending limit is not a client override. A request body or AI response
cannot change it.
