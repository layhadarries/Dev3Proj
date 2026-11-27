import { parseReport, type Finding, type RuleId, type Severity, type Verdict } from "@solguard/shared";
import { lamportsToSol } from "./amount.js";

/** Each rule's expected severity and wording. The compiler requires every shared rule to be listed. */
const RULES: Record<RuleId, readonly [Severity, string]> = {
  AMOUNT_MISMATCH: ["BLOCK", "The amount differs from the one you confirmed, or the total with fees is above your spending limit."],
  RECIPIENT_MISMATCH: ["BLOCK", "The recipient differs from the one you confirmed."],
  PAYER_MISMATCH: ["BLOCK", "The transaction spends from, or is paid by, an unexpected account."],
  ASSET_MISMATCH: ["BLOCK", "The asset differs from the one you confirmed."],
  EXTRA_TRANSFER: ["BLOCK", "The transaction contains a transfer you did not ask for."],
  UNEXPECTED_BALANCE_CHANGE: ["BLOCK", "An unrelated account's balance would change."],
  UNAUTHORIZED_APPROVAL: ["BLOCK", "The transaction lets another account spend your tokens."],
  AUTHORITY_CHANGE: ["BLOCK", "The transaction changes who controls an account."],
  ACCOUNT_CLOSE: ["BLOCK", "The transaction closes or drains an account."],
  UNKNOWN_PROGRAM: ["BLOCK", "The transaction calls a program that is not allowed."],
  UNSUPPORTED_INSTRUCTION: ["BLOCK", "The transaction contains an instruction that is not permitted."],
  UNDECODABLE_MESSAGE: ["BLOCK", "The transaction could not be read."],
  LOOKUP_TABLE_UNRESOLVED: ["BLOCK", "Some accounts in the transaction could not be identified."],
  EXTRA_SIGNER: ["BLOCK", "The transaction asks for more signers than allowed."],
  DURABLE_NONCE_USED: ["BLOCK", "The transaction is built so it would not expire normally."],
  EXCESSIVE_PRIORITY_FEE: ["BLOCK", "The network fee or priority fee is above the allowed limit."],
  SIM_FAILED: ["BLOCK", "The test run of this transaction failed."],
  RPC_UNAVAILABLE: ["BLOCK", "The Solana network could not be reached, so verification did not finish."],
  RPC_INCONSISTENT: ["BLOCK", "The network gave conflicting answers, so verification did not finish."],
  TX_EXPIRED: ["BLOCK", "The transaction has expired and must be rebuilt."],
  TX_MODIFIED: ["BLOCK", "The transaction changed after it was checked."],
  INTERNAL_ERROR: ["BLOCK", "The security check hit an error and did not finish."],
  TOKEN_FREEZE_AUTH: ["WARN", "This token's issuer can freeze token accounts."],
  TOKEN_PERMANENT_DELEGATE: ["WARN", "This token has a delegate that can move or burn holders' tokens."],
  TOKEN_TRANSFER_FEE: ["WARN", "This token charges a fee on transfers."],
  TOKEN_OTHER_EXTENSION: ["WARN", "This token has an extra feature that may affect transfers."],
  RECIPIENT_NEW_ACCOUNT: ["WARN", "The recipient account has not been used before. Check the address."],
  ACCOUNT_CREATED: ["INFO", "This transaction creates a new account."],
  FEE_BREAKDOWN: ["INFO", "Network fee details."],
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

const RANK: Record<Severity, number> = { INFO: 0, WARN: 1, BLOCK: 2 };

/**
 * Deterministic wording derived only from the report, so nothing can be invented or softened.
 * Takes the wire form. An invalid or self-contradicting report throws; treat that as blocked.
 */
export function explainReport(input: unknown): Explanation {
  const report = parseReport(input);
  // The shared schema ties the verdict to the findings, but not a severity to its rule.
  if (report.findings.some((f) => RANK[f.severity] < RANK[RULES[f.ruleId][0]])) {
    throw new Error("Finding severity is weaker than its rule");
  }
  const signed = (n: bigint) => `${n < 0n ? "-" : "+"}${lamportsToSol(n < 0n ? -n : n)}`;
  return {
    verdict: report.verdict,
    headline: HEADLINE[report.verdict],
    points: [...report.findings]
      .sort((a, b) => RANK[b.severity] - RANK[a.severity])
      .map((f) => ({ ...f, text: RULES[f.ruleId][1] })),
    balanceChanges: (report.simulation?.deltas ?? []).map((d) => ({
      account: d.account,
      changeSol: signed(d.lamportsDelta),
    })),
    feeSol: report.feeLamports === null ? null : lamportsToSol(report.feeLamports),
  };
}
