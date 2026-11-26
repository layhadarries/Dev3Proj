import { Keypair, Message, SystemInstruction, Transaction } from "@solana/web3.js";
import { IntentSchema, SecurityReportSchema, type SecurityReportWire } from "@solguard/shared";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentHandlers, buildTransfer, confirmIntent, explainReport, lamportsToSol, llmFromEnv,
  openAiCompatibleClient, parseTransfer, solToLamports, type LlmClient,
} from "../src";

// Throwaway public keys generated per run.
const alice = Keypair.generate().publicKey.toBase58();
const bob = Keypair.generate().publicKey.toBase58();
const mallory = Keypair.generate().publicKey.toBase58();
const says = (output: unknown): LlmClient => ({
  complete: async () => (typeof output === "string" ? output : JSON.stringify(output)),
});
const transfer = (amount: string, recipient: string, asset = "SOL") => ({ action: "transfer", asset, amount, recipient });
const loose = `could you move 0.5 SOL over to ${bob} for me`;

describe("amounts", () => {
  it("converts exactly", () => {
    expect(solToLamports("0.5")).toBe(500_000_000n);
    expect(solToLamports(".000000001")).toBe(1n);
    expect(solToLamports("18446744073.709551615")).toBe(18446744073709551615n);
    expect(lamportsToSol("1500000001")).toBe("1.500000001");
  });
  it.each(["0", "-1", "1e9", "1,5", "0.0000000001", "18446744073.709551616", "", ".", "NaN", " 1"])("rejects %j", (v) => {
    expect(solToLamports(v)).toBeNull();
  });
});

describe("parser", () => {
  it("parses a simple command without a model", async () => {
    expect(await parseTransfer(`Send 0.5 SOL to ${bob}`)).toEqual({
      status: "ready", source: "rules", draft: { recipient: bob, amountBaseUnits: "500000000" },
    });
  });
  it("uses the model for looser phrasing", async () => {
    expect(await parseTransfer(loose, says(transfer("0.5", bob)))).toMatchObject({ status: "ready", source: "llm" });
  });
  it("accepts an equivalent spelling of the typed amount only", async () => {
    const message = `please pay ${bob} the sum of .001 SOL`;
    expect(await parseTransfer(message, says(transfer("0.001", bob)))).toMatchObject({ draft: { amountBaseUnits: "1000000" } });
    expect((await parseTransfer(message, says(transfer("0.01", bob)))).status).toBe("needs_clarification");
  });
  it("accepts fenced JSON after a thought block", async () => {
    const reply = `<thought>hmm</thought>\n\`\`\`json\n${JSON.stringify(transfer("0.5", bob))}\n\`\`\``;
    expect((await parseTransfer(loose, says(reply))).status).toBe("ready");
  });
  it.each([
    ["swapped recipient", transfer("0.5", mallory)],
    ["changed amount", transfer("5", bob)],
    ["changed asset", transfer("0.5", bob, "USDC")],
    ["prose", "Sure! I sent it."],
    ["unknown action", { action: "sign" }],
  ])("rejects model output: %s", async (_name, output) => {
    expect((await parseTransfer(loose, says(output))).status).toBe("needs_clarification");
  });
  it("fails closed when the model errors", async () => {
    const broken: LlmClient = { complete: async () => { throw new Error("down"); } };
    expect((await parseTransfer(loose, broken)).status).toBe("needs_clarification");
  });
  it.each([
    `swap 1 SOL to USDC`,
    `send 5 USDC to ${bob}`,
    `don't send 1 SOL to ${bob}`,
    `send 1 SOL to ${bob} and ${mallory}`,
    `send 1 SOL or 2 SOL to ${bob}`,
    `send 1,5 SOL to ${bob}`,
    `send -1 SOL to ${bob}`,
    `send 1e9 SOL to ${bob}`,
    `send 0 SOL to ${bob}`,
    `send 1 million SOL to ${bob}`,
    `send 1k SOL to ${bob}`,
    `send 1 SOL and a half to ${bob}`,
    `pay ${bob} 1 dollar in SOL`,
    `send 1 SOL to my friend`,
    `send 1 to ${bob}`,
    `send 1 SOL to ${"z".repeat(44)}`,
    `send 1 SOL to ${bob}‮`,
    "x".repeat(501),
    "",
  ])("never produces a draft for %j, even with a compliant model", async (message) => {
    const eager = says(transfer("1", bob));
    expect((await parseTransfer(message, eager)).status).not.toBe("ready");
  });
});

describe("builder", () => {
  const rpc = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
  };
  const intent = confirmIntent({ recipient: bob, amountBaseUnits: "9007199254740993" }, alice);

  it("builds one transfer message matching the intent", async () => {
    const built = await buildTransfer(intent, rpc);
    const message = Buffer.from(built.messageBase64, "base64");
    const tx = Transaction.populate(Message.from(message));
    expect(tx.instructions).toHaveLength(1);
    expect(tx.feePayer?.toBase58()).toBe(alice);
    const decoded = SystemInstruction.decodeTransfer(tx.instructions[0]!);
    expect(decoded.fromPubkey.toBase58()).toBe(alice);
    expect(decoded.toPubkey.toBase58()).toBe(bob);
    // Above Number.MAX_SAFE_INTEGER: proves no float rounding.
    expect(decoded.lamports).toBe(9007199254740993n);
    expect(createHash("sha256").update(message).digest("hex")).toBe(built.messageHash);
  });
  it("round-trips intents through JSON", () => {
    const wire = JSON.parse(JSON.stringify(z.encode(IntentSchema, intent)));
    expect(wire.amountBaseUnits).toBe("9007199254740993");
    expect(IntentSchema.parse(wire)).toEqual(intent);
  });
  it("rejects tampered or invalid intents", async () => {
    await expect(buildTransfer({ ...intent, amountBaseUnits: 0n }, rpc)).rejects.toThrow();
    await expect(buildTransfer({ ...intent, amountBaseUnits: 1n << 64n }, rpc)).rejects.toThrow();
    await expect(buildTransfer({ ...intent, extra: 1 } as never, rpc)).rejects.toThrow();
    await expect(buildTransfer({ ...intent, asset: { type: "SPL", mint: mallory } }, rpc)).rejects.toThrow("Only SOL");
    expect(() => confirmIntent({ recipient: alice, amountBaseUnits: "1" }, alice)).toThrow();
    for (const bad of ["1.5", "-1", "abc", "01", 1]) {
      expect(IntentSchema.safeParse({ ...z.encode(IntentSchema, intent), amountBaseUnits: bad }).success).toBe(false);
    }
  });
  it("propagates RPC failure", async () => {
    await expect(buildTransfer(intent, { getLatestBlockhash: async () => { throw new Error("rpc"); } })).rejects.toThrow("rpc");
  });
});

describe("reports and explanations", () => {
  const finding = { ruleId: "EXTRA_TRANSFER", severity: "BLOCK", message: "Second transfer found.", evidence: { instructionIndex: 1 } } as const;
  const report: SecurityReportWire = {
    intentId: globalThis.crypto.randomUUID(),
    messageHash: "a".repeat(64),
    verdict: "BLOCK",
    findings: [finding],
    decodedInstructions: [],
    simulation: { balanceChanges: [{ account: alice, preLamports: "5000005000", postLamports: "500000000" }], logs: [] },
    feeLamports: "5000",
    slot: 1,
    generatedAt: new Date().toISOString(),
    engineVersion: "test",
  };
  it("explains only what the report says", () => {
    const result = explainReport(report);
    expect(result.headline).toMatch(/^Blocked/);
    expect(result.points.map((p) => p.ruleId)).toEqual(["EXTRA_TRANSFER"]);
    expect(result.balanceChanges).toEqual([{ account: alice, changeSol: "-4.500005" }]);
    expect(result.feeSol).toBe("0.000005");
  });
  it("refuses inconsistent reports", () => {
    expect(() => explainReport({ ...report, verdict: "PASS" })).toThrow();
    expect(() => explainReport({ ...report, verdict: "WARN" })).toThrow();
    expect(SecurityReportSchema.safeParse({ ...report, verdict: "PASS", findings: [], simulation: null }).success).toBe(false);
    const downgraded = { ...finding, severity: "WARN" as const };
    expect(SecurityReportSchema.safeParse({ ...report, verdict: "WARN", findings: [downgraded] }).success).toBe(false);
  });
  it("serves explanations over the handler", async () => {
    const handlers = agentHandlers({ rpc: { getLatestBlockhash: async () => { throw new Error(); } } });
    const send = (body: unknown) =>
      handlers.explain(new Request("http://localhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await send(report)).status).toBe(200);
    expect((await send({ ...report, verdict: "PASS" })).status).toBe(400);
  });
});

describe("model client", () => {
  it("sends no tools and hides error bodies", async () => {
    let sent: Record<string, unknown> = {};
    const client = openAiCompatibleClient({
      baseUrl: "https://example.invalid/v1/", apiKey: "k", model: "m",
      fetch: (async (_url: unknown, init: RequestInit) => {
        sent = JSON.parse(init.body as string);
        return new Response("secret", { status: 429 });
      }) as typeof fetch,
    });
    await expect(client.complete("s", "u")).rejects.toThrow(/^LLM request failed with HTTP 429$/);
    expect(Object.keys(sent).sort()).toEqual(["max_tokens", "messages", "model", "temperature"]);
  });
  it("is disabled without full configuration", () => {
    expect(llmFromEnv({ LLM_MODEL: "m" })).toBeUndefined();
  });
});

describe("trust boundary", () => {
  it("agent source has no signing or key handling", () => {
    const dir = new URL("../src/", import.meta.url);
    const source = readdirSync(dir).map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
    expect(source).not.toMatch(/Keypair|secretKey|\.sign\(|partialSign|signTransaction|sendTransaction|sendRawTransaction/);
  });
});

describe("handlers", () => {
  const handlers = agentHandlers({
    rpc: { getLatestBlockhash: async () => { throw new Error("https://rpc.example/?key=SECRET"); } },
  });
  const post = (body: unknown, type = "application/json") =>
    new Request("http://localhost", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
  const draft = { recipient: bob, amountBaseUnits: "1" };

  it("parses", async () => {
    const response = await handlers.parse(post({ message: `send 1 SOL to ${bob}` }));
    expect(await response.json()).toMatchObject({ status: "ready" });
  });
  it("refuses to build without confirmation or JSON", async () => {
    expect((await handlers.build(post({ draft, payer: alice }))).status).toBe(400);
    expect((await handlers.build(post({ draft, payer: alice, confirmed: true }, "text/plain"))).status).toBe(400);
    expect((await handlers.build(post({ draft: { ...draft, amountBaseUnits: "abc" }, payer: alice, confirmed: true }))).status).toBe(400);
  });
  it("hides internal errors", async () => {
    const response = await handlers.build(post({ draft, payer: alice, confirmed: true }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("SECRET");
  });
});
