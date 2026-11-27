import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { BuiltTransactionSchema, IntentSchema, type BuiltTransaction, type Intent } from "@solguard/shared";

/** Anything that returns a recent Devnet blockhash. A web3.js `Connection` satisfies this. */
export interface BlockhashProvider {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Buffer.from(digest).toString("hex");
}

/**
 * Some wallets add their own priority-fee instructions to a transaction that has none, which changes
 * the checked bytes. Setting both here avoids that. A transfer needs about 450 units, and these
 * values cost 1 lamport on top of the base fee.
 */
export const COMPUTE_UNIT_LIMIT = 1_000;
export const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 1_000;

/** Builds exactly one System Program transfer. Never signs. The result is a proposal to verify. */
export async function buildTransfer(input: Intent, rpc: BlockhashProvider): Promise<BuiltTransaction> {
  const intent = IntentSchema.parse(input);
  if (intent.asset.type !== "SOL") throw new Error("Only SOL transfers are supported");
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const payer = new PublicKey(intent.payer);
  const message = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight })
    .add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE_MICRO_LAMPORTS }),
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey(intent.recipient),
        lamports: intent.amountBaseUnits,
      }),
    )
    .serializeMessage();
  return BuiltTransactionSchema.parse({
    intentId: intent.id,
    messageBase64: message.toString("base64"),
    messageHash: await sha256Hex(message),
    recentBlockhash: blockhash,
    lastValidBlockHeight,
  });
}
