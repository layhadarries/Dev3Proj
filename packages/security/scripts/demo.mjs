// Read-only public Devnet observations. No key loading, signing or submission.
import { randomUUID } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { serializeReport } from "@solguard/shared";
import {
  getRecentBlockhash,
  prepareWalletApproval,
  parseConfirmedSolIntent,
  verifyUnsigned,
  verifySigned,
} from "@solguard/security";

const [
  scenario = "match",
  from = "964koDACp6GNSW8uL2J49CTa7kuFSQWPErgKMKK1E9QH",
  to = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
] = process.argv.slice(2);
if (!["match", "extra", "amount", "recipient", "tamper", "unsupported"].includes(scenario))
  throw Error("Unknown scenario");
const payer = new PublicKey(from),
  recipient = new PublicKey(to);
const intent = parseConfirmedSolIntent({
  id: randomUUID(),
  confirmedAt: Date.now(),
  kind: "transfer",
  asset: { type: "SOL" },
  payer: from,
  recipient: to,
  amountBaseUnits: "500000000",
});
const { blockhash } = await getRecentBlockhash();
const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
const transfer = SystemProgram.transfer({
  fromPubkey: payer,
  toPubkey: scenario === "recipient" ? PublicKey.unique() : recipient,
  lamports: intent.amountBaseUnits + (scenario === "amount" ? 1n : 0n),
});
tx.add(transfer);
if (scenario === "extra") tx.add(transfer);
// Controlled, unsigned fixture: a non-transfer System instruction is outside the SOL policy.
if (scenario === "unsupported") tx.add(SystemProgram.allocate({ accountPubkey: payer, space: 0 }));
const deps = { walletPublicKey: from, network: "devnet" };
const message = tx.serializeMessage();
const unsigned = tx.serialize({requireAllSignatures:false, verifySignatures:false});
let report = await verifyUnsigned(intent, unsigned, deps);
if (["match", "tamper"].includes(scenario) && report.verdict === "PASS") {
  const wire = await prepareWalletApproval(intent, message, report, deps);
  if (scenario === "tamper") {
    wire[wire.length - 1] ^= 1;
    report = await verifySigned(intent, wire, report, deps);
  }
}
console.log(
  JSON.stringify(
    { blockhash, report: serializeReport(report) },
    null,
    2,
  ),
);
const expected = {
  extra: "EXTRA_TRANSFER",
  amount: "AMOUNT_MISMATCH",
  recipient: "RECIPIENT_MISMATCH",
  tamper: "TX_MODIFIED",
  unsupported: "UNSUPPORTED_INSTRUCTION",
};
if (
  scenario === "match"
    ? report.verdict !== "PASS"
    : report.verdict !== "BLOCK" ||
      report.findings[0]?.ruleId !== expected[scenario] ||
      (scenario === "unsupported" &&
        (report.findings[0]?.evidence?.instructionIndex !== 1 || report.simulation !== null))
)
  process.exitCode = 1;
