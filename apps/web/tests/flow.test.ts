import {
  ComputeBudgetProgram, Keypair, SystemProgram, Transaction, VersionedMessage, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { ApiError, createApi, type Api } from "../lib/client/api";
import {
  confirmAndCheck, prepare, signAndSubmit, signIn, submissionOutcome,
  validateSubmissionReceipt, type Card, type Review, type SigningHooks,
} from "../lib/client/flow";
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
  ({ id: card.id, deadline: 1, transaction: { messageBase64: message.toString("base64") }, report: { verdict } }) as unknown as Review;

function server(replies: Record<string, unknown>) {
  const calls: string[] = [];
  const api: Api = async <T>(route: string, _body: unknown, validate?: (value: unknown) => T) => {
    void _body;
    void validate;
    calls.push(route);
    if (!(route in replies)) throw new Error(`unexpected ${route}`);
    const reply = replies[route];
    return validate ? validate(reply) : reply as T;
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
const sent: string[] = [];
const live: SigningHooks = { isCurrent: () => true, onSubmit: (signature) => sent.push(signature) };
// Ed25519 signatures are deterministic, so the expected one can be computed in advance.
const signedOnce = new VersionedTransaction(VersionedMessage.deserialize(message));
signedOnce.sign([owner]);
const expectedSignature = bs58.encode(signedOnce.signatures[0]!);
const good = { handoff: { wire: unsignedWire(message) }, acknowledge: { ok: true }, submit: { signature: expectedSignature } };

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
    expect(await prepare(server({ parse: parsed, stage: card }).api, address, "x", () => 5)).toEqual({ card, deadline: 60_005 });
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
    expect((await confirmAndCheck(api, card, () => 7)).deadline).toBe(60_007);
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
    expect(await signAndSubmit(api, wallet(), address, review("PASS"), false, live)).toBe(expectedSignature);
    expect(calls).toEqual(["handoff", "submit"]);
  });
  it("never signs a blocked transaction", async () => {
    const w = wallet();
    const { api, calls } = server(good);
    await expect(signAndSubmit(api, w, address, review("BLOCK"), true, live)).rejects.toThrow("blocked");
    expect([calls, w.signed]).toEqual([[], 0]);
  });
  it("needs an explicit acknowledgement for a warning", async () => {
    const first = server(good);
    await expect(signAndSubmit(first.api, wallet(), address, review("WARN"), false, live)).rejects.toThrow("Acknowledge");
    expect(first.calls).toEqual([]);
    const second = server(good);
    await signAndSubmit(second.api, wallet(), address, review("WARN"), true, live);
    expect(second.calls).toEqual(["acknowledge", "handoff", "submit"]);
  });
  it("does not sign a swapped handoff", async () => {
    const w = wallet();
    const { api } = server({ ...good, handoff: { wire: unsignedWire(bytes(6)) } });
    await expect(signAndSubmit(api, w, address, review("PASS"), false, live)).rejects.toThrow("differs");
    expect(w.signed).toBe(0);
  });
  it("says which programs a wallet added", async () => {
    const adding: WalletProvider = {
      ...wallet(),
      signTransaction: async () => {
        const changed = Transaction.from(Buffer.from(unsignedWire(message), "base64"));
        changed.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }));
        return new VersionedTransaction(VersionedMessage.deserialize(changed.serializeMessage()));
      },
    };
    await expect(signAndSubmit(server(good).api, adding, address, review("PASS"), false, live)).rejects.toThrow(
      `instructions: 1 before, 2 after; added programs: ${ComputeBudgetProgram.programId.toBase58()}`,
    );
  });
  it("does not submit if the wallet changes the transaction", async () => {
    const { api, calls } = server(good);
    await expect(signAndSubmit(api, wallet(true), address, review("PASS"), false, live)).rejects.toThrow("wallet changed");
    expect(calls).toEqual(["handoff"]);
  });
  it("stops if the account changed", async () => {
    const w = wallet();
    await expect(signAndSubmit(server(good).api, w, recipient, review("PASS"), false, live)).rejects.toThrow("account changed");
    expect(w.signed).toBe(0);
  });
});

describe("abandoning and tracking a submission", () => {
  /** Hooks that report the review as abandoned once the given route has been called. */
  function abandonedAfter(calls: string[], route: string): SigningHooks {
    return { isCurrent: () => !calls.includes(route), onSubmit: () => {} };
  }
  it("does not open the wallet if abandoned during the handoff", async () => {
    const w = wallet();
    const { api, calls } = server(good);
    await expect(signAndSubmit(api, w, address, review("PASS"), false, abandonedAfter(calls, "handoff"))).rejects.toThrow("Cancelled");
    expect([w.signed, calls]).toEqual([0, ["handoff"]]);
  });
  it("does not submit if abandoned while the wallet prompt is open", async () => {
    const w = wallet();
    const { api, calls } = server(good);
    const hooks: SigningHooks = { isCurrent: () => w.signed === 0, onSubmit: () => {} };
    await expect(signAndSubmit(api, w, address, review("PASS"), false, hooks)).rejects.toThrow("Cancelled");
    expect(calls).toEqual(["handoff"]);
  });
  it("reports the transaction signature before submitting", async () => {
    const order: string[] = [];
    const api: Api = async <T>(route: string) => {
      order.push(route);
      if (route === "submit") throw new Error("connection lost");
      return good[route as "handoff"] as T;
    };
    let reported = "";
    const hooks: SigningHooks = { isCurrent: () => true, onSubmit: (s) => { reported = s; order.push("reported"); } };
    await expect(signAndSubmit(api, wallet(), address, review("PASS"), false, hooks)).rejects.toThrow("connection lost");
    expect(order).toEqual(["handoff", "reported", "submit"]);
    expect(reported).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  });
  it.each([
    [new Error("connection lost"), "unknown"],
    [new ApiError("Could not complete the request", 502), "unknown"],
    [new ApiError("Transaction is unconfirmed (signature: x). Do not submit again", 504), "unknown"],
    [new ApiError("Transaction failed on Devnet (signature: x)", 502), "failed"],
    [new ApiError("Confirmation is missing or no longer valid.", 409), "not_sent"],
    [new ApiError("Too many requests", 429), "not_sent"],
  ])("classifies %s", (error, outcome) => {
    expect(submissionOutcome(error)).toBe(outcome);
  });
});

describe("false confirmations", () => {
  it.each([{}, { signature: "" }, { signature: "someone-else" }, { ok: true }])(
    "does not treat %j as success",
    async (reply) => {
      const { api } = server({ ...good, submit: reply });
      let reported = "";
      const hooks: SigningHooks = { isCurrent: () => true, onSubmit: (s) => (reported = s) };
      const failure = await signAndSubmit(api, wallet(), address, review("PASS"), false, hooks).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(reported).not.toBe("");
      expect(submissionOutcome(failure)).toBe("unknown");
    },
  );

  it.each([
    ["empty successful response", {}],
    ["missing signature", { ok: true }],
    ["null signature", { signature: null }],
    ["numeric signature", { signature: 123 }],
    ["boolean signature", { signature: true }],
    ["array signature", { signature: [expectedSignature] }],
    ["object signature", { signature: { value: expectedSignature } }],
    ["empty signature", { signature: "" }],
    ["invalid Base58", { signature: "0OIl" }],
    ["wrong decoded length", { signature: bs58.encode(new Uint8Array(63).fill(1)) }],
    ["valid different signature", { signature: bs58.encode(new Uint8Array(64).fill(7)) }],
    ["unexpected envelope", { signature: expectedSignature, extra: true }],
  ])("rejects %s without confirming", async (_name, reply) => {
    const { api, calls } = server({ ...good, submit: reply });
    let reported = "";
    const hooks: SigningHooks = { isCurrent: () => true, onSubmit: (signature) => { reported = signature; } };
    const failure = await signAndSubmit(api, wallet(), address, review("PASS"), false, hooks).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(reported).toBe(expectedSignature);
    expect(calls).toEqual(["handoff", "submit"]);
  });

  it("rejects noncanonical Base58 signatures", () => {
    const valid = bs58.decode(expectedSignature);
    expect(() => validateSubmissionReceipt({ signature: `${bs58.encode(valid)}1` }, expectedSignature)).toThrow();
  });

  it("does not resubmit after a lost response", async () => {
    const order: string[] = [];
    const api: Api = async <T>(route: string, _body: unknown, validate?: (value: unknown) => T) => {
      void _body;
      void validate;
      order.push(route);
      if (route === "handoff") return { wire: unsignedWire(message) } as T;
      if (route === "submit") throw new Error("lost response after dispatch");
      throw new Error("unexpected");
    };
    let reported = "";
    const hooks: SigningHooks = { isCurrent: () => true, onSubmit: (signature) => { reported = signature; } };
    await expect(signAndSubmit(api, wallet(), address, review("PASS"), false, hooks)).rejects.toThrow("lost response");
    expect(order).toEqual(["handoff", "submit"]);
    expect(reported).toBe(expectedSignature);
  });
});

describe("helpers", () => {
  it("shows server errors", async () => {
    const api = createApi((async () => new Response('{"error":"nope"}', { status: 409 })) as typeof fetch);
    await expect(api("x", {})).rejects.toThrow("nope");
    const missing = createApi((async () => new Response("<html>", { status: 404 })) as typeof fetch);
    await expect(missing("x", {})).rejects.toMatchObject({ status: 404, message: "x failed (HTTP 404)" });
  });
  it("rejects empty and malformed success bodies before validation", async () => {
    const empty = createApi((async () => new Response("", { status: 200 })) as typeof fetch);
    await expect(empty("submit", {}, (value) => validateSubmissionReceipt(value, expectedSignature)))
      .rejects.toMatchObject({ status: 200 });
    const malformed = createApi((async () => new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch);
    await expect(malformed("submit", {}, (value) => validateSubmissionReceipt(value, expectedSignature)))
      .rejects.toMatchObject({ status: 200 });
  });
  it("validates submission envelopes at createApi", async () => {
    const invalid = createApi((async () => new Response(JSON.stringify({ signature: expectedSignature, extra: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch);
    await expect(invalid("submit", {}, (value) => validateSubmissionReceipt(value, expectedSignature)))
      .rejects.toThrow("unexpected");
  });
  it("formats lamports exactly", () => {
    expect(lamportsToSol("9007199254740993")).toBe("9007199.254740993");
    expect(lamportsToSol("1000000000")).toBe("1");
  });
});
