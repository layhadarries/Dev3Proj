/* global Response */
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyHttps } from "./verify-https.mjs";

const origin = "https://solguard.example";
function mockDeployment({ sameNonce = false, unsafe = false, authStatus = 401, redirect = false } = {}) {
  const requests = [];
  let pages = 0;
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    if (url.pathname === "/") {
      pages += 1;
      const nonce = "'nonce-" + (sameNonce ? "same" : "page" + pages) + "'";
      return new Response("<html></html>", { status: redirect ? 302 : 200, headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": [
          "default-src 'self'",
          "script-src 'self' 'strict-dynamic' " + nonce + (unsafe ? " 'unsafe-eval'" : ""),
          "style-src 'self' " + nonce,
          "script-src-attr 'none'", "style-src-attr 'none'", "connect-src 'self'",
          "object-src 'none'", "base-uri 'self'", "form-action 'self'",
          "frame-src 'none'", "frame-ancestors 'none'", "upgrade-insecure-requests",
        ].join("; "),
        "strict-transport-security": "max-age=31536000",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
      } });
    }
    const status = url.pathname === "/api/solguard-smoke-unknown" ? 404 :
      init.headers.origin !== origin || init.headers["sec-fetch-site"] !== "same-origin" ? 403 : authStatus;
    return new Response(JSON.stringify({ error: "synthetic" }), { status, headers: {
      "content-type": "application/json", "cache-control": "no-store",
    } });
  };
  return { fetcher, requests };
}

test("checks a compliant ingress using seven bounded credential-free requests", async () => {
  const { fetcher, requests } = mockDeployment();
  const checks = await verifyHttps(origin, fetcher);
  assert.equal(checks.length, 25);
  assert.ok(checks.every(x => x.passed));
  assert.equal(requests.length, 7);
  for (const { url, init } of requests) {
    assert.equal(url.origin, origin);
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    assert.ok(init.signal);
    assert.ok(!init.headers?.cookie && !init.headers?.authorization);
    assert.ok(url.pathname === "/" || url.pathname === "/api/parse" || url.pathname === "/api/solguard-smoke-unknown");
    if (init.method === "POST") assert.equal(init.body, "{}");
  }
});

test("flags nonce reuse, unsafe CSP, redirects and unexpected auth success", async () => {
  const { fetcher } = mockDeployment({ sameNonce: true, unsafe: true, authStatus: 200, redirect: true });
  const checks = await verifyHttps(origin, fetcher);
  const failed = checks.filter(x => !x.passed).map(x => x.name);
  assert.ok(failed.includes("CSP nonce refreshed"));
  assert.ok(failed.includes("Page 1 enforced production CSP"));
  assert.ok(failed.includes("Page 1 HTTP 200 HTML"));
  assert.ok(failed.includes("Unauthenticated parse HTTP 401"));
});

test("rejects malformed or non-HTTPS deployment origins before any request", async () => {
  for (const value of ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com/?token=x", "https://example.com/#fragment"]) {
    const { fetcher, requests } = mockDeployment();
    await assert.rejects(verifyHttps(value, fetcher));
    assert.equal(requests.length, 0);
  }
});
