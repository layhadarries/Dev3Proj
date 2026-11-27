export function lamportsToSol(lamports: string | bigint): string {
  const value = BigInt(lamports);
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${value / 1_000_000_000n}${fraction ? `.${fraction}` : ""}`;
}
