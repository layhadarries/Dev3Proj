/* global URL, AbortSignal */
import process from "node:process";
import { pathToFileURL } from "node:url";

// Owner-authorized Devnet deployment only. No wallet, cookies, signing or submission.
export async function verifyHttps(target, fetcher = globalThis.fetch) {
  const url = new URL(target);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Supply the authorized HTTPS application origin only.");
  }
  const checks = [];
  const record = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  async function request(path, init = {}) {
    const response = await fetcher(new URL(path, url), {
      ...init, redirect: "manual", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    // Only response headers are needed. Do not log body, cookies or nonce values.
    if (response.body) await response.body.cancel();
    return response;
  }

  function checkPage(response, label) {
    record(label + " HTTP 200 HTML", response.status === 200 &&
      /^text\/html(?:;|$)/i.test(response.headers.get("content-type") ?? ""));
    const directives = new Map();
    let unique = true;
    for (const raw of (response.headers.get("content-security-policy") ?? "").split(";")) {
      const [key, ...values] = raw.trim().split(/\s+/);
      if (!key) continue;
      if (directives.has(key)) unique = false;
      directives.set(key, values);
    }
    const exact = (key, ...expected) => {
      const actual = directives.get(key) ?? [];
      return actual.length === expected.length && expected.every(value => actual.includes(value));
    };
    const script = directives.get("script-src") ?? [];
    const nonces = script.filter(value => /^'nonce-[A-Za-z0-9+/_=-]+'$/.test(value));
    const nonce = nonces[0];
    record(label + " enforced production CSP", unique && nonces.length === 1 &&
      exact("default-src", "'self'") &&
      exact("script-src", "'self'", "'strict-dynamic'", nonce) &&
      exact("style-src", "'self'", nonce) &&
      exact("script-src-attr", "'none'") && exact("style-src-attr", "'none'") &&
      exact("connect-src", "'self'") && exact("object-src", "'none'") &&
      exact("base-uri", "'self'") && exact("form-action", "'self'") &&
      exact("frame-src", "'none'") && exact("frame-ancestors", "'none'") &&
      directives.has("upgrade-insecure-requests") &&
      (directives.get("upgrade-insecure-requests") ?? []).length === 0);
    const hsts = response.headers.get("strict-transport-security") ?? "";
    const maxAge = /(?:^|;)\s*max-age=(\d+)\s*(?:;|$)/i.exec(hsts);
    record(label + " HSTS", maxAge && Number(maxAge[1]) >= 31_536_000);
    record(label + " anti-framing", response.headers.get("x-frame-options")?.toUpperCase() === "DENY");
    record(label + " nosniff", response.headers.get("x-content-type-options")?.toLowerCase() === "nosniff");
    record(label + " referrer policy", response.headers.get("referrer-policy") === "no-referrer");
    const permissions = (response.headers.get("permissions-policy") ?? "").split(",").map(x => x.trim());
    record(label + " restricted permissions", ["camera", "microphone", "geolocation", "payment"].every(
      name => permissions.includes(name + "=()")));
    return nonce;
  }

  const firstNonce = checkPage(await request("/"), "Page 1");
  const secondNonce = checkPage(await request("/"), "Page 2");
  record("CSP nonce refreshed", firstNonce && secondNonce && firstNonce !== secondNonce);

  async function denied(name, path, origin, site, expected) {
    const headers = { "content-type": "application/json", "sec-fetch-site": site };
    if (origin !== undefined) headers.origin = origin;
    // Deliberately no valid intent, wallet, credentials, signature or transaction.
    const response = await request(path, { method: "POST", headers, body: "{}" });
    record(name + " HTTP " + expected, response.status === expected);
    record(name + " JSON/no-store",
      /^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "") &&
      (response.headers.get("cache-control") ?? "").split(",").some(x => x.trim().toLowerCase() === "no-store"));
  }
  await denied("Unauthenticated parse", "/api/parse", url.origin, "same-origin", 401);
  await denied("Missing origin", "/api/parse", undefined, "same-origin", 403);
  await denied("Cross-origin", "/api/parse", "https://example.invalid", "cross-site", 403);
  await denied("Cross-site metadata", "/api/parse", url.origin, "cross-site", 403);
  await denied("Unknown route", "/api/solguard-smoke-unknown", url.origin, "same-origin", 404);
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/verify-https.mjs https://YOUR-AUTHORIZED-DEVNET-ORIGIN");
    const results = await verifyHttps(process.argv[2]);
    for (const { name, passed } of results) process.stdout.write((passed ? "PASS " : "FAIL ") + name + "\n");
    const passed = results.filter(x => x.passed).length;
    process.stdout.write(passed + "/" + results.length + " ingress checks passed. No live wallet or transaction tested.\n");
    if (passed !== results.length) process.exitCode = 1;
  } catch {
    process.stderr.write("HTTPS smoke check could not complete. Supply an authorized HTTPS origin and check connectivity/configuration.\n");
    process.exitCode = 1;
  }
}
