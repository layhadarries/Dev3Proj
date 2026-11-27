import { Keypair, SystemProgram, Transaction, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { createApi, type Api } from "../lib/client/api";
import { confirmAndCheck, prepare, signAndSubmit, signIn, type Card, type Review } from "../lib/client/flow";
import { lamportsToSol } from "../lib/client/format";
import type { WalletProvider } from "../lib/client/wallet";

// Throwaway keys generated per run; nothing is funded or sent.
const owner = Keypair.generate();
const address = owner.publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const blockhash = Keypair.generate().publicKey.toBase58();
const bytes = (lamports: number) =>
  new Transaction({ feePayer: owner.publicKey, recentBlockhash: blockhash })
    .add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.fromSeed(new Uint8Array(32)).publicKey, lamports }))
    .serializeMessage();
const message = bytes(5);
const unsignedWire = (m: Buffer) => Buffer.from(new VersionedTransaction(VersionedMessage.deserialize(m)).serialize()).toString("base64");

const card: Card = {
  id: "11111111-1111-4111-8111-111111111111", network: "devnet", wallet: address, asset: "SOL",
  recipient, amountBaseUnits: "5", expiresAt: 1000,
};
const review = (verdict: "PASS" | "WARN" | "BLOCK") =>
  ({ id: card.id, expiresAt: 1, transaction: { messageBase64: message.toString("base64") }, report: { verdict } }) as unknown as Review;

function server(replies: Record<string, unknown>) {
  const calls: string[] = [];
  const api: Api = async <T>(route: string) => {
    calls.push(route);
    if (!(route in replies)) throw new Error(`unexpected ${route}`);
    return replies[route] as T;
  };
  return { api, calls };
}
function wallet(tamper = false): WalletProvider & { signed: number } {
  return {
    signed: 0,
    publicKey: owner.publicKey,
    connect: async () => {},
    signMessage: async () => ({ signature: new Uint8Array(64) }),
    async signTransaction(transaction) {
      this.signed += 1;
      const result = tamper ? new VersionedTransaction(VersionedMessage.deserialize(bytes(6))) : transaction;
      result.sign([owner]);
      return result;
    },
  };
}
const good = { handoff: { wire: unsignedWire(message) }, acknowledge: { ok: true }, submit: { signature: "sig" } };

describe("sign in", () => {
  it("signs the server's challenge", async () => {
    const { api, calls } = server({ "session/challenge": { message: "hi" }, session: {} });
    expect(await signIn(api, wallet())).toBe(address);
    expect(calls).toEqual(["session/challenge", "session"]);
  });
});

describe("prepare", () => {
  const parsed = { status: "ready", draft: { recipient, amountBaseUnits: "5" }, source: "rules" };
  it("returns the server card", async () => {
    expect(await prepare(server({ parse: parsed, stage: card }).api, address, "x")).toEqual({ card });
  });
  it("passes a clarification through without staging", async () => {
    const { api, calls } = server({ parse: { status: "needs_clarification", question: "How much?" } });
    expect(await prepare(api, address, "x")).toEqual({ reason: "How much?" });
    expect(calls).toEqual(["parse"]);
  });
  it.each([
    { recipient: address }, { amountBaseUnits: "50" }, { wallet: recipient }, { network: "mainnet" }, { asset: "USDC" },
  ])("rejects a card that differs: %j", async (change) => {
    await expect(prepare(server({ parse: parsed, stage: { ...card, ...change } }).api, address, "x")).rejects.toThrow("does not match");
  });
});

describe("confirm and check", () => {
  const intent = { id: card.id, payer: address, recipient, amountBaseUnits: "5", confirmedAt: 10 };
  const built = { transaction: { messageHash: "h" }, report: { intentId: card.id, messageHash: "h" } };
  it("starts the window at confirmation", async () => {
    const { api, calls } = server({ confirm: { intent }, build: built, explain: {} });
    expect((await confirmAndCheck(api, card)).expiresAt).toBe(60_010);
    expect(calls).toEqual(["confirm", "build", "explain"]);
  });
  it("does not build if the confirmed intent differs", async () => {
    const { api, calls } = server({ confirm: { intent: { ...intent, amountBaseUnits: "6" } } });
    await expect(confirmAndCheck(api, card)).rejects.toThrow("differ");
    expect(calls).toEqual(["confirm"]);
  });
  it("rejects a report for another transaction", async () => {
    const wrong = { ...built, report: { intentId: card.id, messageHash: "other" } };
    await expect(confirmAndCheck(server({ confirm: { intent }, build: wrong }).api, card)).rejects.toThrow("different transaction");
  });
});

describe("sign and submit", () => {
  it("signs the handed-off message and submits it", async () => {
    const { api, calls } = server(good);
    expect(await signAndSubmit(api, wallet(), address, review("PASS"), false)).toBe("sig");
    expect(calls).toEqual(["handoff", "submit"]);
  });
  it("never signs a blocked transaction", async () => {
    const w = wallet();
    const { api, calls } = server(good);
    await expect(signAndSubmit(api, w, address, review("BLOCK"), true)).rejects.toThrow("blocked");
    expect([calls, w.signed]).toEqual([[], 0]);
  });
  it("needs an explicit acknowledgement for a warning", async () => {
    const first = server(good);
    await expect(signAndSubmit(first.api, wallet(), address, review("WARN"), false)).rejects.toThrow("Acknowledge");
    expect(first.calls).toEqual([]);
    const second = server(good);
    await signAndSubmit(second.api, wallet(), address, review("WARN"), true);
    expect(second.calls).toEqual(["acknowledge", "handoff", "submit"]);
  });
  it("does not sign a swapped handoff", async () => {
    const w = wallet();
    const { api } = server({ ...good, handoff: { wire: unsignedWire(bytes(6)) } });
    await expect(signAndSubmit(api, w, address, review("PASS"), false)).rejects.toThrow("differs");
    expect(w.signed).toBe(0);
  });
  it("does not submit if the wallet changes the transaction", async () => {
    const { api, calls } = server(good);
    await expect(signAndSubmit(api, wallet(true), address, review("PASS"), false)).rejects.toThrow("wallet changed");
    expect(calls).toEqual(["handoff"]);
  });
  it("stops if the account changed", async () => {
    const w = wallet();
    await expect(signAndSubmit(server(good).api, w, recipient, review("PASS"), false)).rejects.toThrow("account changed");
    expect(w.signed).toBe(0);
  });
});

describe("helpers", () => {
  it("shows server errors", async () => {
    const api = createApi((async () => new Response('{"error":"nope"}', { status: 409 })) as typeof fetch);
    await expect(api("x", {})).rejects.toThrow("nope");
    const missing = createApi((async () => new Response("<html>", { status: 404 })) as typeof fetch);
    await expect(missing("x", {})).rejects.toThrow("HTTP 404");
  });
  it("formats lamports exactly", () => {
    expect(lamportsToSol("9007199254740993")).toBe("9007199.254740993");
    expect(lamportsToSol("1000000000")).toBe("1");
  });
});
