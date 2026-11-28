export function lamportsToSol(lamports: string | bigint): string {
  const value = BigInt(lamports);
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${value / 1_000_000_000n}${fraction ? `.${fraction}` : ""}`;
}

/** Converts a plain decimal SOL amount to lamports without floating point. Returns null if invalid. */
export function solToLamports(sol: string): bigint | null {
  const match = /^(\d{1,11})?(?:\.(\d{1,9}))?$/.exec(sol);
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;
  const lamports = BigInt(match[1] ?? "0") * 1_000_000_000n + BigInt((match[2] ?? "").padEnd(9, "0"));
  return lamports > 0n && lamports < 2n ** 64n ? lamports : null;
}
