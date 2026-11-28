import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { Explanation } from "@solguard/agent";
import type { SecurityReportWire } from "@solguard/shared";
import type { Api } from "./api";
import { lamportsToSol, solToLamports } from "./format";

/** What the user says they meant to send. The payer is always the signed-in wallet. */
export interface Intended {
  recipient: string;
  amountBaseUnits: string;
}

export interface Analysis {
  intended: Intended;
  report: SecurityReportWire;
  explanation: Explanation;
}

/** Asks the server to check a transaction built elsewhere. Nothing is signed or sent. */
export async function analyze(
  api: Api,
  input: { recipient: string; amountSol: string; transaction: string },
): Promise<Analysis> {
  const lamports = solToLamports(input.amountSol.trim());
  if (lamports === null) throw new Error("Enter the amount in SOL, for example 0.5.");
  const intended = { recipient: input.recipient.trim(), amountBaseUnits: lamports.toString() };
  const { report } = await api<{ report: SecurityReportWire }>("analyze", {
    ...intended,
    // Copied base64 often arrives wrapped over several lines.
    transactionBase64: input.transaction.replace(/\s+/g, ""),
  });
  const explanation = await api<Explanation>("explain", report);
  if (explanation.verdict !== report.verdict) throw new Error("The explanation does not match the security report.");
  return { intended, report, explanation };
}

export interface InstructionLine {
  number: number;
  text: string;
  /** Differs from what the user meant, or is the instruction the report objects to. */
  flagged: boolean;
}

/** Plain wording for each decoded instruction, taken only from the report. */
export function describeInstructions({ intended, report }: Pick<Analysis, "intended" | "report">): InstructionLine[] {
  const objected = new Set(report.findings.map((finding) => finding.evidence.instructionIndex));
  let matched = false;
  return report.decodedInstructions.map((ix) => {
    let text: string;
    let flagged = objected.has(ix.instructionIndex);
    if (ix.kind === "system.transfer") {
      text = `Sends ${lamportsToSol(ix.lamports)} SOL to ${ix.to}`;
      // Only one transfer can be the one asked for; a repeat of it is extra.
      const wanted = !matched && ix.to === intended.recipient && ix.lamports === intended.amountBaseUnits;
      matched ||= wanted;
      flagged ||= !wanted;
    } else if (ix.kind === "computeBudget.setUnitLimit") {
      text = `Sets the compute limit to ${ix.units} units`;
    } else if (ix.kind === "computeBudget.setUnitPrice") {
      text = `Sets the priority fee to ${ix.microLamports} microlamports per unit`;
    } else {
      text = `Calls program ${ix.programId}`;
      flagged = true;
    }
    return { number: ix.instructionIndex + 1, text, flagged };
  });
}

export type Example = "extra" | "recipient";

/**
 * A made-up malicious transaction for trying the analyzer. It carries a random blockhash and an
 * empty signature, so the network would not accept it.
 */
export function exampleAttack(kind: Example, payer: string, amountSol = "0.01"): {
  recipient: string;
  amountSol: string;
  transaction: string;
} {
  const lamports = solToLamports(amountSol)!;
  const recipient = Keypair.generate().publicKey.toBase58();
  const attacker = Keypair.generate().publicKey.toBase58();
  const from = new PublicKey(payer);
  const transfer = (to: string, amount: bigint) =>
    SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(to), lamports: amount });
  const transaction = new Transaction({ feePayer: from, recentBlockhash: Keypair.generate().publicKey.toBase58() });
  if (kind === "extra") transaction.add(transfer(recipient, lamports), transfer(attacker, lamports * 50n));
  else transaction.add(transfer(attacker, lamports));
  const wire = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  return { recipient, amountSol, transaction: btoa(String.fromCharCode(...wire)) };
}
