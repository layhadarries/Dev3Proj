import { VersionedTransaction } from "@solana/web3.js";

/** The parts of an injected wallet (Phantom, Solflare) that the app uses. Sign only, never send. */
export interface WalletProvider {
  publicKey: { toString(): string } | null;
  connect(): Promise<unknown>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
  on?(event: string, listener: () => void): void;
  off?(event: string, listener: () => void): void;
}

const DEVNET = "solana:devnet";

interface StandardAccount {
  address: string;
  chains?: readonly string[];
  features?: readonly string[];
}

/** The parts of a Wallet Standard wallet that the app uses. MetaMask is only reachable this way. */
export interface StandardWallet {
  name: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
}

interface Features {
  "standard:connect": { connect(): Promise<{ accounts: readonly StandardAccount[] }> };
  "standard:events"?: { on(event: "change", listener: (change: { accounts?: unknown }) => void): () => void };
  "solana:signMessage": {
    signMessage(input: { account: StandardAccount; message: Uint8Array }): Promise<readonly { signature: Uint8Array }[]>;
  };
  "solana:signTransaction": {
    signTransaction(input: {
      account: StandardAccount;
      transaction: Uint8Array;
      chain: string;
    }): Promise<readonly { signedTransaction: Uint8Array }[]>;
  };
}

const REQUIRED = ["standard:connect", "solana:signMessage", "solana:signTransaction"];
export const usable = (wallet: StandardWallet) =>
  wallet.chains.includes(DEVNET) && REQUIRED.every((name) => name in wallet.features);

/** An account may support less than its wallet does. Lists it leaves out are not held against it. */
const canSign = (account: StandardAccount) =>
  (account.chains?.includes(DEVNET) ?? true) &&
  (account.features
    ? ["solana:signMessage", "solana:signTransaction"].every((name) => account.features?.includes(name))
    : true);

export function fromStandard(wallet: StandardWallet): WalletProvider {
  const features = wallet.features as unknown as Features;
  let account: StandardAccount | undefined;
  let stop: (() => void) | undefined;
  const current = () => {
    if (!account) throw new Error("Connect the wallet first.");
    return account;
  };
  return {
    get publicKey() {
      const address = account?.address;
      return address ? { toString: () => address } : null;
    },
    async connect() {
      const { accounts } = await features["standard:connect"].connect();
      account = accounts.find(canSign);
      if (!account) throw new Error(`${wallet.name} did not share a Solana account that can sign on Devnet.`);
    },
    async signMessage(message) {
      const [result] = await features["solana:signMessage"].signMessage({ account: current(), message });
      if (!result) throw new Error("The wallet did not sign the message.");
      return { signature: result.signature };
    },
    async signTransaction(transaction) {
      const [result] = await features["solana:signTransaction"].signTransaction({
        account: current(),
        transaction: transaction.serialize(),
        chain: DEVNET,
      });
      if (!result) throw new Error("The wallet did not sign the transaction.");
      return VersionedTransaction.deserialize(result.signedTransaction);
    },
    // Only "accountChanged" is reported; it also covers disconnecting.
    on(event, listener) {
      if (event !== "accountChanged") return;
      stop = features["standard:events"]?.on("change", (change) => {
        if (!change.accounts || wallet.accounts.find(canSign)?.address === account?.address) return;
        account = undefined;
        listener();
      });
    },
    off(event) {
      if (event === "accountChanged") stop?.();
    },
  };
}

/** Asks installed wallets to announce themselves, following the Wallet Standard window events. */
export function discoverWallets(target: EventTarget): StandardWallet[] {
  const found: StandardWallet[] = [];
  const api = Object.freeze({
    register: (...wallets: StandardWallet[]) => {
      found.push(...wallets);
      return () => {};
    },
  });
  const onRegister = (event: Event) => (event as Event & { detail: (a: typeof api) => void }).detail(api);
  target.addEventListener("wallet-standard:register-wallet", onRegister);
  target.dispatchEvent(Object.assign(new Event("wallet-standard:app-ready"), { detail: api }));
  target.removeEventListener("wallet-standard:register-wallet", onRegister);
  return found;
}

export function findWallet(): WalletProvider | undefined {
  const w = window as unknown as {
    phantom?: { solana?: WalletProvider };
    solflare?: WalletProvider;
    solana?: WalletProvider;
  };
  const injected = w.phantom?.solana ?? w.solflare ?? w.solana;
  if (injected) return injected;
  const standard = discoverWallets(window).find(usable);
  return standard && fromStandard(standard);
}
