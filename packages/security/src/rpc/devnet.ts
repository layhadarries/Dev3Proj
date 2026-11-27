import { parse } from "lossless-json";
import { z } from "zod";
import { Base58PubkeySchema } from "@solguard/shared";

const endpoint = "https://api.devnet.solana.com";
const genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

type Environment = Readonly<Record<string, string | undefined>>;

type ReadMethod = "getGenesisHash" | "getBalance" | "getAccountInfo" | "getLatestBlockhash" | "isBlockhashValid" | "getFeeForMessage" | "simulateTransaction";

async function readRpc(env: Environment, method: ReadMethod, params: unknown[]) {
  if ((env.SOLANA_NETWORK ?? "devnet") !== "devnet" ||
      (env.SOLANA_RPC_URL ?? endpoint) !== endpoint) {
    throw new Error("DEVNET_CONFIG_INVALID");
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error();
    const body = z.object({
      id: z.literal(1n), jsonrpc: z.literal("2.0"), result: z.unknown(), error: z.never().optional(),
    }).parse(parse(await response.text(), null, BigInt));
    return body.result;
  } catch {
    throw new Error("DEVNET_RPC_UNAVAILABLE");
  }
}

/** Read-only connectivity and cluster identity probe; does not authorize signing. */
export async function checkDevnetIdentity(env: Environment = process.env) {
  const result = await readRpc(env, "getGenesisHash", []);
  if (typeof result !== "string") throw new Error("DEVNET_RPC_UNAVAILABLE");
  if (result !== genesisHash) throw new Error("DEVNET_IDENTITY_MISMATCH");
  return { network: "devnet", genesisHash } as const;
}

const u64 = z.bigint().nonnegative().max(0xffffffffffffffffn);
const safeSlot = u64.max(BigInt(Number.MAX_SAFE_INTEGER)).transform(Number);
const observed = z.object({ slot: safeSlot });
const simulationValue = z.object({
  err: z.null(), fee: u64, preBalances: z.array(u64), postBalances: z.array(u64),
  innerInstructions: z.array(z.never()), preTokenBalances: z.array(z.never()), postTokenBalances: z.array(z.never()),
  replacementBlockhash: z.null(), logs: z.array(z.string()).min(1), unitsConsumed: safeSlot,
  accounts: z.array(z.object({owner: z.literal("11111111111111111111111111111111"), executable: z.literal(false),
    lamports: u64, data: z.tuple([z.literal(""),z.literal("base64")])})).length(2),
});

export function createDevnetRpc(env: Environment = process.env) {
  return {
    identity: () => checkDevnetIdentity(env),
    fresh: (hash: string, slot: bigint) => requireValidBlockhash(hash, slot, env),
    async fee(message: string) {
      return z.object({context: observed, value: u64}).parse(await readRpc(env, "getFeeForMessage",
        [message, {commitment: "confirmed"}]));
    },
    async simulate(message: string, addresses: string[], minContextSlot: number) {
      const wire = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(message,"base64")]);
      const result = await readRpc(env,"simulateTransaction",[wire.toString("base64"), {
        encoding:"base64", commitment:"confirmed", minContextSlot, sigVerify:false, replaceRecentBlockhash:false,
        innerInstructions:true, accounts:{encoding:"base64",addresses},
      }]);
      const failure = z.object({value:z.object({err:z.union([z.string(),z.record(z.unknown())])})}).safeParse(result);
      if (failure.success) throw new Error("SIM_FAILED");
      return z.object({context:observed,value:simulationValue}).parse(result);
    },
  };
}
const context = z.object({ slot: u64 });
const latestBlockhash = z.object({
  context, value: z.object({ blockhash: Base58PubkeySchema, lastValidBlockHeight: u64 }),
});

export async function getRecentBlockhash(env: Environment = process.env) {
  await checkDevnetIdentity(env);
  const result = latestBlockhash.safeParse(await readRpc(env, "getLatestBlockhash", [{ commitment: "confirmed" }]));
  if (!result.success) throw new Error("DEVNET_RPC_UNAVAILABLE");
  return { network: "devnet", commitment: "confirmed", slot: result.data.context.slot, ...result.data.value } as const;
}

/** Throws unless the exact hash is currently valid at or after the verification slot. */
export async function requireValidBlockhash(blockhash: string, minSlot: bigint, env: Environment = process.env) {
  if (!Base58PubkeySchema.safeParse(blockhash).success) throw new Error("INVALID_BLOCKHASH");
  if (typeof minSlot !== "bigint" || minSlot < 0n || minSlot > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("INVALID_MIN_SLOT");
  }
  await checkDevnetIdentity(env);
  const result = z.object({ context, value: z.boolean() }).safeParse(await readRpc(env, "isBlockhashValid", [
    blockhash, { commitment: "confirmed", minContextSlot: Number(minSlot) },
  ]));
  if (!result.success || result.data.context.slot < minSlot) throw new Error("DEVNET_RPC_UNAVAILABLE");
  if (!result.data.value) throw new Error("BLOCKHASH_NOT_VALID");
  return { network: "devnet", commitment: "confirmed", blockhash, slot: result.data.context.slot } as const;
}

const balance = z.object({ context: z.object({ slot: u64 }), value: u64 });

export async function getWalletBalance(address: string, env: Environment = process.env) {
  if (!Base58PubkeySchema.safeParse(address).success) throw new Error("INVALID_PUBLIC_KEY");
  await checkDevnetIdentity(env);
  const result = balance.safeParse(await readRpc(env, "getBalance", [address, { commitment: "confirmed" }]));
  if (!result.success) throw new Error("DEVNET_RPC_UNAVAILABLE");
  return { network: "devnet", address, commitment: "confirmed",
    lamports: result.data.value, slot: result.data.context.slot } as const;
}
const accountMetadata = z.object({
  owner: Base58PubkeySchema, executable: z.boolean(), lamports: u64, space: u64,
});
const accountObservation = z.object({
  context: z.object({ slot: u64 }), value: accountMetadata.nullable(),
});

export async function inspectAccount(address: string, env: Environment = process.env) {
  if (!Base58PubkeySchema.safeParse(address).success) throw new Error("INVALID_PUBLIC_KEY");
  await checkDevnetIdentity(env);
  const result = accountObservation.safeParse(await readRpc(env, "getAccountInfo", [
    address, { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } },
  ]));
  if (!result.success) throw new Error("DEVNET_RPC_UNAVAILABLE");
  return { network: "devnet", address, commitment: "confirmed",
    slot: result.data.context.slot, account: result.data.value } as const;
}
