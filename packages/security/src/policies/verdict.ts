import type { Finding, Verdict } from "@solguard/shared";

/**
 * Single source of truth for computing the report verdict from findings:
 * - Any BLOCK finding => "BLOCK"
 * - Otherwise any WARN finding => "WARN"
 * - Otherwise => "PASS"
 */
export function aggregateVerdict(findings: readonly Finding[]): Verdict {
  let hasWarn = false;
  for (const finding of findings) {
    if (finding.severity === "BLOCK") {
      return "BLOCK";
    }
    if (finding.severity === "WARN") {
      hasWarn = true;
    }
  }
  return hasWarn ? "WARN" : "PASS";
}
