import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { IntentSchema, type Intent } from "@solguard/shared";
import { z } from "zod";
import { U64_MAX } from "./amount.js";

/** Anything that returns a recent Devnet blockhash. A web3.js `Connection` satisfies this. */
export interface BlockhashProvider {
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}

/**
 * An unsigned transaction message. Nothing in it is trusted until the security engine checks it.
 * Proposed for `@solguard/shared`; defined here until the team agrees.
 */
export const BuiltTransactionSchema = z
  .object({
    intentId: z.string().uuid(),
    /** Serialized legacy message, base64. This is exactly what gets signed. */
    messageBase64: z.string().min(1).base64(),
    /** SHA-256 of the message bytes, lowercase hex. */
    messageHash: z.string().regex(/^[0-9a-f]{64}$/),
    recentBlockhash: z.string().min(32).max(44),
    lastValidBlockHeight: z.number().int().positive(),
  })
  .strict();
export type BuiltTransaction = z.infer<typeof BuiltTransactionSchema>;

/** The shared schema plus limits it does not enforce yet. */
function checkIntent(input: unknown): Intent {
  const intent = IntentSchema.strict().parse(input);
  if (intent.amountBaseUnits > U64_MAX) throw new Error("Amount exceeds u64");
  if (intent.payer === intent.recipient) throw new Error("Payer and recipient must differ");
  return intent;
}

/** Turns a confirmed draft into an Intent. Call only after an explicit user confirmation. */
export function confirmIntent(
  draft: { recipient: string; amountBaseUnits: string },
  payer: string,
  now = Date.now(),
): Intent {
  if (!/^[1-9]\d{0,19}$/.test(draft.amountBaseUnits)) throw new Error("Amount must be a positive integer string");
  return checkIntent({
    id: globalThis.crypto.randomUUID(),
    kind: "transfer",
    asset: { type: "SOL" },
    recipient: draft.recipient,
    amountBaseUnits: BigInt(draft.amountBaseUnits),
    payer,
    confirmedAt: now,
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Buffer.from(digest).toString("hex");
}

/** Builds exactly one System Program transfer. Never signs. */
export async function buildTransfer(input: Intent, rpc: BlockhashProvider): Promise<BuiltTransaction> {
  const intent = checkIntent(input);
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
