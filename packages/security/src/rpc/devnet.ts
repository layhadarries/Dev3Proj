const endpoint = "https://api.devnet.solana.com";
const genesisHash = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

type Environment = Readonly<Record<string, string | undefined>>;

/** Read-only connectivity and cluster identity probe; does not authorize signing. */
export async function checkDevnetIdentity(env: Environment = process.env) {
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
    });
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (body?.jsonrpc !== "2.0" || body.id !== 1 || "error" in body ||
        typeof body.result !== "string") throw new Error();
    if (body.result === genesisHash) return { network: "devnet", genesisHash } as const;
  } catch {
    throw new Error("DEVNET_RPC_UNAVAILABLE");
  }
  throw new Error("DEVNET_IDENTITY_MISMATCH");
}
