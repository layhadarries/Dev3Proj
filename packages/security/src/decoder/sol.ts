import { ComputeBudgetProgram, Message, SystemProgram } from "@solana/web3.js";
import type { DecodedIx, Intent, RuleId } from "@solguard/shared";

export class PolicyError extends Error {
  constructor(readonly rule: RuleId, detail: string, readonly index?: number) {
    super(detail);
  }
}
export function reject(rule: RuleId, detail: string, index?: number): never {
  throw new PolicyError(rule, detail, index);
}

/** Input is the serialized legacy MESSAGE, without the transaction signature vector. */
export function decodeTransaction(bytes: Uint8Array) {
  let message: Message;
  try {
    if (bytes[0] === undefined || bytes.length > 1167 || (bytes[0] & 128)) throw new Error();
    message = Message.from(bytes);
    if (!message.serialize().equals(bytes)) throw new Error();
  } catch {
    return reject("UNDECODABLE_MESSAGE", "Expected a canonical legacy transaction message.");
  }
  const keys = message.accountKeys.map(String);
  const h = message.header;
  if (h.numRequiredSignatures !== 1 || h.numReadonlySignedAccounts !== 0)
    reject("EXTRA_SIGNER", "Exactly one writable payer signature is required.");
  if (new Set(keys).size !== keys.length || h.numReadonlyUnsignedAccounts > keys.length - 1)
    reject("UNDECODABLE_MESSAGE", "Invalid or duplicate account keys.");
  const used = new Set<number>();
  const budget = new Set<number>();
  const decoded: DecodedIx[] = message.compiledInstructions.map((ix, instructionIndex) => {
    const p = ix.programIdIndex;
    const programId = keys[p];
    if (!programId || message.isAccountWritable(p)) return reject("UNKNOWN_PROGRAM", "Invalid program account.", instructionIndex);
    used.add(p);
    const data = Buffer.from(ix.data);
    const base = { programId, instructionIndex };
    if (programId === SystemProgram.programId.toBase58()) {
      const [a,b] = ix.accountKeyIndexes;
      if (data.length !== 12 || data.readUInt32LE() !== 2)
        return reject("UNSUPPORTED_INSTRUCTION", "Only System Transfer is supported.", instructionIndex);
      if (ix.accountKeyIndexes.length !== 2 || a !== 0 || b === undefined || !keys[b] || b === a || !message.isAccountWritable(b))
        return reject("PAYER_MISMATCH", "Expected payer and distinct writable recipient.", instructionIndex);
      used.add(a); used.add(b);
      return { ...base, kind: "system.transfer", from: String(message.accountKeys[a]), to: keys[b], lamports: data.readBigUInt64LE(4) };
    }
    if (programId !== ComputeBudgetProgram.programId.toBase58()) return reject("UNKNOWN_PROGRAM", "Program outside SOL policy.", instructionIndex);
    const tag = data[0];
    if (ix.accountKeyIndexes.length || tag === undefined || budget.has(tag))
      return reject("UNSUPPORTED_INSTRUCTION", "Invalid or duplicate compute budget setting.", instructionIndex);
    budget.add(tag);
    if (tag === 2 && data.length === 5 && data.readUInt32LE(1) > 0 && data.readUInt32LE(1) <= 1_400_000)
      return { ...base, kind: "computeBudget.setUnitLimit", units: data.readUInt32LE(1) };
    if (tag === 3 && data.length === 9)
      return { ...base, kind: "computeBudget.setUnitPrice", microLamports: data.readBigUInt64LE(1) };
    return reject("UNSUPPORTED_INSTRUCTION", "Unsupported compute budget setting.", instructionIndex);
  });
  if (used.size !== keys.length) reject("UNSUPPORTED_INSTRUCTION", "Message includes unused accounts.");
  return { keys, decoded, recentBlockhash: message.recentBlockhash };
}

export function compareTransfer(intent: Intent, decoded: DecodedIx[]) {
  const transfers = decoded.filter(ix => ix.kind === "system.transfer");
  const ix = transfers[0];
  if (intent.asset.type !== "SOL") reject("ASSET_MISMATCH", "Only SOL is supported.");
  if (transfers.length !== 1 || !ix) return reject("EXTRA_TRANSFER", "Expected exactly one SOL transfer.");
  if (ix.from !== intent.payer) reject("PAYER_MISMATCH", "Payer differs from confirmation.", ix.instructionIndex);
  if (ix.to !== intent.recipient) reject("RECIPIENT_MISMATCH", "Recipient differs from confirmation.", ix.instructionIndex);
  if (ix.lamports !== intent.amountBaseUnits) reject("AMOUNT_MISMATCH", "Lamports differ from confirmation.", ix.instructionIndex);
  return ix;
}
