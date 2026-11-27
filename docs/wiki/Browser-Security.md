# Browser security

## Implemented headers

- Nonce-based `Content-Security-Policy`
- `script-src 'nonce-...' 'strict-dynamic'`
- Restricted `style-src`, `img-src`, `font-src`, `connect-src` and `frame-src`
- `object-src 'none'`
- `base-uri 'none'`
- `frame-ancestors 'none'`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- Restrictive `Permissions-Policy`
- HSTS only for production HTTPS responses

Development allows `unsafe-eval` for Next.js tooling and an exact-origin HMR
WebSocket allowance. Production does not add this allowance.

## Cookies

Pre-auth and session cookies use `HttpOnly` and `SameSite=Strict`. Production
uses `Secure` and `__Host-` cookie names.

## Wallet compatibility

Wallet extensions are browser-side integrations. Real-browser compatibility
and extension CSP interactions require separate verification for MetaMask,
Phantom or Solflare.
