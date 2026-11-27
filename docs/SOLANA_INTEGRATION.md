# Devnet identity probe

From the repository root, run `pnpm build`, then:

```sh
node --input-type=module -e 'import {checkDevnetIdentity} from "./packages/security/dist/index.js"; console.log(await checkDevnetIdentity())'
```

`SOLANA_NETWORK` defaults to `devnet`; `SOLANA_RPC_URL` defaults to `https://api.devnet.solana.com`. Only those exact values are accepted. The probe rejects redirects and stops after eight seconds. A success identifies the cluster reported by the TLS endpoint, not its freshness or any transaction outcome. Errors expose stable codes rather than response bodies. No wallet is required.
## Balance reads

`await getWalletBalance(base58Address)` checks cluster identity, then calls Devnet `getBalance` at `confirmed` commitment. Returns `{network, address, commitment, lamports, slot}`. Both `lamports` and `slot` are bigint; convert each to a decimal string for JSON. Raw RPC integers are parsed before JavaScript can round them. Invalid evidence throws; zero from the RPC is valid but does not prove an account exists.

Live read using the public System Program address (`11111111111111111111111111111111`): **1 lamport at slot 526821945**. This is an observation, not a fixture or expected future balance.

## Account inspection

`await inspectAccount(base58Address)` returns `{network, address, commitment, slot, account}`. Only an explicit RPC `null` means the account was absent at that slot; incomplete metadata throws instead. For existing accounts, `account.owner` is the owning **program**, not a wallet authority. `account.executable` is a boolean; `account.lamports`, `account.space` (bytes) and `slot` are bigint. The read requests no account data bytes and cannot establish token authorities or transaction safety.

Live Devnet observation at confirmed slot **526823420**: the System Program was executable, owned by `NativeLoader1111111111111111111111111111111`, with 1 lamport and 14 bytes of space.

## Recent blockhash and approval-time freshness

`getRecentBlockhash()` returns the confirmed `blockhash`, observation `slot` and `lastValidBlockHeight`. Block heights and slots are distinct counters; do not compare them. Immediately before wallet approval, call `requireValidBlockhash(message.recentBlockhash, verificationSlot)` with the hash from the exact verified message. Stop on any exception. An invalid hash requires building and verifying a fresh proposal; never swap it into an approved message. A successful check establishes freshness at the returned slot only, not transaction safety. The wallet handoff is not yet implemented.

Live check: `9fvjF8qqcQiNuaKcym3mUVCbLbfucY2fm1vNM19m1ebq` was retrieved at slot `526824217` and reported valid at slot `526824221`. This is historical evidence, not a reusable blockhash.
