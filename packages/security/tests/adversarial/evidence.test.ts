import { afterEach, expect, it, vi } from "vitest";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createDevnetRpc,
  parseConfirmedSolIntent,
  verifyUnsigned,
} from "../../src/index.js";
const address = String(PublicKey.unique());
const intent = {
  id: "11111111-1111-4111-8111-111111111111",
  confirmedAt: 12,
  kind: "transfer",
  payer: address,
  recipient: String(PublicKey.unique()),
  asset: { type: "SOL" },
  amountBaseUnits: "1200",
};
const expected = parseConfirmedSolIntent(intent);
const wire = new Transaction({
  feePayer: new PublicKey(address),
  recentBlockhash: String(PublicKey.unique()),
})
  .add(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(address),
      toPubkey: new PublicKey(intent.recipient),
      lamports: 1200n,
    }),
  )
  .serialize({ requireAllSignatures: false });
const deps = {
  walletPublicKey: address,
  network: "devnet" as const,
  rpc: createDevnetRpc({}),
};
afterEach(() => vi.unstubAllGlobals());

it.each([
  { network: "mainnet" },
  { extraTransfer: true },
  { asset: { type: "SOL", mint: address } },
  { amountBaseUnits: "18446744073709551616" },
  { amountBaseUnits: "01" },
])("rejects ambiguous wire intent", (change) => {
  expect(() => parseConfirmedSolIntent({ ...intent, ...change })).toThrow();
});
it.each([
  [{ err: null }, "RPC_UNAVAILABLE"],
  [{ err: "BlockhashNotFound" }, "SIM_FAILED"],
  [
    { err: null, innerInstructions: [{ index: 0, instructions: [] }] },
    "RPC_UNAVAILABLE",
  ],
] as const)(
  "blocks when a live-shaped response lacks required evidence",
  async (value, rule) => {
    const response = (result: unknown) =>
      Response.json({ id: 1, jsonrpc: "2.0", result });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
        )
        .mockResolvedValueOnce(response({ context: { slot: 5 }, value: 5000 }))
        .mockResolvedValueOnce(response({ context: { slot: 5 }, value })),
    );
    expect(
      (await verifyUnsigned(expected, wire, deps)).findings[0]?.ruleId,
    ).toBe(rule);
  },
);
it("blocks wrong network, malformed envelopes and unexpected pre-filled signatures", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const w of [
    Uint8Array.of(1),
    Buffer.from(wire).fill(2, 0, 1),
    Buffer.from(wire).fill(1, 1, 2),
  ])
    expect((await verifyUnsigned(expected, w, deps)).verdict).toBe("BLOCK");
  expect(
    (
      await verifyUnsigned(expected, wire, {
        ...deps,
        network: "mainnet" as "devnet",
      })
    ).verdict,
  ).toBe("BLOCK");
  expect(fetch).not.toHaveBeenCalled();
});
