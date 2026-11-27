// Standalone read-only integration run. stdout is the evidence artifact.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import console from "node:console";
import process from "node:process";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  getRecentBlockhash,
  getWalletBalance,
  inspectAccount,
  prepareWalletApproval,
  verify,
  verifySigned,
} from "../dist/index.js";

const newDemo = process.argv[2] === "--new-demo-wallet";
const payer = newDemo
  ? Keypair.generate().publicKey
  : new PublicKey(process.argv[2] ?? process.env.SOLGUARD_TEST_PAYER);
const amount = 10_000_000n;
const endpoint = "https://api.devnet.solana.com";
const allowed = new Set([
  "getBalance",
  "getGenesisHash",
  "getAccountInfo",
  "getLatestBlockhash",
  "getFeeForMessage",
  "simulateTransaction",
  "isBlockhashValid",
]);
const rpc = [],
  scenarios = [];
const evidence = {
  started: new Date().toISOString(),
  endpoint,
  payer: String(payer),
  amount,
  rpc,
  scenarios,
};
let phase = "balance";
const fetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const { method, params } = JSON.parse(opts.body);
  assert.ok(
    url === endpoint && allowed.has(method),
    "Read-only Devnet RPC required",
  );
  const res = await fetch(url, opts);
  rpc.push({
    phase,
    method,
    params,
    status: res.status,
    responseText: await res.clone().text(),
  });
  return res;
};
function publicAddressOnly() {
  for (;;) {
    const bytes = randomBytes(32);
    if (PublicKey.isOnCurve(bytes)) return new PublicKey(bytes);
  }
}
try {
  evidence.before = await getWalletBalance(String(payer));
  if (newDemo) assert.equal(evidence.before.lamports, 0n);
  else assert.ok(evidence.before.lamports > amount, "Balance insufficient for transfer plus fee");
  phase = "recipient";
  const recipient = publicAddressOnly();
  evidence.recipient = String(recipient);
  evidence.recipientBefore = await inspectAccount(String(recipient));
  assert.equal(evidence.recipientBefore.account, null);
  const deps = { network: "devnet", walletPublicKey: String(payer) };
  const rules = {
    match: newDemo ? "SIM_FAILED" : "RECIPIENT_NEW_ACCOUNT",
    extra: "EXTRA_TRANSFER",
    recipient: "RECIPIENT_MISMATCH",
    amount: "AMOUNT_MISMATCH",
  };
  if (!newDemo) rules.tamper = "TX_MODIFIED";
  for (const [name, rule] of Object.entries(rules)) {
    phase = name;
    const intent = {
      id: randomUUID(),
      kind: "transfer",
      asset: { type: "SOL" },
      confirmedAt: Date.now(),
      payer: String(payer),
      recipient: String(recipient),
      amountBaseUnits: amount,
    };
    const { blockhash } = await getRecentBlockhash();
    const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
    const transfer = (to, lamports) =>
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports });
    tx.add(
      transfer(
        name === "recipient" ? publicAddressOnly() : recipient,
        name === "amount" ? amount + 1n : amount,
      ),
    );
    if (name === "extra") tx.add(transfer(publicAddressOnly(), 1n));
    const message = tx.serializeMessage();
    const report = await verify(intent, message, deps);
    const entry = {
      name,
      intent,
      messageBase64: message.toString("base64"),
      report,
    };
    scenarios.push(entry);
    if (name === "tamper") {
      assert.equal(report.verdict, "WARN");
      assert.equal(report.findings[0]?.ruleId, "RECIPIENT_NEW_ACCOUNT");
      // Test-only acknowledgement exercises the handoff. No actual wallet is connected or invoked.
      const wire = await prepareWalletApproval(
        intent,
        message,
        report,
        deps,
        true,
      );
      wire[wire.length - 1] ^= 1;
      entry.testOnlyWarningAcknowledgement = true;
      entry.modifiedUnsignedWireBase64 = wire.toString("base64");
      entry.afterMutation = await verifySigned(intent, wire, report, deps);
      assert.equal(entry.afterMutation.verdict, "BLOCK");
      assert.equal(entry.afterMutation.findings[0]?.ruleId, rule);
    } else {
      assert.equal(report.verdict, name === "match" && !newDemo ? "WARN" : "BLOCK");
      assert.equal(report.findings[0]?.ruleId, rule);
      if (name === "match" && !newDemo) {
        assert.equal(
          report.simulation.deltas.find((d) => d.account === String(recipient))
            .lamportsDelta,
          amount,
        );
        assert.equal(
          report.simulation.deltas.find((d) => d.account === String(payer))
            .lamportsDelta,
          -amount - BigInt(report.feeLamports),
        );
      }
    }
  }
  phase = "after";
  evidence.after = await getWalletBalance(String(payer));
  evidence.recipientAfter = await inspectAccount(String(recipient));
  evidence.completed = true;
} catch (error) {
  evidence.failure = error.message;
  process.exitCode = 1;
} finally {
  globalThis.fetch = fetch;
  console.log(
    JSON.stringify(
      evidence,
      (_, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ),
  );
}
