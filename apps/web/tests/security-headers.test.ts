import { describe, expect, it } from "vitest";
import { createSecurityHeaders } from "../lib/server/security-headers";

describe("HTTP security headers", () => {
  const nonce = "dGVzdC1ub25jZQ==";

  it("sets a restrictive nonce-based production CSP and browser protections", () => {
    const headers = createSecurityHeaders(nonce, new URL("https://solguard.example/"), true);
    const csp = headers.get("content-security-policy") ?? "";

    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(csp).toContain("style-src-attr 'none'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("permissions-policy")).toContain("camera=()");
    expect(headers.get("permissions-policy")).toContain("geolocation=()");
  });

  it("enables only the exact development HMR websocket and omits HSTS", () => {
    const headers = createSecurityHeaders(nonce, new URL("http://localhost:3000/"), false);
    const csp = headers.get("content-security-policy") ?? "";

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'self' ws://localhost:3000");
    expect(csp).not.toContain("ws://*");
    expect(headers.has("strict-transport-security")).toBe(false);
  });

  it("omits HSTS on production HTTP requests", () => {
    const headers = createSecurityHeaders(nonce, new URL("http://solguard.example/"), true);

    expect(headers.has("strict-transport-security")).toBe(false);
  });
});
