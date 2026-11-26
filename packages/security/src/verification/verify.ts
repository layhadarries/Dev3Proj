import type { Finding, Intent, SecurityReport } from "@solguard/shared";
import type { SecurityConfig } from "../config/config.js";
import { hashMessage } from "../integrity/hash.js";
import { aggregateVerdict } from "../policies/verdict.js";
import type { RpcClient } from "../rpc/types.js";

export const ENGINE_VERSION = "0.1.0";

export interface VerifyDeps {
  rpc: RpcClient;
  now?: () => number;
  config?: Partial<SecurityConfig>;
}

function buildInternalErrorReport(
  intentId: string,
  messageHash: string,
  now: () => number,
  reason: string
): SecurityReport {
  const findings: Finding[] = [
    {
      ruleId: "INTERNAL_ERROR",
      severity: "BLOCK",
      title: "Verification engine internal error",
      summary: `Verification could not be completed (${reason}). Blocking transaction by default.`,
      evidence: {
        expected: "completed verification",
        actual: reason,
      },
    },
  ];

  return {
    intentId,
    messageHash,
    verdict: aggregateVerdict(findings),
    findings,
    decodedInstructions: [],
    simulation: null,
    feeLamports: null,
    checkedAtSlot: null,
    generatedAt: now(),
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * Stage 0 stub: fails closed with INTERNAL_ERROR ("not implemented").
 */
export async function verify(
  intent: Intent,
  messageBytes: Uint8Array,
  deps: VerifyDeps
): Promise<SecurityReport> {
  const now = deps.now ?? Date.now;
  try {
    const messageHash = hashMessage(messageBytes);
    return buildInternalErrorReport(intent.id, messageHash, now, "not implemented");
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return buildInternalErrorReport(
      intent?.id ?? "00000000-0000-0000-0000-000000000000",
      hashMessage(new Uint8Array()),
      now,
      reason
    );
  }
}

/**
 * Stage 0 stub: fails closed with INTERNAL_ERROR ("not implemented").
 */
export async function verifySigned(
  intent: Intent,
  signedTxBytes: Uint8Array,
  _inspected: { messageHash: string },
  deps: VerifyDeps
): Promise<SecurityReport> {
  const now = deps.now ?? Date.now;
  try {
    const messageHash = hashMessage(signedTxBytes);
    return buildInternalErrorReport(intent.id, messageHash, now, "not implemented");
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return buildInternalErrorReport(
      intent?.id ?? "00000000-0000-0000-0000-000000000000",
      hashMessage(new Uint8Array()),
      now,
      reason
    );
  }
}
