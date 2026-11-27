import { IntentSchema, type Intent, type SecurityReport } from "@solguard/shared";
import { compareTransfer, decodeTransaction, PolicyError, reject } from "../decoder/sol.js";
import type { SecurityConfig } from "../config/config.js";
import { hashMessage } from "../integrity/hash.js";
import { createDevnetRpc } from "../rpc/devnet.js";
import type { RpcClient } from "../rpc/types.js";

export const ENGINE_VERSION = "0.2.0";
export interface VerifyDeps {
  rpc?: RpcClient;
  now?: () => number;
  config?: Partial<SecurityConfig>;
  walletPublicKey: string;
  network: "devnet";
  maxFeeLamports?: bigint;
  maxSpendLamports?: bigint;
}

function blank(intent: Intent, bytes: Uint8Array, time: number): SecurityReport {
  return { intentId: intent?.id ?? "00000000-0000-0000-0000-000000000000", messageHash: hashMessage(bytes),
    verdict:"BLOCK", findings:[], decodedInstructions:[], simulation:null, feeLamports:null, checkedAtSlot:null,
    generatedAt:time, engineVersion:ENGINE_VERSION };
}
function blocked(report: SecurityReport, e: unknown): SecurityReport {
  const error = e instanceof PolicyError ? e : e instanceof Error && e.message === "BLOCKHASH_NOT_VALID"
    ? new PolicyError("TX_EXPIRED","Recent blockhash not valid.") : e instanceof Error && e.message === "SIM_FAILED"
    ? new PolicyError("SIM_FAILED","Devnet simulation failed.") : new PolicyError("RPC_UNAVAILABLE","Required Devnet evidence unavailable.");
  return {...report, verdict:"BLOCK", findings:[{ruleId:error.rule,severity:"BLOCK",title:error.rule,
    summary:error.message,evidence:{instructionIndex:error.index}}]};
}

export async function verify(input: Intent, messageBytes: Uint8Array, deps: VerifyDeps): Promise<SecurityReport> {
  const bytes = Buffer.from(messageBytes);
  const time = (deps.now ?? Date.now)();
  const report = blank(input,bytes,time);
  try {
    const message = decodeTransaction(bytes);
    report.decodedInstructions = message.decoded;
    const parsed = IntentSchema.strict().safeParse(input);
    if (!parsed.success) return reject("INTERNAL_ERROR","Invalid confirmed intent.");
    const intent = parsed.data;
    if (deps.network !== "devnet" || deps.walletPublicKey !== intent.payer)
      reject("PAYER_MISMATCH","Trusted wallet or network does not match confirmation.");
    const ix = compareTransfer(intent,message.decoded);
    const limit = deps.maxFeeLamports ?? 105000n;
    const spend = deps.maxSpendLamports ?? 0xffffffffffffffffn;
    const priority = deps.config?.maxPriorityFeeLamports ?? 100000n;
    if ([limit,spend,priority].some(v => typeof v !== "bigint" || v < 0n))
      reject("INTERNAL_ERROR","Invalid trusted policy limits.");
    for (const i of message.decoded)
      if (deps.config?.allowedPrograms && !deps.config.allowedPrograms.includes(i.programId))
        reject("UNKNOWN_PROGRAM","Program excluded by configured policy.",i.instructionIndex);
    const rpc = deps.rpc ?? createDevnetRpc();
    const encoded = bytes.toString("base64");
    await rpc.identity();
    const fee = await rpc.fee(encoded);
    report.feeLamports = String(fee.value);
    if (fee.value > limit || fee.value > 5000n + priority) reject("EXCESSIVE_PRIORITY_FEE","Estimated fee exceeds policy.");
    if (ix.lamports + fee.value > spend) reject("AMOUNT_MISMATCH","Total debit exceeds spending limit.");
    const sim = await rpc.simulate(encoded,[ix.from,ix.to],fee.context.slot);
    const s = sim.value, slot = sim.context.slot;
    if (slot < fee.context.slot || s.fee !== fee.value ||
        s.preBalances.length !== message.keys.length || s.postBalances.length !== message.keys.length)
      reject("RPC_INCONSISTENT","Fee, slot or balance vector inconsistent.");
    const deltas = message.keys.map((account,i) => {
      const pre = s.preBalances[i], post = s.postBalances[i];
      if (pre === undefined || post === undefined) return reject("RPC_INCONSISTENT","Missing account balance.");
      const lamportsDelta = post - pre;
      const expected = account === ix.from ? -ix.lamports-fee.value : account === ix.to ? ix.lamports : 0n;
      if (lamportsDelta !== expected) reject("UNEXPECTED_BALANCE_CHANGE","Simulated balance change differs from intent.");
      return {account,lamportsDelta};
    });
    if (s.accounts[0]?.lamports !== s.postBalances[0] || s.accounts[1]?.lamports !== s.postBalances[message.keys.indexOf(ix.to)])
      reject("RPC_INCONSISTENT","Post-account evidence disagrees with simulated balances.");
    await rpc.fresh(message.recentBlockhash,BigInt(slot));
    report.checkedAtSlot = slot;
    report.simulation = {preSlot:slot,postSlot:slot,deltas,unitsConsumed:s.unitsConsumed,
      logsSanitized:s.logs.slice(0,32).map(line=>line.replace(/[^ -~]/g,"").slice(0,160))};
    if (s.preBalances[message.keys.indexOf(ix.to)] === 0n) {
      report.findings.push({ruleId:"RECIPIENT_NEW_ACCOUNT",severity:"WARN",title:"New recipient account",
        summary:"Recipient had zero lamports before simulation. Confirm the destination independently.",evidence:{account:ix.to}});
      report.verdict = "WARN";
    } else report.verdict = "PASS";
    return report;
  } catch(e) { return blocked(report,e); }
}

export async function verifySigned(intent: Intent, bytes: Uint8Array, _inspected: {messageHash:string}, deps: VerifyDeps) {
  return blocked(blank(intent,bytes,(deps.now ?? Date.now)()),new PolicyError("INTERNAL_ERROR","No signing handoff available."));
}
