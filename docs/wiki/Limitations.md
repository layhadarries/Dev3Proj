# Known limitations and roadmap

## Current limitations

- Single legacy Solana System transfer only
- No SPL/Token-2022 support
- No Anchor vault
- No Mainnet support or on-chain enforcement
- Process-local sessions, gateway, challenges and rate limits
- Public RPC trust and availability assumptions
- 10-second broadcast deadline and 30-second confirmation polling
- HTTP broadcast cancellation not exposed by the installed Solana library
- No production or real-wallet-extension completion guarantee
- Prompt-injection resistance cannot be guaranteed impossible
- No distributed DDoS protection
- Four moderate dependency advisories remain in the latest audit threshold

## Future ideas

Future work may include:

- Shared session/rate-limit storage or sticky deployment
- Trusted ingress/client-IP integration
- SPL and Token-2022 instruction support
- Additional transaction formats
- Persistent audit evidence
- Broader wallet-adapter verification
- Load testing and provider-specific failover
- Mainnet only after explicit threat/model and policy review
