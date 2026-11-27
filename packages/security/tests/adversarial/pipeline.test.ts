import { expect, it, vi } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import {
  APPROVAL_TTL_MS,
  prepareWalletApproval,
  verify,
  verifySigned,
} from "../../src/index.js";
// Ephemeral unit fixture only. Never funded or submitted.
const signer = Keypair.generate();
const p = signer.publicKey,
  r = PublicKey.unique(),
  hash = PublicKey.unique().toBase58();
const intent = {
  id: "11111111-1111-4111-8111-111111111111",
  confirmedAt: 1,
  kind: "transfer",
  asset: { type: "SOL" },
  payer: String(p),
  recipient: String(r),
  amountBaseUnits: 8n,
} as const;
const msg = new Transaction({ feePayer: p, recentBlockhash: hash })
  .add(
    SystemProgram.transfer({
      fromPubkey: p,
      toPubkey: r,
      lamports: 8n,
    }),
  )
  .serializeMessage();
function setup(initial = 2n) {
  const context = { slot: 100 };
  const value = {
    err: null,
    fee: 5000n,
    preBalances: [10000n, initial, 1n],
    postBalances: [4992n, initial + 8n, 1n],
    accounts: [4992n, initial + 8n].map((lamports) => ({
      owner: "11111111111111111111111111111111" as const,
      executable: false as const,
      lamports,
      data: ["", "base64"] as ["", "base64"],
    })),
    innerInstructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
    replacementBlockhash: null,
    logs: ["fixture"],
    unitsConsumed: 150,
  };
  const rpc = {
    identity: vi.fn(),
    fresh: vi.fn(async () => ({
      network: "devnet" as const,
      commitment: "confirmed" as const,
      blockhash: hash,
      slot: 100n,
    })),
    fee: vi.fn(async () => ({ context, value: 5000n })),
    simulate: vi.fn(async () => ({ context, value })),
  };
  return {
    value,
    rpc,
    deps: { rpc, walletPublicKey: String(p), network: "devnet" as const },
  };
}
it("consumes handoffs and signed approvals only once under concurrent calls", async () => {
  const { deps } = setup();
  const report = await verify(intent, msg, deps);
  const first = prepareWalletApproval(intent, msg, report, deps);
  await expect(prepareWalletApproval(intent, msg, report, deps)).rejects.toThrow();
  const wire = await first;
  wire.set(ed25519.sign(msg, signer.secretKey.slice(0,32)), 1);
  const results = await Promise.all([verifySigned(intent,wire,report,deps),verifySigned(intent,wire,report,deps)]);
  expect(results.map(r=>r.verdict)).toEqual(["PASS","BLOCK"]);
});
it("invalidates approval if the wallet changes while freshness is being checked", async () => {
  const { deps, rpc } = setup();
  const report = await verify(intent,msg,deps);
  rpc.fresh.mockImplementationOnce(async () => {
    deps.walletPublicKey = String(r);
    return { network:"devnet", commitment:"confirmed", blockhash:hash, slot:100n };
  });
  await expect(prepareWalletApproval(intent,msg,report,deps)).rejects.toThrow(/changed/);
  deps.walletPublicKey = String(p);
  await expect(prepareWalletApproval(intent,msg,report,deps)).rejects.toThrow();
});
it("blocks invalid signer limits and every truncated prefix before RPC", async () => {
  const {deps,rpc} = setup();
  for (let i = 0; i < msg.length; i++) {
    expect((await verify(intent,msg.subarray(0,i),deps)).verdict).toBe("BLOCK");
  }
  expect((await verify(intent,msg,{...deps,config:{maxRequiredSignatures:NaN}})).verdict).toBe("BLOCK");
  expect(rpc.identity).not.toHaveBeenCalled();
});
it("binds fee and simulation to identical bytes and verifies freshness after simulation", async () => {
  const { deps, rpc } = setup();
  expect((await verify(intent, msg, deps)).verdict).toBe("PASS");
  expect(rpc.fee).toHaveBeenCalledWith(msg.toString("base64"));
  expect(rpc.simulate).toHaveBeenCalledWith(
    msg.toString("base64"),
    [String(p), String(r)],
    100,
  );
  expect(rpc.fresh).toHaveBeenCalledWith(hash, 100n);
});

it.each([
  "valid",
  "missing",
  "wrong key",
  "changed message",
  "signature count",
])("verifies signed wire: %s", async (mode) => {
  const { deps } = setup();
  const report = await verify(intent, msg, deps);
  const wire = await prepareWalletApproval(intent, msg, report, deps);
  if (mode !== "missing")
    wire.set(
      ed25519.sign(
        msg,
        (mode === "wrong key" ? Keypair.generate() : signer).secretKey.slice(
          0,
          32,
        ),
      ),
      1,
    );
  if (mode === "changed message") wire[wire.length - 1] = 1;
  if (mode === "signature count") wire[0] = 2;
  expect((await verifySigned(intent, wire, report, deps)).verdict).toBe(
    mode === "valid" ? "PASS" : "BLOCK",
  );
  expect((await verifySigned(intent, wire, report, deps)).verdict).toBe(
    "BLOCK",
  );
});

it("does not trust copied reports, changed wallet or changed confirmation", async () => {
  const { deps } = setup();
  const report = await verify(intent, msg, deps);
  await expect(
    prepareWalletApproval(intent, msg, { ...report }, deps),
  ).rejects.toThrow();
  await expect(
    prepareWalletApproval(
      { ...intent, amountBaseUnits: 9n },
      msg,
      report,
      deps,
    ),
  ).rejects.toThrow();
  const second = await verify(intent, msg, deps);
  await expect(
    prepareWalletApproval(intent, msg, second, {
      ...deps,
      walletPublicKey: String(r),
    }),
  ).rejects.toThrow();
  const third = await verify(intent, msg, deps);
  await expect(
    prepareWalletApproval(intent, msg, third, {
      ...deps,
      maxSpendLamports: 1n,
    }),
  ).rejects.toThrow(/policy/);
});
it("requires acknowledgement even if caller edits WARN report to PASS", async () => {
  const { deps } = setup(0n);
  const report = await verify(intent, msg, deps);
  report.verdict = "PASS";
  await expect(
    prepareWalletApproval(intent, msg, report, deps),
  ).rejects.toThrow(/acknowledgement/);
});
it("rejects expired approvals, invalid blockhashes and changed fees", async () => {
  const { deps, rpc } = setup();
  let time = 10;
  const d = { ...deps, now: () => time };
  const report = await verify(intent, msg, d);
  time += APPROVAL_TTL_MS;
  await expect(prepareWalletApproval(intent, msg, report, d)).rejects.toThrow(
    /expired/,
  );
  const second = await verify(intent, msg, d);
  rpc.fee.mockResolvedValueOnce({ context: { slot: 100 }, value: 9000n });
  await expect(prepareWalletApproval(intent, msg, second, d)).rejects.toThrow(
    /Fee/,
  );
  rpc.fresh.mockRejectedValueOnce(new Error("BLOCKHASH_NOT_VALID"));
  expect((await verify(intent, msg, d)).findings[0]?.ruleId).toBe("TX_EXPIRED");
});
it("warns on new recipient and blocks inconsistent deltas, fees and missing evidence", async () => {
  const { value, deps, rpc } = setup(0n);
  expect((await verify(intent, msg, deps)).verdict).toBe("WARN");
  value.postBalances[1] = 9n;
  expect((await verify(intent, msg, deps)).findings[0]?.ruleId).toBe(
    "UNEXPECTED_BALANCE_CHANGE",
  );
  expect(
    (await verify(intent, msg, { ...deps, maxFeeLamports: 4999n })).findings[0]
      ?.ruleId,
  ).toBe("EXCESSIVE_PRIORITY_FEE");
  rpc.simulate.mockRejectedValue(new Error("private rpc detail"));
  expect((await verify(intent, msg, deps)).findings[0]?.ruleId).toBe(
    "RPC_UNAVAILABLE",
  );
});
