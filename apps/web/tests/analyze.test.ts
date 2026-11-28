import { PublicKey, Keypair, VersionedTransaction } from "@solana/web3.js";
import { verifyUnsigned, type RpcClient } from "@solguard/security";
import { serializeReport } from "@solguard/shared";
import { describe, expect, it } from "vitest";
import { analyze, describeInstructions, exampleAttack, type Example } from "../lib/client/analyze";
import type { Api } from "../lib/client/api";
import { solToLamports } from "../lib/client/format";

const payer = Keypair.generate().publicKey.toBase58();

/** The real engine, with no network: these attacks must be refused before any RPC call. */
async function engine(kind: Example) {
  const example = exampleAttack(kind, payer);
  const unreachable = new Proxy({}, { get: () => () => { throw new Error("no network in tests"); } }) as RpcClient;
  const report = await verifyUnsigned(
    {
      id: "11111111-1111-4111-8111-111111111111", kind: "transfer", asset: { type: "SOL" }, payer,
      recipient: example.recipient, amountBaseUnits: solToLamports(example.amountSol)!, confirmedAt: Date.now(),
    },
    Buffer.from(example.transaction, "base64"),
    { rpc: unreachable, walletPublicKey: payer, network: "devnet" },
  );
  return {
    example,
    report: serializeReport(report),
    intended: { recipient: example.recipient, amountBaseUnits: "10000000" },
  };
}

describe("example attacks", () => {
  it("are unsigned transactions paid by the connected wallet", () => {
    const wire = Buffer.from(exampleAttack("extra", payer).transaction, "base64");
    const transaction = VersionedTransaction.deserialize(wire);
    expect(transaction.message.staticAccountKeys[0]).toEqual(new PublicKey(payer));
    expect(transaction.signatures).toHaveLength(1);
    expect(transaction.signatures[0]!.every((byte) => byte === 0)).toBe(true);
  });

  it("blocks the hidden extra transfer and flags only the second instruction", async () => {
    const result = await engine("extra");
    expect(result.report.verdict).toBe("BLOCK");
    expect(result.report.findings[0]?.ruleId).toBe("EXTRA_TRANSFER");
    const lines = describeInstructions(result);
    expect(lines.map((line) => [line.number, line.flagged])).toEqual([[1, false], [2, true]]);
    expect(lines[1]!.text).toContain("Sends 0.5 SOL to ");
  });

  it("blocks and flags the swapped recipient", async () => {
    const result = await engine("recipient");
    expect(result.report.findings[0]?.ruleId).toBe("RECIPIENT_MISMATCH");
    expect(describeInstructions(result)).toMatchObject([{ number: 1, flagged: true }]);
  });

  it("flags a repeat of the wanted transfer", async () => {
    const result = await engine("extra");
    const first = result.report.decodedInstructions[0]!;
    const report = { ...result.report, findings: [], decodedInstructions: [first, { ...first, instructionIndex: 1 }] };
    expect(describeInstructions({ ...result, report }).map((line) => line.flagged)).toEqual([false, true]);
  });
});

describe("analyze", () => {
  const server = (explained: string) => {
    const calls: [string, unknown][] = [];
    const api: Api = async <T>(route: string, body: unknown) => {
      calls.push([route, body]);
      return (route === "analyze" ? { report: { verdict: "BLOCK" } } : { verdict: explained }) as T;
    };
    return { api, calls };
  };
  const input = { recipient: ` ${payer} `, amountSol: " 0.5 ", transaction: "AAAA\n BBBB\n" };

  it("sends exact lamports and unwrapped base64, and never a signing route", async () => {
    const { api, calls } = server("BLOCK");
    await analyze(api, input);
    expect(calls.map(([route]) => route)).toEqual(["analyze", "explain"]);
    expect(calls[0]![1]).toEqual({ recipient: payer, amountBaseUnits: "500000000", transactionBase64: "AAAABBBB" });
  });

  it("rejects a bad amount before calling the server", async () => {
    const { api, calls } = server("BLOCK");
    for (const amountSol of ["", "0", "-1", "1e3", "0.0000000001", "one"]) {
      await expect(analyze(api, { ...input, amountSol })).rejects.toThrow("amount in SOL");
    }
    expect(calls).toEqual([]);
  });

  it("rejects an explanation that disagrees with the report", async () => {
    await expect(analyze(server("PASS").api, input)).rejects.toThrow("does not match");
  });
});
