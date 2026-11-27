import { expect, it } from "vitest";
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { compareTransfer, decodeTransaction } from "../../src/index.js";

const payer = PublicKey.unique(), recipient = PublicKey.unique();
const transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 9007199254740993n });
const tx = () => new Transaction({ feePayer: payer, recentBlockhash: PublicKey.unique().toBase58() });
const intent = { kind: "transfer", asset: { type: "SOL" }, payer: String(payer), recipient: String(recipient),
  id: "11111111-1111-4111-8111-111111111111", confirmedAt: 1, amountBaseUnits: 9007199254740993n } as const;
it("decodes compute budget and exact u64 amounts", () => {
  const { decoded } = decodeTransaction(tx().add(ComputeBudgetProgram.setComputeUnitLimit({units: 500}),
    ComputeBudgetProgram.setComputeUnitPrice({microLamports: 31n}), transfer).serializeMessage());
  expect(decoded.map(ix => ix.kind)).toEqual(["computeBudget.setUnitLimit","computeBudget.setUnitPrice","system.transfer"]);
  expect(compareTransfer(intent, decoded).lamports).toBe(intent.amountBaseUnits);
});
it("rejects extra transfers and mismatched confirmation fields", () => {
  expect(() => compareTransfer(intent, decodeTransaction(tx().add(transfer,transfer).serializeMessage()).decoded)).toThrow(/exactly one/);
  const { decoded } = decodeTransaction(tx().add(transfer).serializeMessage());
  for (const change of [{recipient:String(payer)}, {payer:String(recipient)}, {amountBaseUnits:2n}])
    expect(() => compareTransfer({...intent,...change}, decoded)).toThrow();
});
it("rejects trailing bytes and unsupported programs", () => {
  expect(() => decodeTransaction(Buffer.concat([tx().add(transfer).serializeMessage(),Buffer.alloc(1)]))).toThrow();
  expect(() => decodeTransaction(tx().add({...transfer,programId:PublicKey.unique()}).serializeMessage())).toThrow(/outside/);
});
