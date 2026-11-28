import { expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import {
  APPROVAL_TTL_MS,
  createConfirmationGateway,
  hashMessage,
} from "../../src/index.js";

const signer = Keypair.generate();
const payer = signer.publicKey;
const recipient = PublicKey.unique();
const other = Keypair.generate();
const blockhash = PublicKey.unique().toBase58();
const message = new Transaction({ feePayer: payer, recentBlockhash: blockhash })
  .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 8n }))
  .serializeMessage();
const alteredMessage = new Transaction({ feePayer: payer, recentBlockhash: blockhash })
  .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 9n }))
  .serializeMessage();

function fixture(initial = 2n, initialTime = 100) {
  const context = { slot: 100 };
  const value = {
    err: null, fee: 5000n, preBalances: [10000n, initial, 1n],
    postBalances: [4992n, initial + 8n, 1n],
    accounts: [4992n, initial + 8n].map((lamports) => ({
      owner: "11111111111111111111111111111111" as const,
      executable: false as const, lamports, data: ["", "base64"] as ["", "base64"],
    })),
    innerInstructions: [], preTokenBalances: [], postTokenBalances: [],
    replacementBlockhash: null, logs: ["fixture"], unitsConsumed: 150,
  };
  const rpc = {
    identity: vi.fn(async () => ({
      network: "devnet" as const,
      genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    })),
    fresh: vi.fn(async () => ({
      network: "devnet" as const, commitment: "confirmed" as const, blockhash, slot: 100n,
    })),
    fee: vi.fn(async () => ({ context, value: 5000n })),
    simulate: vi.fn(async () => ({ context, value })),
  };
  let time = initialTime;
  const identity = { sessionId: "gateway-test", walletPublicKey: String(payer), network: "devnet" as const };
  const resolve = () => identity;
  const gate = createConfirmationGateway({ rpc, now: () => time });
  const draft = { recipient: String(recipient), amountBaseUnits: "8" };
  const card = gate.stage(resolve, draft);
  const built = (bytes = message) => ({
    intentId: card.id, messageBase64: bytes.toString("base64"),
    messageHash: hashMessage(bytes), recentBlockhash: blockhash, lastValidBlockHeight: 123,
  });
  return {
    rpc, identity, resolve, gate, card, draft, built,
    advance: (ms: number) => { time += ms; },
    setTime: (value: number) => { time = value; },
    time: () => time,
    expiresAt: card.expiresAt,
  };
}

function signedWire(bytes = message, key = signer) {
  return Buffer.concat([
    Buffer.from([1]),
    Buffer.from(ed25519.sign(bytes, key.secretKey.slice(0, 32))),
    Buffer.from(bytes),
  ]);
}
function signedWireWithCount(bytes: Uint8Array, signatures: Uint8Array[]) {
  return Buffer.concat([Buffer.from([signatures.length]), ...signatures.map(Buffer.from), Buffer.from(bytes)]);
}

async function ready() {
  const f = fixture();
  f.gate.confirm(f.resolve, f.card.id);
  await f.gate.inspect(f.resolve, f.card.id, f.built());
  await f.gate.handoff(f.resolve, f.card.id);
  return f;
}

it("validates confirmation IDs and session identifiers", () => {
  const f = fixture();
  for (const id of ["", "nope", "__proto__", "x".repeat(1000), "22222222-2222-4222-8222-222222222222"])
    expect(() => f.gate.intent(f.resolve, id)).toThrow(/INVALID_CONFIRMATION/);
  for (const change of [
    { sessionId: "" }, { sessionId: "x".repeat(257) }, { sessionId: 5 },
    { walletPublicKey: "invalid" }, { network: "mainnet-beta" },
  ]) {
    const bad = () => ({ ...f.identity, ...change }) as never;
    expect(() => f.gate.stage(bad, f.draft)).toThrow(/AUTHENTICATED_DEVNET_SESSION_REQUIRED/);
  }
});

it("rejects invalid clocks at stage and confirmation, while preserving the draft after failure", () => {
  const f = fixture();
  for (const bad of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    f.setTime(bad);
    expect(() => f.gate.stage(f.resolve, f.draft)).toThrow(/INVALID_SERVER_CLOCK/);
  }
  const zero = fixture(2n, 0);
  expect(() => zero.gate.confirm(zero.resolve, zero.card.id)).toThrow(/INVALID_SERVER_CLOCK/);
  expect(() => zero.gate.intent(zero.resolve, zero.card.id)).toThrow(/INTENT_NOT_CONFIRMED/);
  zero.setTime(100);
  expect(zero.gate.confirm(zero.resolve, zero.card.id).confirmedAt).toBe(100);
});

it("leaves confirmation atomic if expiry arithmetic overflows", () => {
  const f = fixture(2n, Number.MAX_SAFE_INTEGER - APPROVAL_TTL_MS);
  f.setTime(Number.MAX_SAFE_INTEGER - APPROVAL_TTL_MS + 1);
  expect(() => f.gate.confirm(f.resolve, f.card.id)).toThrow(/INVALID_SERVER_CLOCK/);
  expect(() => f.gate.intent(f.resolve, f.card.id)).toThrow(/INTENT_NOT_CONFIRMED/);
  f.setTime(100);
  expect(f.gate.confirm(f.resolve, f.card.id).confirmedAt).toBe(100);
});

it("leaves confirmation atomic if monotonic deadline arithmetic is invalid", () => {
  const f = fixture();
  const spy=vi.spyOn(performance,"now").mockReturnValue(Number.NaN);
  expect(()=>f.gate.confirm(f.resolve,f.card.id)).toThrow(/INVALID_SERVER_CLOCK/);
  spy.mockRestore();
  expect(f.gate.confirm(f.resolve,f.card.id).confirmedAt).toBe(100);
});

it("rejects expiry arithmetic equal to the current wall or monotonic instant", () => {
  const f=fixture();
  f.setTime(f.expiresAt);
  expect(()=>f.gate.confirm(f.resolve,f.card.id)).toThrow(/CONFIRMATION_EXPIRED/);
  const g=fixture();
  const staged=performance.now.bind(performance)();
  const spy=vi.spyOn(performance,"now").mockReturnValue(staged+APPROVAL_TTL_MS);
  expect(()=>g.gate.confirm(g.resolve,g.card.id)).toThrow(/CONFIRMATION_EXPIRED/);
  spy.mockRestore();
});

it("confirms immediately before wall expiry and updates all confirmation fields", () => {
  const f = fixture();
  f.advance(APPROVAL_TTL_MS - 1);
  const confirmation = f.gate.confirm(f.resolve, f.card.id);
  expect(confirmation.confirmedAt).toBe(f.time());
  expect(confirmation.id).toBe(f.card.id);
  expect(f.gate.intent(f.resolve, f.card.id)).toEqual(confirmation);
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("requires positive confirmed timestamps in the low-level verifier", async () => {
  const f = fixture();
  const { verify } = await import("../../src/verification/verify.js");
  const draftIntent = {
    id: f.card.id, confirmedAt: 0, kind: "transfer" as const, asset: { type: "SOL" as const },
    payer: String(payer), recipient: String(recipient), amountBaseUnits: 8n,
  };
  const report = await verify(draftIntent, message, {
    rpc: f.rpc, now: () => 100, network: "devnet", walletPublicKey: String(payer),
  });
  expect(report.verdict).toBe("BLOCK");
});

it("keeps single-use semantics for malformed signed submissions", async () => {
  const f = await ready();
  const transport = vi.fn();
  await expect(f.gate.submitAndConfirm(f.resolve, f.card.id, Buffer.alloc(1), transport))
    .rejects.toThrow(/INVALID_SIGNED_WIRE/);
  await expect(f.gate.submitAndConfirm(f.resolve, f.card.id, signedWire(), transport))
    .rejects.toThrow(/INVALID_CONFIRMATION/);
  expect(transport).not.toHaveBeenCalled();
});

it("atomically consumes a handoff before concurrent signed verification begins", async () => {
  const f = await ready();
  const verificationStarted = deferred();
  const releaseVerification = deferred();
  let feeCalls = 0;
  f.rpc.fee.mockImplementation(async () => {
    feeCalls++;
    verificationStarted.resolve();
    await releaseVerification.promise;
    return { context: { slot: 100 }, value: 5000n };
  });
  const firstPayload = signedWire();
  const competingPayload = signedWire(alteredMessage);
  const transport = vi.fn(async (bytes: Uint8Array) => Buffer.from(bytes));
  const first = f.gate.submitAndConfirm(f.resolve, f.card.id, firstPayload, transport);
  await verificationStarted.promise;
  await expect(f.gate.submitAndConfirm(f.resolve, f.card.id, competingPayload, transport))
    .rejects.toThrow(/INVALID_CONFIRMATION/);
  releaseVerification.resolve();
  await expect(first).resolves.toEqual(firstPayload);
  expect(feeCalls).toBe(1);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0]?.[0]).toEqual(firstPayload);
});

it("does not restore a consumed handoff after failed asynchronous signed verification", async () => {
  const f = await ready();
  const verificationStarted = deferred();
  const releaseVerification = deferred();
  let feeCalls = 0;
  f.rpc.fee.mockImplementation(async () => {
    feeCalls++;
    verificationStarted.resolve();
    await releaseVerification.promise;
    throw new Error("injected verifier failure");
  });
  const transport = vi.fn();
  const first = f.gate.submitAndConfirm(f.resolve, f.card.id, signedWire(), transport);
  await verificationStarted.promise;
  await expect(f.gate.submitAndConfirm(f.resolve, f.card.id, signedWire(), transport))
    .rejects.toThrow(/INVALID_CONFIRMATION/);
  releaseVerification.resolve();
  await expect(first).rejects.toThrow();
  await expect(f.gate.submitAndConfirm(f.resolve, f.card.id, signedWire(), transport))
    .rejects.toThrow(/INVALID_CONFIRMATION/);
  expect(transport).not.toHaveBeenCalled();
  expect(feeCalls).toBe(1);
});

it.each([
  ["wrong signer", signedWire(message, other)],
  ["changed message", signedWire(alteredMessage)],
  ["trailing byte", Buffer.concat([signedWire(), Buffer.from([0])])],
  ["oversized", Buffer.alloc(1233)],
])("rejects %s without transport and consumes handoff", async (_name, wire) => {
  const f = await ready();
  const transport = vi.fn();
  await expect(f.gate.submitAndConfirm(f.resolve, f.card.id, wire, transport)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  await expect(f.gate.submitAndConfirm(f.resolve, f.card.id, signedWire(), transport))
    .rejects.toThrow(/INVALID_CONFIRMATION/);
});

it("rejects additional signature slots and malformed signed encodings before transport", async () => {
  const f = await ready();
  const validSignature = ed25519.sign(message, signer.secretKey.slice(0, 32));
  const extraSignature = signedWireWithCount(message, [validSignature, new Uint8Array(64)]);
  const transport = vi.fn();
  await expect(f.gate.submitAndConfirm(f.resolve, f.card.id, extraSignature, transport)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it("revalidates session, wallet and network after asynchronous signed verification", async () => {
  for (const field of ["sessionId", "walletPublicKey", "network"] as const) {
    const f = await ready();
    f.rpc.fresh.mockImplementationOnce(async () => {
      if (field === "sessionId") f.identity.sessionId = "rotated";
      else if (field === "walletPublicKey") f.identity.walletPublicKey = String(other.publicKey);
      else (f.identity as { network: string }).network = "mainnet-beta";
      return { network: "devnet" as const, commitment: "confirmed" as const, blockhash, slot: 100n };
    });
    const transport = vi.fn();
    await expect(f.gate.submitAndConfirm(f.resolve, f.card.id, signedWire(), transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  }
});

it("blocks stale identity changes during confirmation, inspection, handoff and submission", async () => {
  for (const field of ["sessionId", "walletPublicKey", "network"] as const) {
    const confirming = fixture();
    const badConfirmSession = () => {
      const current = { ...confirming.identity };
      if (field === "sessionId") current.sessionId = "rotated";
      else if (field === "walletPublicKey") current.walletPublicKey = String(other.publicKey);
      else (current as { network: string }).network = "mainnet-beta";
      return current as typeof confirming.identity;
    };
    expect(() => confirming.gate.confirm(badConfirmSession, confirming.card.id)).toThrow();
    expect(() => confirming.gate.intent(confirming.resolve, confirming.card.id))
      .toThrow(/INTENT_NOT_CONFIRMED/);

    const inspecting = fixture();
    inspecting.gate.confirm(inspecting.resolve, inspecting.card.id);
    const inspectionStarted = deferred();
    const releaseInspection = deferred();
    let inspectionStartedFlag = false;
    inspecting.rpc.fee.mockImplementation(async () => {
      if (!inspectionStartedFlag) {
        inspectionStartedFlag = true;
        inspectionStarted.resolve();
      }
      await releaseInspection.promise;
      return { context: { slot: 100 }, value: 5000n };
    });
    const inspect = inspecting.gate.inspect(inspecting.resolve, inspecting.card.id, inspecting.built());
    await inspectionStarted.promise;
    if (field === "sessionId") inspecting.identity.sessionId = "rotated";
    else if (field === "walletPublicKey") inspecting.identity.walletPublicKey = String(other.publicKey);
    else (inspecting.identity as { network: string }).network = "mainnet-beta";
    releaseInspection.resolve();
    await expect(inspect).rejects.toThrow();

    const handing = fixture();
    handing.gate.confirm(handing.resolve, handing.card.id);
    await handing.gate.inspect(handing.resolve, handing.card.id, handing.built());
    const handoffReady = deferred();
    const allowHandoff = deferred();
    handing.rpc.fee.mockImplementation(async () => {
      handoffReady.resolve();
      await allowHandoff.promise;
      return { context: { slot: 100 }, value: 5000n };
    });
    const handoffStarted = deferred();
    handoffReady.promise.then(() => handoffStarted.resolve());
    const handoff = handing.gate.handoff(handing.resolve, handing.card.id);
    await handoffStarted.promise;
    if (field === "sessionId") handing.identity.sessionId = "rotated";
    else if (field === "walletPublicKey") handing.identity.walletPublicKey = String(other.publicKey);
    else (handing.identity as { network: string }).network = "mainnet-beta";
    allowHandoff.resolve();
    await expect(handoff).rejects.toThrow();
  }
});

it("rejects extra request arguments and invalid transports without weakening verification", async () => {
  const f = await ready();
  const signed = signedWire();
  const transport = vi.fn(async (snapshot: Uint8Array) => snapshot);
  await expect(f.gate.submitAndConfirm(f.resolve, f.card.id, signed, undefined as never))
    .rejects.toThrow(/INVALID_TRANSPORT/);
  expect(await f.gate.submitAndConfirm(f.resolve, f.card.id, signed, transport)).toEqual(signed);
  expect(transport).toHaveBeenCalledTimes(1);
});
