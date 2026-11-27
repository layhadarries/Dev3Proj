# Devnet identity probe

From the repository root, run `pnpm build`, then:

```sh
node --input-type=module -e 'import {checkDevnetIdentity} from "./packages/security/dist/index.js"; console.log(await checkDevnetIdentity())'
```

`SOLANA_NETWORK` defaults to `devnet`; `SOLANA_RPC_URL` defaults to `https://api.devnet.solana.com`. Only those exact values are accepted. The probe rejects redirects and stops after eight seconds. A success identifies the cluster reported by the TLS endpoint, not its freshness or any transaction outcome. Errors expose stable codes rather than response bodies. No wallet is required.
## Balance reads

`await getWalletBalance(base58Address)` checks cluster identity, then calls Devnet `getBalance` at `confirmed` commitment. Returns `{network, address, commitment, lamports, slot}`. Both `lamports` and `slot` are bigint; convert each to a decimal string for JSON. Raw RPC integers are parsed before JavaScript can round them. Invalid evidence throws; zero from the RPC is valid but does not prove an account exists.

Live read using the public System Program address (`11111111111111111111111111111111`): **1 lamport at slot 526821945**. This is an observation, not a fixture or expected future balance.
