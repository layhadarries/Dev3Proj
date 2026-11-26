/**
 * The contract between agent, security engine and UI.
 * Amounts are bigint base units in code and decimal strings on the JSON wire:
 * `Schema.parse(wire)` decodes, `z.encode(Schema, value)` produces JSON-safe output.
 * Change only by pull request with all three owners approving.
 */
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";

export const U64_MAX = (1n << 64n) - 1n;

export const AddressSchema = z.string().refine((value) => {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}, "Not a valid Solana address");

/** Wire form: decimal string. In code: bigint. Range 0..u64. */
export const BaseUnitsSchema = z.codec(
  z.string().regex(/^(0|[1-9]\d{0,19})$/, "Must be an integer decimal string"),
  z.bigint().min(0n).max(U64_MAX),
  { decode: (s) => BigInt(s), encode: (n) => n.toString() },
);
const PositiveBaseUnitsSchema = BaseUnitsSchema.refine((n) => typeof n === "bigint" && n > 0n, "Must be above zero");

export const MessageHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const AssetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("SOL") }),
  z.strictObject({ type: z.literal("SPL"), mint: AddressSchema }),
]);

/** What the user confirmed. The security engine verifies transactions against this. */
export const IntentSchema = z
  .strictObject({
    id: z.uuid(),
    kind: z.literal("TRANSFER"),
    asset: AssetSchema,
    recipient: AddressSchema,
    amountBaseUnits: PositiveBaseUnitsSchema,
    payer: AddressSchema,
    confirmedAt: z.iso.datetime(),
  })
  .refine((i) => i.payer !== i.recipient, "Payer and recipient must differ");
export type Intent = z.output<typeof IntentSchema>;
export type IntentWire = z.input<typeof IntentSchema>;

/** An unsigned transaction message. Nothing in it is trusted until the security engine checks it. */
export const BuiltTransactionSchema = z.strictObject({
  intentId: z.uuid(),
  /** Serialized message, base64. This is exactly what gets signed. */
  messageBase64: z.base64().min(1),
  /** SHA-256 of the message bytes, lowercase hex. */
  messageHash: MessageHashSchema,
  recentBlockhash: z.string().min(32).max(44),
  lastValidBlockHeight: z.number().int().positive(),
});
export type BuiltTransaction = z.infer<typeof BuiltTransactionSchema>;

export const BLOCK_RULES = [
  "AMOUNT_MISMATCH", "RECIPIENT_MISMATCH", "PAYER_MISMATCH", "ASSET_MISMATCH", "EXTRA_TRANSFER",
  "UNEXPECTED_BALANCE_CHANGE", "UNAUTHORIZED_APPROVAL", "AUTHORITY_CHANGE", "ACCOUNT_CLOSE", "UNKNOWN_PROGRAM",
  "UNSUPPORTED_INSTRUCTION", "UNDECODABLE_MESSAGE", "LOOKUP_TABLE_UNRESOLVED", "EXTRA_SIGNER", "DURABLE_NONCE_USED",
  "EXCESSIVE_PRIORITY_FEE", "SIM_FAILED", "RPC_UNAVAILABLE", "RPC_INCONSISTENT", "TX_EXPIRED", "TX_MODIFIED",
  "INTERNAL_ERROR",
] as const;
export const WARN_RULES = [
  "TOKEN_FREEZE_AUTH", "TOKEN_PERMANENT_DELEGATE", "TOKEN_TRANSFER_FEE", "TOKEN_OTHER_EXTENSION",
  "RECIPIENT_NEW_ACCOUNT",
] as const;

export const RuleIdSchema = z.enum([...BLOCK_RULES, ...WARN_RULES]);
export type RuleId = z.infer<typeof RuleIdSchema>;
export const VerdictSchema = z.enum(["PASS", "WARN", "BLOCK"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const FindingSchema = z
  .strictObject({
    ruleId: RuleIdSchema,
    severity: z.enum(["WARN", "BLOCK"]),
    /** Factual detail. May contain untrusted on-chain text: render as plain text. */
    message: z.string().max(2000),
    evidence: z.strictObject({
      instructionIndex: z.number().int().nonnegative().optional(),
      account: z.string().optional(),
      expected: z.string().optional(),
      actual: z.string().optional(),
    }),
  })
  .refine(
    (f) => f.severity === ((BLOCK_RULES as readonly string[]).includes(f.ruleId) ? "BLOCK" : "WARN"),
    "Severity does not match the rule",
  );
export type Finding = z.infer<typeof FindingSchema>;

export const DecodedInstructionSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  programId: AddressSchema,
  name: z.string(),
  accounts: z.array(AddressSchema),
});

export const SecurityReportSchema = z
  .strictObject({
    intentId: z.uuid(),
    messageHash: MessageHashSchema,
    verdict: VerdictSchema,
    findings: z.array(FindingSchema),
    decodedInstructions: z.array(DecodedInstructionSchema),
    /** null when simulation did not complete; the report must then carry a BLOCK finding. */
    simulation: z
      .strictObject({
        balanceChanges: z.array(
          z.strictObject({ account: AddressSchema, preLamports: BaseUnitsSchema, postLamports: BaseUnitsSchema }),
        ),
        logs: z.array(z.string()),
      })
      .nullable(),
    feeLamports: BaseUnitsSchema.nullable(),
    slot: z.number().int().nonnegative().nullable(),
    generatedAt: z.iso.datetime(),
    engineVersion: z.string().min(1),
  })
  .superRefine((report, ctx) => {
    const has = (s: "WARN" | "BLOCK") => report.findings.some((f) => f.severity === s);
    const expected: Verdict = has("BLOCK") ? "BLOCK" : has("WARN") ? "WARN" : "PASS";
    if (report.verdict !== expected) ctx.addIssue({ code: "custom", message: `Verdict must be ${expected}` });
    if (report.simulation === null && !has("BLOCK")) {
      ctx.addIssue({ code: "custom", message: "Missing simulation requires a BLOCK finding" });
    }
  });
export type SecurityReport = z.output<typeof SecurityReportSchema>;
export type SecurityReportWire = z.input<typeof SecurityReportSchema>;
