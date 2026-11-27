// TEMP: pending team agreement
import { z } from "zod";
import { isValidBase58Pubkey } from "./base58.js";

export const Base58PubkeySchema = z
  .string()
  .refine(isValidBase58Pubkey, { message: "Invalid base58 32-byte Solana public key" });

export const POSITIVE_INT_STRING_REGEX = /^[1-9][0-9]*$/;
export const U64_MAX = (1n << 64n) - 1n;
const fitsU64 = (v: string) => v.length < 20 || (v.length === 20 && v <= U64_MAX.toString());
export const NON_NEGATIVE_INT_STRING_REGEX = /^(0|[1-9][0-9]*)$/;
export const SIGNED_INT_STRING_REGEX = /^-?(0|[1-9][0-9]*)$/;

export const PositiveBigIntWireSchema = z
  .string()
  .regex(POSITIVE_INT_STRING_REGEX, {
    message: "Expected positive integer decimal string (> 0)",
  }).refine(fitsU64, "Amount exceeds u64");

export const NonNegativeBigIntWireSchema = z
  .string()
  .regex(NON_NEGATIVE_INT_STRING_REGEX, {
    message: "Expected non-negative integer decimal string",
  }).refine(fitsU64, "Amount exceeds u64");

export const SignedBigIntWireSchema = z
  .string()
  .regex(SIGNED_INT_STRING_REGEX, {
    message: "Expected signed integer decimal string",
  })
  .refine((val) => val !== "-0", { message: "Negative zero is not allowed" });

export const RULE_IDS = [
  // BLOCK
  "AMOUNT_MISMATCH",
  "RECIPIENT_MISMATCH",
  "PAYER_MISMATCH",
  "ASSET_MISMATCH",
  "EXTRA_TRANSFER",
  "UNEXPECTED_BALANCE_CHANGE",
  "UNAUTHORIZED_APPROVAL",
  "AUTHORITY_CHANGE",
  "ACCOUNT_CLOSE",
  "UNKNOWN_PROGRAM",
  "UNSUPPORTED_INSTRUCTION",
  "UNDECODABLE_MESSAGE",
  "LOOKUP_TABLE_UNRESOLVED",
  "EXTRA_SIGNER",
  "DURABLE_NONCE_USED",
  "EXCESSIVE_PRIORITY_FEE",
  "SIM_FAILED",
  "RPC_UNAVAILABLE",
  "RPC_INCONSISTENT",
  "TX_EXPIRED",
  "TX_MODIFIED",
  "INTERNAL_ERROR",
  // WARN
  "TOKEN_FREEZE_AUTH",
  "TOKEN_PERMANENT_DELEGATE",
  "TOKEN_TRANSFER_FEE",
  "TOKEN_OTHER_EXTENSION",
  "RECIPIENT_NEW_ACCOUNT",
  // INFO
  "ACCOUNT_CREATED",
  "FEE_BREAKDOWN",
] as const;

export const RuleIdSchema = z.enum(RULE_IDS);
export type RuleId = z.infer<typeof RuleIdSchema>;

export const SeveritySchema = z.enum(["BLOCK", "WARN", "INFO"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const VerdictSchema = z.enum(["PASS", "WARN", "BLOCK"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const AssetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SOL") }),
  z.object({ type: z.literal("SPL"), mint: Base58PubkeySchema }),
]);
export type Asset = z.infer<typeof AssetSchema>;

const IntentBaseFields = {
  id: z.string().uuid(),
  kind: z.literal("transfer"),
  asset: AssetSchema,
  recipient: Base58PubkeySchema,
  payer: Base58PubkeySchema,
  confirmedAt: z.number().int().nonnegative(),
};

export const IntentSchema = z.object({
  ...IntentBaseFields,
  amountBaseUnits: z.bigint().positive().max(U64_MAX, "Amount exceeds u64"),
}).strict().refine(v=>v.payer !== v.recipient,"Payer and recipient must differ");
export type Intent = z.infer<typeof IntentSchema>;

export const IntentWireSchema = z.object({
  ...IntentBaseFields,
  amountBaseUnits: PositiveBigIntWireSchema,
}).strict().refine(v=>v.payer !== v.recipient,"Payer and recipient must differ");
export type IntentWire = z.infer<typeof IntentWireSchema>;

/** Agent proposal, not authority. Verify decoded bytes and independently estimated effects. */
export const BuiltTransactionSchema = z.object({
  intentId:z.string().uuid(), messageBase64:z.string().min(4).max(1556).base64(),
  messageHash:z.string().regex(/^[0-9a-f]{64}$/), recentBlockhash:Base58PubkeySchema,
  lastValidBlockHeight:z.number().int().positive(),
}).strict();
export type BuiltTransaction = z.infer<typeof BuiltTransactionSchema>;

export const EvidenceSchema = z.object({
  instructionIndex: z.number().int().nonnegative().optional(),
  account: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  extra: z.record(z.string(), z.string()).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingSchema = z.object({
  ruleId: RuleIdSchema,
  severity: SeveritySchema,
  title: z.string(),
  summary: z.string(),
  evidence: EvidenceSchema,
});
export type Finding = z.infer<typeof FindingSchema>;

// DecodedIx schemas (minimal Stage 0 contract; extended in Stage 2 & Stage 10)
export const DecodedIxSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("system.transfer"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    from: Base58PubkeySchema,
    to: Base58PubkeySchema,
    lamports: z.bigint().nonnegative(),
  }),
  z.object({
    kind: z.literal("system.other"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    instructionType: z.string(),
    raw: z.string(),
  }),
  z.object({
    kind: z.literal("computeBudget.setUnitLimit"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    units: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("computeBudget.setUnitPrice"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    microLamports: z.bigint().nonnegative(),
  }),
  z.object({
    kind: z.literal("computeBudget.other"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    instructionType: z.string(),
  }),
  z.object({
    kind: z.literal("unknown"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    dataHex: z.string(),
    accounts: z.array(z.string()),
  }),
]);
export type DecodedIx = z.infer<typeof DecodedIxSchema>;

export const DecodedIxWireSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("system.transfer"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    from: Base58PubkeySchema,
    to: Base58PubkeySchema,
    lamports: NonNegativeBigIntWireSchema,
  }),
  z.object({
    kind: z.literal("system.other"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    instructionType: z.string(),
    raw: z.string(),
  }),
  z.object({
    kind: z.literal("computeBudget.setUnitLimit"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    units: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("computeBudget.setUnitPrice"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    microLamports: NonNegativeBigIntWireSchema,
  }),
  z.object({
    kind: z.literal("computeBudget.other"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    instructionType: z.string(),
  }),
  z.object({
    kind: z.literal("unknown"),
    programId: Base58PubkeySchema,
    instructionIndex: z.number().int().nonnegative(),
    dataHex: z.string(),
    accounts: z.array(z.string()),
  }),
]);
export type DecodedIxWire = z.infer<typeof DecodedIxWireSchema>;

export const BalanceDeltaSchema = z.object({
  account: Base58PubkeySchema,
  lamportsDelta: z.bigint(),
});
export type BalanceDelta = z.infer<typeof BalanceDeltaSchema>;

export const BalanceDeltaWireSchema = z.object({
  account: Base58PubkeySchema,
  lamportsDelta: SignedBigIntWireSchema,
});
export type BalanceDeltaWire = z.infer<typeof BalanceDeltaWireSchema>;

export const SimulationSummarySchema = z.object({
  preSlot: z.number().int().nonnegative(),
  postSlot: z.number().int().nonnegative(),
  unitsConsumed: z.number().int().nonnegative().nullable(),
  deltas: z.array(BalanceDeltaSchema),
  logsSanitized: z.array(z.string()),
});
export type SimulationSummary = z.infer<typeof SimulationSummarySchema>;

export const SimulationSummaryWireSchema = z.object({
  preSlot: z.number().int().nonnegative(),
  postSlot: z.number().int().nonnegative(),
  unitsConsumed: z.number().int().nonnegative().nullable(),
  deltas: z.array(BalanceDeltaWireSchema),
  logsSanitized: z.array(z.string()),
});
export type SimulationSummaryWire = z.infer<typeof SimulationSummaryWireSchema>;

const ReportBaseFields = {
  intentId: z.string().uuid(),
  messageHash: z.string().regex(/^[0-9a-f]{64}$/, {
    message: "messageHash must be a 64-character lowercase sha256 hex string",
  }),
  verdict: VerdictSchema,
  findings: z.array(FindingSchema),
  feeLamports: NonNegativeBigIntWireSchema.nullable(),
  checkedAtSlot: z.number().int().nonnegative().nullable(),
  generatedAt: z.number().int().nonnegative(),
  engineVersion: z.string().min(1),
};

function consistent(r: {verdict:Verdict; findings:Finding[]; decodedInstructions:unknown[]; feeLamports:string|null;
  checkedAtSlot:number|null; simulation:{preSlot:number;postSlot:number;deltas:unknown[]}|null}) {
  const verdict = r.findings.some(f=>f.severity==="BLOCK") ? "BLOCK" : r.findings.some(f=>f.severity==="WARN") ? "WARN" : "PASS";
  return verdict === r.verdict && (verdict === "BLOCK" || (!!r.simulation && r.checkedAtSlot === r.simulation.postSlot &&
    r.simulation.preSlot === r.checkedAtSlot && r.simulation.deltas.length >= 2 && r.feeLamports !== null && r.decodedInstructions.length > 0));
}
export const SecurityReportSchema = z.object({
  ...ReportBaseFields,
  decodedInstructions: z.array(DecodedIxSchema),
  simulation: SimulationSummarySchema.nullable(),
}).refine(consistent,"Inconsistent verdict, findings or simulation evidence");
export type SecurityReport = z.infer<typeof SecurityReportSchema>;

export const SecurityReportWireSchema = z.object({
  ...ReportBaseFields,
  decodedInstructions: z.array(DecodedIxWireSchema),
  simulation: SimulationSummaryWireSchema.nullable(),
}).refine(consistent,"Inconsistent verdict, findings or simulation evidence");
export type SecurityReportWire = z.infer<typeof SecurityReportWireSchema>;

export function serializeIntent(intent: Intent): IntentWire {
  const parsed = IntentSchema.parse(intent);
  return {
    ...parsed,
    amountBaseUnits: parsed.amountBaseUnits.toString(10),
  };
}

export function parseIntent(input: unknown): Intent {
  const wire = IntentWireSchema.parse(input);
  return {
    ...wire,
    amountBaseUnits: BigInt(wire.amountBaseUnits),
  };
}

function serializeDecodedIx(ix: DecodedIx): DecodedIxWire {
  switch (ix.kind) {
    case "system.transfer":
      return { ...ix, lamports: ix.lamports.toString(10) };
    case "computeBudget.setUnitPrice":
      return { ...ix, microLamports: ix.microLamports.toString(10) };
    default:
      return ix;
  }
}

function parseDecodedIx(ix: DecodedIxWire): DecodedIx {
  switch (ix.kind) {
    case "system.transfer":
      return { ...ix, lamports: BigInt(ix.lamports) };
    case "computeBudget.setUnitPrice":
      return { ...ix, microLamports: BigInt(ix.microLamports) };
    default:
      return ix;
  }
}

export function serializeReport(report: SecurityReport): SecurityReportWire {
  const parsed = SecurityReportSchema.parse(report);
  return {
    ...parsed,
    decodedInstructions: parsed.decodedInstructions.map(serializeDecodedIx),
    simulation: parsed.simulation
      ? {
          ...parsed.simulation,
          deltas: parsed.simulation.deltas.map((d) => ({
            account: d.account,
            lamportsDelta: d.lamportsDelta.toString(10),
          })),
        }
      : null,
  };
}

export function parseReport(input: unknown): SecurityReport {
  const wire = SecurityReportWireSchema.parse(input);
  return {
    ...wire,
    decodedInstructions: wire.decodedInstructions.map(parseDecodedIx),
    simulation: wire.simulation
      ? {
          ...wire.simulation,
          deltas: wire.simulation.deltas.map((d) => ({
            account: d.account,
            lamportsDelta: BigInt(d.lamportsDelta),
          })),
        }
      : null,
  };
}
