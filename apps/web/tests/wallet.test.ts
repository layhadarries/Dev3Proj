import { Keypair, SystemProgram, Transaction, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { discoverWallets, fromStandard, usable, type StandardWallet } from "../lib/client/wallet";

const owner = Keypair.generate();
const address = owner.publicKey.toBase58();

function standard() {
  const seen: { chain?: string } = {};
  let change: ((c: { accounts?: unknown }) => void) | undefined;
  const wallet = {
    name: "Test", chains: ["solana:devnet"], accounts: [{ address }],
    features: {
      "standard:connect": { connect: async () => ({ accounts: wallet.accounts }) },
      "standard:events": { on: (_: string, f: typeof change) => { change = f; return () => { change = undefined; }; } },
      "solana:signMessage": { signMessage: async () => [{ signature: new Uint8Array(64) }] },
      "solana:signTransaction": {
        signTransaction: async (input: { transaction: Uint8Array; chain: string }) => {
          seen.chain = input.chain;
          const tx = VersionedTransaction.deserialize(input.transaction);
          tx.sign([owner]);
          return [{ signedTransaction: tx.serialize() }];
        },
      },
    },
  };
  return { wallet: wallet as unknown as StandardWallet & { accounts: { address: string }[] }, seen, emit: () => change?.({ accounts: [] }) };
}

describe("wallet standard", () => {
  it("finds wallets whether they register before or after the app", () => {
    const early = standard().wallet;
    const late = standard().wallet;
    const target = new EventTarget();
    target.addEventListener("wallet-standard:app-ready", (event) => {
      (event as Event & { detail: { register(w: StandardWallet): void } }).detail.register(late);
      target.dispatchEvent(Object.assign(new Event("wallet-standard:register-wallet"), {
        detail: (api: { register(w: StandardWallet): void }) => api.register(early),
      }));
    });
    expect(discoverWallets(target)).toEqual([late, early]);
  });
  it("requires Devnet and sign-only support", () => {
    const { wallet } = standard();
    expect(usable(wallet)).toBe(true);
    expect(usable({ ...wallet, chains: ["solana:mainnet"] })).toBe(false);
    expect(usable({ ...wallet, features: { "standard:connect": {} } })).toBe(false);
  });
  it("picks the first account able to sign on Devnet", async () => {
    const { wallet } = standard();
    wallet.accounts = [
      { address: "mainnet", chains: ["solana:mainnet"] },
      { address: "read-only", chains: ["solana:devnet"], features: ["solana:signMessage"] },
      { address, chains: ["solana:devnet"], features: ["solana:signMessage", "solana:signTransaction"] },
    ] as never;
    const provider = fromStandard(wallet);
    await provider.connect();
    expect(provider.publicKey?.toString()).toBe(address);
    wallet.accounts = [{ address: "mainnet", chains: ["solana:mainnet"] }] as never;
    await expect(fromStandard(wallet).connect()).rejects.toThrow("sign on Devnet");
  });
  it("signs on Devnet without changing the message", async () => {
    const { wallet, seen } = standard();
    const provider = fromStandard(wallet);
    await provider.connect();
    expect(provider.publicKey?.toString()).toBe(address);
    const message = new Transaction({ feePayer: owner.publicKey, recentBlockhash: address })
      .add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: owner.publicKey, lamports: 1 }))
      .serializeMessage();
    const signed = await provider.signTransaction(new VersionedTransaction(VersionedMessage.deserialize(message)));
    expect(Buffer.from(signed.message.serialize())).toEqual(message);
    expect(seen.chain).toBe("solana:devnet");
  });
  it("reports an account change, but not an unrelated change event", async () => {
    const { wallet, emit } = standard();
    const provider = fromStandard(wallet);
    await provider.connect();
    let changes = 0;
    provider.on?.("accountChanged", () => (changes += 1));
    emit();
    expect(changes).toBe(0);
    wallet.accounts = [{ address: "other" }];
    emit();
    expect([changes, provider.publicKey]).toEqual([1, null]);
  });
});
