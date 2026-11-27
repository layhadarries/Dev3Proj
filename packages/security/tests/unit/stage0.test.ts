import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Finding,
  type Intent,
  parseIntent,
  parseReport,
  SecurityReportSchema,
  serializeIntent,
  serializeReport,
} from "@solguard/shared";
import {
  aggregateVerdict,
  DEFAULT_SECURITY_CONFIG,
  hashMessage,
  verify,
  verifySigned,
} from "../../src/index.js";

const VALID_PAYER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const VALID_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const VALID_MINT = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const VALID_UUID = "11111111-1111-4111-8111-111111111111";

function makeValidWireIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_UUID,
    kind: "transfer",
    asset: { type: "SOL" },
    recipient: VALID_RECIPIENT,
    amountBaseUnits: "500000000",
    payer: VALID_PAYER,
    confirmedAt: 1764184960000,
    ...overrides,
  };
}

describe("Stage 0: Shared contract & wire serialization", () => {
  it("parses and serializes a valid SOL intent with bigint round-trip", () => {
    const wire = makeValidWireIntent();
    const parsed = parseIntent(wire);
    expect(parsed.amountBaseUnits).toBe(500000000n);
    expect(typeof parsed.amountBaseUnits).toBe("bigint");

    const reserialized = serializeIntent(parsed);
    expect(reserialized).toEqual(wire);
  });

  it("parses a valid SPL intent", () => {
    const wire = makeValidWireIntent({
      asset: { type: "SPL", mint: VALID_MINT },
    });
    const parsed = parseIntent(wire);
    expect(parsed.asset).toEqual({ type: "SPL", mint: VALID_MINT });
  });

  it.each([
    ["float string", "1.5"],
    ["float number", 1.5],
    ["integer number instead of string", 500],
    ["zero string", "0"],
    ["zero number", 0],
    ["negative string", "-100"],
    ["negative zero string", "-0"],
    ["leading zero string", "0100"],
    ["scientific notation", "1e9"],
    ["non-numeric string", "abc"],
    ["empty string", ""],
    ["bigint suffix", "100n"],
    ["whitespace", " 100 "],
  ])("rejects invalid amountBaseUnits (%s)", (_label, badAmount) => {
    expect(() =>
      parseIntent(makeValidWireIntent({ amountBaseUnits: badAmount }))
    ).toThrow();
  });

  it("rejects zero or negative bigint in serializeIntent", () => {
    const zeroIntent: Intent = {
      id: VALID_UUID,
      kind: "transfer",
      asset: { type: "SOL" },
      recipient: VALID_RECIPIENT,
      amountBaseUnits: 0n,
      payer: VALID_PAYER,
      confirmedAt: 1764184960000,
    };
    expect(() => serializeIntent(zeroIntent)).toThrow();
    expect(() =>
      serializeIntent({ ...zeroIntent, amountBaseUnits: -5n })
    ).toThrow();
  });

  it.each([
    ["too short", "12345"],
    ["invalid base58 char 0", "0xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
    ["invalid base58 char O", "OxKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
    ["invalid base58 char I", "IxKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
    ["invalid base58 char l", "lxKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
    ["empty", ""],
  ])("rejects invalid base58 pubkey (%s)", (_label, badKey) => {
    expect(() =>
      parseIntent(makeValidWireIntent({ recipient: badKey }))
    ).toThrow();
    expect(() => parseIntent(makeValidWireIntent({ payer: badKey }))).toThrow();
    expect(() =>
      parseIntent(
        makeValidWireIntent({ asset: { type: "SPL", mint: badKey } })
      )
    ).toThrow();
  });
});

describe("Stage 0: hashMessage", () => {
  it("is deterministic and outputs 64-char lowercase sha256 hex", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const h1 = hashMessage(bytes);
    const h2 = hashMessage(bytes);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a single byte changes", () => {
    const h1 = hashMessage(new Uint8Array([1, 2, 3]));
    const h2 = hashMessage(new Uint8Array([1, 2, 4]));
    expect(h1).not.toBe(h2);
  });
});

describe("Stage 0: aggregateVerdict truth table", () => {
  const mkFinding = (severity: Finding["severity"]): Finding => ({
    ruleId:
      severity === "BLOCK"
        ? "EXTRA_TRANSFER"
        : severity === "WARN"
          ? "RECIPIENT_NEW_ACCOUNT"
          : "FEE_BREAKDOWN",
    severity,
    title: "Test",
    summary: "Test summary",
    evidence: {},
  });

  it("returns PASS for empty findings", () => {
    expect(aggregateVerdict([])).toBe("PASS");
  });

  it("returns PASS for INFO-only findings", () => {
    expect(aggregateVerdict([mkFinding("INFO")])).toBe("PASS");
  });

  it("returns WARN for WARN-only or WARN+INFO findings", () => {
    expect(aggregateVerdict([mkFinding("WARN")])).toBe("WARN");
    expect(aggregateVerdict([mkFinding("INFO"), mkFinding("WARN")])).toBe(
      "WARN"
    );
  });

  it("returns BLOCK whenever any BLOCK finding is present", () => {
    expect(aggregateVerdict([mkFinding("BLOCK")])).toBe("BLOCK");
    expect(aggregateVerdict([mkFinding("WARN"), mkFinding("BLOCK")])).toBe(
      "BLOCK"
    );
    expect(aggregateVerdict([mkFinding("INFO"), mkFinding("BLOCK")])).toBe(
      "BLOCK"
    );
    expect(
      aggregateVerdict([
        mkFinding("INFO"),
        mkFinding("WARN"),
        mkFinding("BLOCK"),
      ])
    ).toBe("BLOCK");
  });
});

describe("Verifier failure contracts", () => {
  it("verify() blocks malformed messages with a valid schema", async () => {
    const intent = parseIntent(makeValidWireIntent());
    const msg = new Uint8Array([10, 20, 30]);
    const report = await verify(intent, msg, {
      walletPublicKey: intent.payer, network:"devnet",
      now: () => 1764184960000,
    });

    expect(report.verdict).toBe("BLOCK");
    expect(report.findings[0]?.ruleId).toBe("UNDECODABLE_MESSAGE");
    expect(report.messageHash).toBe(hashMessage(msg));
    expect(report.generatedAt).toBe(1764184960000);
    expect(() => SecurityReportSchema.parse(report)).not.toThrow();
  });

  it("verifySigned() blocks an unissued handoff", async () => {
    const intent = parseIntent(makeValidWireIntent());
    const txBytes = new Uint8Array([1, 2, 3]);
    const report = await verifySigned(
      intent,
      txBytes,
      { messageHash: hashMessage(txBytes) },
      { walletPublicKey: intent.payer, network:"devnet", now: () => 1764184960000 }
    );

    expect(report.verdict).toBe("BLOCK");
    expect(report.findings[0]?.ruleId).toBe("TX_MODIFIED");
  });

  it("exposes expected default config", () => {
    expect(DEFAULT_SECURITY_CONFIG.maxPriorityFeeLamports).toBe(100_000n);
    expect(DEFAULT_SECURITY_CONFIG.maxRequiredSignatures).toBe(1);
    expect(DEFAULT_SECURITY_CONFIG.allowDurableNonce).toBe(false);
    expect(DEFAULT_SECURITY_CONFIG.commitment).toBe("confirmed");
  });
});

describe("Stage 0: Mock SecurityReport JSON fixtures", () => {
  const mocksDir = resolve(import.meta.dirname, "../../mocks");

  it.each([
    ["pass.json", "PASS"],
    ["warn.json", "WARN"],
    ["block-extra-transfer.json", "BLOCK"],
  ] as const)("validates %s against SecurityReportSchema", (file, verdict) => {
    const raw = JSON.parse(readFileSync(resolve(mocksDir, file), "utf8"));
    const parsed = parseReport(raw);
    expect(parsed.verdict).toBe(verdict);
    expect(serializeReport(parsed)).toEqual(raw);
  });
});
