import type { VersionedTransaction } from "@solana/web3.js";

/** The parts of an injected wallet (Phantom, Solflare) that the app uses. Sign only, never send. */
export interface WalletProvider {
  publicKey: { toString(): string } | null;
  connect(): Promise<unknown>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
  on?(event: string, listener: () => void): void;
  off?(event: string, listener: () => void): void;
}

export function findWallet(): WalletProvider | undefined {
  const w = window as unknown as {
    phantom?: { solana?: WalletProvider };
    solflare?: WalletProvider;
    solana?: WalletProvider;
  };
  return w.phantom?.solana ?? w.solflare ?? w.solana;
}
