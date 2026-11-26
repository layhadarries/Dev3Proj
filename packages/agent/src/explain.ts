import { SecurityReportSchema, type Finding, type RuleId, type SecurityReport, type Verdict } from "@solguard/shared";
import type { z } from "zod";
import { lamportsToSol } from "./amount";

const TEXT: Record<RuleId, string> = {
  AMOUNT_MISMATCH: "The amount differs from the one you confirmed.",
  RECIPIENT_MISMATCH: "The recipient differs from the one you confirmed.",
  PAYER_MISMATCH: "The transaction spends from, or is paid by, an unexpected account.",
  ASSET_MISMATCH: "The asset differs from the one you confirmed.",
  EXTRA_TRANSFER: "The transaction contains a transfer you did not ask for.",
  UNEXPECTED_BALANCE_CHANGE: "An unrelated account's balance would change.",
  UNAUTHORIZED_APPROVAL: "The transaction lets another account spend your tokens.",
  AUTHORITY_CHANGE: "The transaction changes who controls an account.",
  ACCOUNT_CLOSE: "The transaction closes or drains an account.",
  UNKNOWN_PROGRAM: "The transaction calls a program that is not allowed.",
  UNSUPPORTED_INSTRUCTION: "The transaction contains an instruction that is not permitted.",
  UNDECODABLE_MESSAGE: "The transaction could not be read.",
  LOOKUP_TABLE_UNRESOLVED: "Some accounts in the transaction could not be identified.",
  EXTRA_SIGNER: "The transaction asks for more signers than allowed.",
  DURABLE_NONCE_USED: "The transaction is built so it would not expire normally.",
  EXCESSIVE_PRIORITY_FEE: "The priority fee is above the allowed limit.",
  SIM_FAILED: "The test run of this transaction failed.",
  RPC_UNAVAILABLE: "The Solana network could not be reached, so verification did not finish.",
  RPC_INCONSISTENT: "The network gave conflicting answers, so verification did not finish.",
  TX_EXPIRED: "The transaction has expired and must be rebuilt.",
  TX_MODIFIED: "The transaction changed after it was checked.",
  INTERNAL_ERROR: "The security check hit an error and did not finish.",
  TOKEN_FREEZE_AUTH: "This token's issuer can freeze token accounts.",
  TOKEN_PERMANENT_DELEGATE: "This token has a delegate that can move or burn holders' tokens.",
  TOKEN_TRANSFER_FEE: "This token charges a fee on transfers.",
  TOKEN_OTHER_EXTENSION: "This token has an extra feature that may affect transfers.",
  RECIPIENT_NEW_ACCOUNT: "The recipient account has not been used before. Check the address.",
};

const HEADLINE: Record<Verdict, string> = {
  PASS: "The checks passed. Review the transaction in your wallet before signing. Passing checks does not guarantee safety or the final result.",
  WARN: "Review the warnings before deciding whether to sign. A warning does not prove anything is malicious.",
  BLOCK: "Blocked: this transaction should not be signed.",
};

export interface Explanation {
  verdict: Verdict;
  headline: string;
  points: (Finding & { text: string })[];
  /** Net simulated balance change per account, in SOL. */
  balanceChanges: { account: string; changeSol: string }[];
  feeSol: string | null;
}

/**
 * Deterministic wording derived only from the report, so nothing can be invented or softened.
 * Takes the wire form. An invalid report throws; callers must treat that as blocked.
 */
export function explainReport(input: z.input<typeof SecurityReportSchema>): Explanation {
  const report: SecurityReport = SecurityReportSchema.parse(input);
  const signed = (n: bigint) => `${n < 0n ? "-" : "+"}${lamportsToSol(n < 0n ? -n : n)}`;
  return {
    verdict: report.verdict,
    headline: HEADLINE[report.verdict],
    points: [...report.findings]
      .sort((a, b) => Number(b.severity === "BLOCK") - Number(a.severity === "BLOCK"))
      .map((f) => ({ ...f, text: TEXT[f.ruleId] })),
    balanceChanges: (report.simulation?.balanceChanges ?? []).map((c) => ({
      account: c.account,
      changeSol: signed(c.postLamports - c.preLamports),
    })),
    feeSol: report.feeLamports === null ? null : lamportsToSol(report.feeLamports),
  };
}
