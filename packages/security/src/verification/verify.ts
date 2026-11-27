import {
  IntentSchema,
  IntentWireSchema,
  type Intent,
  type SecurityReport,
} from "@solguard/shared";
import {
  compareTransfer,
  decodeTransaction,
  PolicyError,
  reject,
} from "../decoder/sol.js";
import type { SecurityConfig } from "../config/config.js";
import { hashMessage } from "../integrity/hash.js";
import { createDevnetRpc } from "../rpc/devnet.js";
import type { RpcClient } from "../rpc/types.js";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

export const ENGINE_VERSION = "0.2.0";
export const APPROVAL_TTL_MS = 60_000;
export interface VerifyDeps {
  rpc?: RpcClient;
  now?: () => number;
  config?: Partial<
    Pick<
      SecurityConfig,
      "allowedPrograms" | "maxPriorityFeeLamports" | "maxRequiredSignatures"
    >
  >;
  walletPublicKey: string;
  network: "devnet";
  maxFeeLamports?: bigint;
  maxSpendLamports?: bigint;
}

// Identity-keyed, server-local records; a JSON copy (or a hash alone) is not a capability.
interface Approval {
  report: SecurityReport;
  intent: string;
  hash: string;
  rpc: RpcClient;
  now: () => number;
  phase: "verified" | "waiting" | "handed";
  slot: number;
  policy: string;
  started: number;
}
const approvals = new WeakMap<object, Approval>();
const confirmedSol = IntentSchema.safeExtend({
  asset: z.object({ type: z.literal("SOL") }).strict(),
  amountBaseUnits: z.bigint().positive().max(0xffffffffffffffffn),
  confirmedAt: z.number().int().safe().nonnegative(),
}).strict();
/** Strict untrusted JSON boundary. Reject extra fields rather than silently dropping constraints. */
export function parseConfirmedSolIntent(input: unknown): Intent {
  const wire = IntentWireSchema.safeExtend({asset:confirmedSol.shape.asset}).parse(input);
  return confirmedSol.parse({...wire,amountBaseUnits:BigInt(wire.amountBaseUnits)});
}
function binding(intent: Intent) {
  return JSON.stringify([
    intent.id,
    intent.kind,
    intent.asset.type,
    intent.payer,
    intent.recipient,
    intent.amountBaseUnits.toString(),
    intent.confirmedAt,
  ]);
}
function policyBinding(deps: VerifyDeps) {
  return JSON.stringify([
    String(deps.maxFeeLamports ?? 105000n),
    String(deps.maxSpendLamports ?? 0xffffffffffffffffn),
    String(deps.config?.maxPriorityFeeLamports ?? 100000n),
    deps.config?.maxRequiredSignatures ?? 1,
    deps.config?.allowedPrograms ?? null,
  ]);
}
function checkTime(a: Approval) {
  const elapsed = a.now() - a.report.generatedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= APPROVAL_TTL_MS ||
      performance.now() - a.started >= APPROVAL_TTL_MS)
    reject("TX_EXPIRED", "Verification expired; obtain a new verification.");
}

function blank(
  intent: Intent,
  bytes: Uint8Array,
  time: number,
): SecurityReport {
  return {
    intentId: z.string().uuid().safeParse(intent?.id).success
      ? intent.id
      : "00000000-0000-4000-8000-000000000000",
    messageHash: hashMessage(bytes),
    verdict: "BLOCK",
    findings: [],
    decodedInstructions: [],
    simulation: null,
    feeLamports: null,
    checkedAtSlot: null,
    generatedAt: time,
    engineVersion: ENGINE_VERSION,
  };
}
function blocked(report: SecurityReport, e: unknown): SecurityReport {
  const error =
    e instanceof PolicyError
      ? e
      : e instanceof Error && e.message === "BLOCKHASH_NOT_VALID"
        ? new PolicyError("TX_EXPIRED", "Recent blockhash not valid.")
        : e instanceof Error && e.message === "SIM_FAILED"
          ? new PolicyError("SIM_FAILED", "Devnet simulation failed.")
          : new PolicyError(
              "RPC_UNAVAILABLE",
              "Required Devnet evidence unavailable.",
            );
  return {
    ...report,
    verdict: "BLOCK",
    findings: [
      {
        ruleId: error.rule,
        severity: "BLOCK",
        title: error.rule,
        summary: error.message,
        evidence: { instructionIndex: error.index },
      },
    ],
  };
}

export async function verify(
  input: Intent,
  messageBytes: Uint8Array,
  deps: VerifyDeps,
): Promise<SecurityReport> {
  const bytes =
    messageBytes instanceof Uint8Array && messageBytes.length <= 1167
      ? Buffer.from(messageBytes)
      : Buffer.alloc(0);
  const time = (deps.now ?? Date.now)();
  const started = performance.now();
  const report = blank(input, bytes, time);
  try {
    const message = decodeTransaction(bytes);
    report.decodedInstructions = message.decoded;
    if (input?.asset?.type === "SPL")
      reject("ASSET_MISMATCH", "Only confirmed SOL intents are supported.");
    const parsed = confirmedSol.safeParse(input);
    if (!parsed.success)
      return reject("INTERNAL_ERROR", "Invalid confirmed intent.");
    const intent = parsed.data;
    if (deps.network !== "devnet" || deps.walletPublicKey !== intent.payer)
      reject(
        "PAYER_MISMATCH",
        "Trusted wallet or network does not match confirmation.",
      );
    const ix = compareTransfer(intent, message.decoded);
    const limit = deps.maxFeeLamports ?? 105000n;
    const spend = deps.maxSpendLamports ?? 0xffffffffffffffffn;
    const priority = deps.config?.maxPriorityFeeLamports ?? 100000n;
    const policy = policyBinding(deps);
    const signatures = deps.config?.maxRequiredSignatures ?? 1;
    if (!Number.isSafeInteger(signatures) || signatures < 1)
      reject("EXTRA_SIGNER", "Policy does not permit a signature.");
    if ([limit, spend, priority].some((v) => typeof v !== "bigint" || v < 0n))
      reject("INTERNAL_ERROR", "Invalid trusted policy limits.");
    for (const i of message.decoded)
      if (
        deps.config?.allowedPrograms &&
        !deps.config.allowedPrograms.includes(i.programId)
      )
        reject(
          "UNKNOWN_PROGRAM",
          "Program excluded by configured policy.",
          i.instructionIndex,
        );
    const rpc = deps.rpc ?? createDevnetRpc();
    const encoded = bytes.toString("base64");
    await rpc.identity();
    const fee = await rpc.fee(encoded);
    report.feeLamports = String(fee.value);
    const price =
      message.decoded.find((i) => i.kind === "computeBudget.setUnitPrice")
        ?.microLamports ?? 0n;
    // Without an explicit CU limit, upper-bound the charge by the protocol maximum.
    const units =
      message.decoded.find((i) => i.kind === "computeBudget.setUnitLimit")
        ?.units ?? 1_400_000;
    if (
      fee.value > limit ||
      (price * BigInt(units) + 999999n) / 1000000n > priority
    )
      reject(
        "EXCESSIVE_PRIORITY_FEE",
        "Estimated fee or priority fee bound exceeds policy.",
      );
    if (ix.lamports + fee.value > spend)
      reject("AMOUNT_MISMATCH", "Total debit exceeds spending limit.");
    const sim = await rpc.simulate(encoded, [ix.from, ix.to], fee.context.slot);
    const s = sim.value,
      slot = sim.context.slot;
    if (
      slot < fee.context.slot ||
      s.fee !== fee.value ||
      s.preBalances.length !== message.keys.length ||
      s.postBalances.length !== message.keys.length
    )
      reject("RPC_INCONSISTENT", "Fee, slot or balance vector inconsistent.");
    const deltas = message.keys.map((account, i) => {
      const pre = s.preBalances[i],
        post = s.postBalances[i];
      if (pre === undefined || post === undefined)
        return reject("RPC_INCONSISTENT", "Missing account balance.");
      const lamportsDelta = post - pre;
      const expected =
        account === ix.from
          ? -ix.lamports - fee.value
          : account === ix.to
            ? ix.lamports
            : 0n;
      if (lamportsDelta !== expected)
        reject(
          "UNEXPECTED_BALANCE_CHANGE",
          "Simulated balance change differs from intent.",
        );
      return { account, lamportsDelta };
    });
    if (
      s.accounts[0]?.lamports !== s.postBalances[0] ||
      s.accounts[1]?.lamports !== s.postBalances[message.keys.indexOf(ix.to)]
    )
      reject(
        "RPC_INCONSISTENT",
        "Post-account evidence disagrees with simulated balances.",
      );
    await rpc.fresh(message.recentBlockhash, BigInt(slot));
    report.checkedAtSlot = slot;
    report.simulation = {
      preSlot: slot,
      postSlot: slot,
      deltas,
      unitsConsumed: s.unitsConsumed,
      logsSanitized: s.logs
        .slice(0, 32)
        .map((line) => line.replace(/[^ -~]/g, "").slice(0, 160)),
    };
    if (s.preBalances[message.keys.indexOf(ix.to)] === 0n) {
      report.findings.push({
        ruleId: "RECIPIENT_NEW_ACCOUNT",
        severity: "WARN",
        title: "New recipient account",
        summary:
          "Recipient had zero lamports before simulation. Confirm the destination independently.",
        evidence: { account: ix.to },
      });
      report.verdict = "WARN";
    } else report.verdict = "PASS";
    const approval: Approval = {
      report: structuredClone(report),
      intent: binding(intent),
      hash: message.recentBlockhash,
      rpc,
      now: deps.now ?? Date.now,
      phase: "verified",
      slot,
      policy,
      started,
    };
    checkBinding(approval, input, bytes, deps);
    approvals.set(report, approval);
    return report;
  } catch (e) {
    return blocked(report, e);
  }
}

function checkBinding(
  a: Approval,
  intent: Intent,
  bytes: Buffer,
  deps: VerifyDeps,
) {
  if (
    deps.network !== "devnet" ||
    deps.walletPublicKey !== intent.payer ||
    !confirmedSol.safeParse(intent).success ||
    binding(intent) !== a.intent ||
    hashMessage(bytes) !== a.report.messageHash ||
    policyBinding(deps) !== a.policy
  )
    reject(
      "TX_MODIFIED",
      "Wallet, network, message, policy or confirmed intent changed.",
    );
  checkTime(a);
}
async function refresh(a: Approval, bytes: Buffer) {
  const fee = await a.rpc.fee(bytes.toString("base64"), a.slot);
  if (fee.context.slot < a.slot || String(fee.value) !== a.report.feeLamports)
    reject("RPC_INCONSISTENT", "Fee no longer matches the verified message.");
  const observation = await a.rpc.fresh(a.hash, BigInt(fee.context.slot));
  a.slot = Number(observation.slot);
  checkTime(a);
}

/** Returns a new unsigned wire buffer only once. Errors prohibit requesting wallet approval. */
export async function prepareWalletApproval(
  intent: Intent,
  message: Uint8Array,
  inspected: SecurityReport,
  deps: VerifyDeps,
  acknowledgedWarning = false,
) {
  const a = approvals.get(inspected);
  if (!a || a.phase !== "verified")
    return reject("TX_MODIFIED", "No unused local verification.");
  a.phase = "waiting";
  try {
    if (!(message instanceof Uint8Array) || message.length > 1167)
      reject("TX_MODIFIED", "Invalid message at wallet handoff.");
    const bytes = Buffer.from(message);
    checkBinding(a, intent, bytes, deps);
    if (a.report.verdict === "WARN" && acknowledgedWarning !== true)
      reject(
        "RECIPIENT_NEW_ACCOUNT",
        "Explicit user acknowledgement required.",
      );
    await refresh(a, bytes);
    checkBinding(a, intent, bytes, deps);
    a.phase = "handed";
    return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), bytes]);
  } catch (e) {
    approvals.delete(inspected);
    throw e;
  }
}

export async function verifySigned(
  intent: Intent,
  wire: Uint8Array,
  inspected: { messageHash: string },
  deps: VerifyDeps,
) {
  const a = approvals.get(inspected);
  const snapshot =
    wire instanceof Uint8Array && wire.length <= 1232
      ? Buffer.from(wire)
      : Buffer.alloc(0);
  const bytes = snapshot.subarray(65);
  const report = blank(intent, bytes, (deps.now ?? Date.now)());
  try {
    if (!a || a.phase !== "handed")
      return reject(
        "TX_MODIFIED",
        "No live wallet handoff; report may be forged or consumed.",
      );
    approvals.delete(inspected);
    checkBinding(a, intent, bytes, deps);
    if (
      snapshot[0] !== 1 ||
      !ed25519.verify(
        snapshot.subarray(1, 65),
        bytes,
        new PublicKey(intent.payer).toBytes(),
        { zip215: false },
      )
    )
      reject("TX_MODIFIED", "Required payer signature absent or invalid.");
    await refresh(a, bytes);
    checkBinding(a, intent, bytes, deps);
    return structuredClone(a.report);
  } catch (e) {
    return blocked(report, e);
  }
}

/** Wire-format adapter: require one zero-filled signature slot, without reconstructing the message. */
export function verifyUnsigned(
  intent: Intent,
  wire: Uint8Array,
  deps: VerifyDeps,
) {
  const ok =
    wire instanceof Uint8Array &&
    wire.length > 65 &&
    wire.length <= 1232 &&
    wire[0] === 1 &&
    wire.subarray(1, 65).every((b) => b === 0);
  return verify(intent, ok ? wire.subarray(65) : new Uint8Array(), deps);
}
