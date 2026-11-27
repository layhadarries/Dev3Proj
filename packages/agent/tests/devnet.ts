// Manual live check, nothing is signed or sent: build with the security package's blockhash,
// then verify on Devnet and explain the report.
import { Keypair } from "@solana/web3.js";
import { getRecentBlockhash, verify } from "@solguard/security";
import { serializeReport } from "@solguard/shared";
import { buildTransfer, confirmIntent, explainReport, parseTransfer } from "../src/index.js";

// Pass any funded Devnet address as the payer; verification does not need its key.
const payer = process.argv[2];
if (!payer) throw new Error("Usage: devnet.ts <funded devnet address>");
const parsed = await parseTransfer(`send 0.001 SOL to ${Keypair.generate().publicKey.toBase58()}`);
if (parsed.status !== "ready") throw new Error(parsed.status);
const intent = confirmIntent(parsed.draft, payer);
const built = await buildTransfer(intent, {
  async getLatestBlockhash() {
    const recent = await getRecentBlockhash();
    return { blockhash: recent.blockhash, lastValidBlockHeight: Number(recent.lastValidBlockHeight) };
  },
});
const message = Buffer.from(built.messageBase64, "base64");
const report = await verify(intent, message, { network: "devnet", walletPublicKey: payer });
const explanation = explainReport(serializeReport(report));
console.log({ verdict: report.verdict, rules: report.findings.map((f) => f.ruleId), hashMatches: report.messageHash === built.messageHash, headline: explanation.headline, feeSol: explanation.feeSol, balanceChanges: explanation.balanceChanges });
if (report.verdict === "BLOCK") process.exitCode = 1;
