// Manual live check, nothing is signed or sent: stage and confirm through the gateway, then run
// the build handler against Devnet and explain the report.
import { Keypair } from "@solana/web3.js";
import { createConfirmationGateway, getRecentBlockhash } from "@solguard/security";
import { parseReport } from "@solguard/shared";
import { agentHandlers, explainReport, parseTransfer } from "../src/index.js";

// Pass any funded Devnet address as the payer; verification does not need its key.
const payer = process.argv[2];
if (!payer) throw new Error("Usage: devnet.ts <funded devnet address>");
const gateway = createConfirmationGateway();
const session = () => ({ sessionId: "live-check", walletPublicKey: payer, network: "devnet" as const });
const handlers = agentHandlers({
  rpc: {
    async getLatestBlockhash() {
      const recent = await getRecentBlockhash();
      return { blockhash: recent.blockhash, lastValidBlockHeight: Number(recent.lastValidBlockHeight) };
    },
  },
  confirmations: () => ({
    intent: (id) => gateway.intent(session, id),
    inspect: (id, built) => gateway.inspect(session, id, built),
  }),
});
const parsed = await parseTransfer(`send 0.001 SOL to ${Keypair.generate().publicKey.toBase58()}`);
if (parsed.status !== "ready") throw new Error(parsed.status);
const { id } = gateway.stage(session, parsed.draft);
gateway.confirm(session, id);
const response = await handlers.build(
  new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmationId: id }) }),
);
const body = await response.json();
if (!response.ok) throw new Error(`build failed with ${response.status}`);
const report = parseReport(body.report);
console.log({ verdict: report.verdict, rules: report.findings.map((f) => f.ruleId), explanation: explainReport(body.report).headline });
if (report.verdict !== "BLOCK") {
  const wire = await gateway.handoff(session, id, report.verdict === "WARN");
  console.log({ handoffBytes: wire.length, matchesBuilt: wire.subarray(65).toString("base64") === body.transaction.messageBase64 });
} else process.exitCode = 1;
