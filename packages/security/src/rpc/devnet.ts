const endpoint = "https://api.devnet.solana.com";
const genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

type Environment = Readonly<Record<string, string | undefined>>;

async function readRpc(env: Environment, method: "getGenesisHash" | "getBalance", params: unknown[]) {
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
const balance = z.object({ context: z.object({ slot: u64 }), value: u64 });

export async function getWalletBalance(address: string, env: Environment = process.env) {
  if (!Base58PubkeySchema.safeParse(address).success) throw new Error("INVALID_PUBLIC_KEY");
  await checkDevnetIdentity(env);
  const result = balance.safeParse(await readRpc(env, "getBalance", [address, { commitment: "confirmed" }]));
  if (!result.success) throw new Error("DEVNET_RPC_UNAVAILABLE");
  return { network: "devnet", address, commitment: "confirmed",
    lamports: result.data.value, slot: result.data.context.slot } as const;
}
import { parse } from "lossless-json";
import { z } from "zod";
import { Base58PubkeySchema } from "@solguard/shared";
