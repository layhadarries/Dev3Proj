// Manual live check, nothing is signed or sent: build with the security package's blockhash,
// simulate on Devnet, then run the security engine on the result.
import { Connection, Keypair, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { getRecentBlockhash, verify } from "@solguard/security";
import { buildTransfer, confirmIntent, parseTransfer } from "../src/index.js";

// Pass any funded Devnet address as the payer; simulation does not need its key.
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
const rpc = new Connection("https://api.devnet.solana.com", "confirmed");
const { value } = await rpc.simulateTransaction(new VersionedTransaction(VersionedMessage.deserialize(message)), { sigVerify: false });
const report = await verify(intent, message, { rpc: {} });
console.log({ simulationError: value.err, verdict: report.verdict, rules: report.findings.map((f) => f.ruleId), hashMatches: report.messageHash === built.messageHash });
