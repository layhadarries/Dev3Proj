import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { z } from "zod";
import { BuiltTransactionSchema, IntentSchema, type BuiltTransaction, type Intent } from "@solguard/shared";

/** A web3.js `Connection` satisfies this, so the RPC layer stays outside the agent. */
export interface BlockhashProvider {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}

/** Turns a confirmed draft into an Intent. Call only after an explicit user confirmation. */
export function confirmIntent(
  draft: { recipient: string; amountBaseUnits: string },
  payer: string,
  now = new Date(),
): Intent {
  return IntentSchema.parse({
    id: globalThis.crypto.randomUUID(),
    kind: "TRANSFER",
    asset: { type: "SOL" },
    recipient: draft.recipient,
    amountBaseUnits: draft.amountBaseUnits,
    payer,
    confirmedAt: now.toISOString(),
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Buffer.from(digest).toString("hex");
}

/** Builds exactly one System Program transfer. Never signs. */
export async function buildTransfer(input: Intent, rpc: BlockhashProvider): Promise<BuiltTransaction> {
  // Re-validate by round-tripping through the wire form.
  const intent = IntentSchema.parse(z.encode(IntentSchema, input));
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
