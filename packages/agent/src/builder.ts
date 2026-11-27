import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { BuiltTransactionSchema, IntentSchema, type BuiltTransaction, type Intent } from "@solguard/shared";

/** Anything that returns a recent Devnet blockhash. A web3.js `Connection` satisfies this. */
export interface BlockhashProvider {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Buffer.from(digest).toString("hex");
}

/** Builds exactly one System Program transfer. Never signs. The result is a proposal to verify. */
export async function buildTransfer(input: Intent, rpc: BlockhashProvider): Promise<BuiltTransaction> {
  const intent = IntentSchema.parse(input);
  if (intent.asset.type !== "SOL") throw new Error("Only SOL transfers are supported");
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const payer = new PublicKey(intent.payer);
  const message = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight })
    .add(
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
