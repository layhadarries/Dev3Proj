# Devnet identity probe

From the repository root, run `pnpm build`, then:

```sh
node --input-type=module -e 'import {checkDevnetIdentity} from "./packages/security/dist/index.js"; console.log(await checkDevnetIdentity())'
```

`SOLANA_NETWORK` defaults to `devnet`; `SOLANA_RPC_URL` defaults to `https://api.devnet.solana.com`. Only those exact values are accepted. The probe rejects redirects and stops after eight seconds. A success identifies the cluster reported by the TLS endpoint, not its freshness or any transaction outcome. Errors expose stable codes rather than response bodies. No wallet is required.
