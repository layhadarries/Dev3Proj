// Explicit live integration suite. Not collected by deterministic Vitest runs.
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import assert from "node:assert/strict";

for (const scenario of [
  "match",
  "warn",
  "extra",
  "recipient",
  "amount",
  "fee",
  "tamper",
]) {
  test(`live Devnet demo: ${scenario}`, () => {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("../../scripts/demo.mjs", import.meta.url)),
          scenario,
        ],
        { encoding: "utf8", timeout: 100000 },
      ),
    );
    assert.equal(
      result.report.verdict,
      scenario === "match" ? "PASS" : scenario === "warn" ? "WARN" : "BLOCK",
    );
    if (scenario === "match" || scenario === "warn") {
      assert.ok(result.report.checkedAtSlot > 0);
      assert.equal(
        result.report.simulation.deltas[0].lamportsDelta,
        String(-500000000n - BigInt(result.report.feeLamports)),
      );
    }
    if (scenario === "warn")
      assert.equal(result.report.findings[0]?.ruleId, "RECIPIENT_NEW_ACCOUNT");
    if (scenario === "fee")
      assert.equal(result.report.findings[0]?.ruleId, "EXCESSIVE_PRIORITY_FEE");
  });
}
