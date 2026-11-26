import { ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";

export type CommitmentLevel = "processed" | "confirmed" | "finalized";

export interface SecurityConfig {
  /** Base58 program IDs explicitly allowlisted for decoding and execution. */
  allowedPrograms: readonly string[];
  /** Maximum allowed priority fee in lamports (bigint). Default: 100_000n (0.0001 SOL). */
  maxPriorityFeeLamports: bigint;
  /** Maximum allowed required signatures on the transaction. Default: 1. */
  maxRequiredSignatures: number;
  /** Whether durable nonce instructions (AdvanceNonceAccount) are permitted. Default: false. */
  allowDurableNonce: boolean;
  /** Known-benign wallet-injected programs allowed in verifySigned diffs. Default: []. */
  allowedExtraPrograms: readonly string[];
  /** Per-call RPC timeout in milliseconds. Default: 8000. */
  rpcTimeoutMs: number;
  /** Number of retries on transient RPC errors. Default: 2. */
  rpcRetries: number;
  /** Solana RPC commitment level. Default: "confirmed". */
  commitment: CommitmentLevel;
}

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  allowedPrograms: [
    SystemProgram.programId.toBase58(),
    ComputeBudgetProgram.programId.toBase58(),
  ],
  maxPriorityFeeLamports: 100_000n,
  maxRequiredSignatures: 1,
  allowDurableNonce: false,
  allowedExtraPrograms: [],
  rpcTimeoutMs: 8000,
  rpcRetries: 2,
  commitment: "confirmed",
};

export function resolveConfig(
  overrides?: Partial<SecurityConfig>
): SecurityConfig {
  if (!overrides) {
    return DEFAULT_SECURITY_CONFIG;
  }
  return {
    ...DEFAULT_SECURITY_CONFIG,
    ...overrides,
    allowedPrograms:
      overrides.allowedPrograms ?? DEFAULT_SECURITY_CONFIG.allowedPrograms,
    allowedExtraPrograms:
      overrides.allowedExtraPrograms ??
      DEFAULT_SECURITY_CONFIG.allowedExtraPrograms,
  };
}
