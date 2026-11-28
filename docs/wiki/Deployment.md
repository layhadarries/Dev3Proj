# Deployment and operations

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
cd apps/web
pnpm dev
```

Set `APP_ORIGIN=http://localhost:3000` or the exact development origin.

## Production

The app requires HTTPS for `Secure` cookies and HSTS. Set:

```dotenv
APP_ORIGIN=https://solguard.example
SOLGUARD_MAX_SPEND_LAMPORTS=1000000000
```

No deployed URL or production deployment verification is established by this
repository evidence. Treat the values above as configuration guidance, not a
claim of a live service. If deploying for authorized testing, use a trusted
single Node process for the MVP. Session, gateway, challenge,
rate-limit and in-flight state are process-local. Restarting or changing
instances loses pending records.

## Ingress

The application ignores forwarded IP values. Its proxy assumptions must be
documented, but no runtime peer address is currently trusted. Do not enable
header-derived identity without an authenticated ingress boundary.

## Operations

- Keep RPC access available and pinned to Devnet.
- Keep model configuration server-side.
- Monitor 429, 502, 503 and 504 outcomes.
- Do not automatically retry unknown 504 submissions.
- Reconcile uncertain signatures before restart or operator action.
- Never publish private keys or RPC credential URLs.
