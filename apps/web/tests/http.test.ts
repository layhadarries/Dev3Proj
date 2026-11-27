import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { POST } from "../app/api/[...path]/route";
import { dispatchApiRoute } from "../lib/server/route-dispatch";
import {
  clientAddress,
  errorResponse,
  expectedOrigin,
  HttpError,
  InFlightLimiter,
  jsonResponse,
  RateLimiter,
  readJson,
  requireSameOrigin,
} from "../lib/server/http";

function request(headers: HeadersInit = {}, body?: string): Request {
  return new Request("https://solguard.example/api/test", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) }),
    ...(body === undefined ? {} : { body }),
  });
}

describe("HTTP security boundaries", () => {
  it("dispatches only registered API routes and returns a consistent 404 for inherited names", async () => {
    const validRoutes = [
      "session/challenge",
      "session",
      "session/logout",
      "parse",
      "stage",
      "confirm",
      "build",
      "explain",
      "acknowledge",
      "handoff",
      "submit",
    ];
    for (const route of validRoutes) {
      const response = await POST(request({ origin: "https://solguard.example" }, "{}"), {
        params: Promise.resolve({ path: route.split("/") }),
      });
      expect(response.status).not.toBe(404);
    }

    const unsupported = [
      "",
      "unknown",
      "session/challenge/extra",
      "Constructor",
      "constructor",
      "prototype",
      "__proto__",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "SESSION",
      "session/CHALLENGE",
      "session//challenge",
    ];
    for (const route of unsupported) {
      const direct = await dispatchApiRoute(route, request());
      expect(direct.status).toBe(404);
      expect(direct.headers.get("content-type")).toContain("application/json");
      expect(direct.headers.get("cache-control")).toBe("no-store");
      expect(await direct.json()).toEqual({ error: "Not found" });
    }

    for (const path of [undefined, [], ["session", ""], ["", "session"], ["session", 42]]) {
      const response = await POST(request(), {
        params: Promise.resolve({ path }),
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("dispatches the sign-in challenge route and rejects unknown paths", async () => {
    const body = JSON.stringify({ wallet: Keypair.generate().publicKey.toBase58() });
    const request = new Request("http://localhost/api/session/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body,
    });
    const challenge = await POST(request, { params: Promise.resolve({ path: ["session", "challenge"] }) });
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toHaveProperty("message");

    const missing = await POST(request, { params: Promise.resolve({ path: ["not-found"] }) });
    expect(missing.status).toBe(404);
  });

  it("fails closed for malformed or insecure production origins", () => {
    expect(() => expectedOrigin(request(), "not a URL")).toThrow(HttpError);
    expect(() => expectedOrigin(request(), "https://solguard.example/")).toThrow(HttpError);

    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => expectedOrigin(request())).toThrow(HttpError);
      expect(() => expectedOrigin(request(), "http://solguard.example")).toThrow(HttpError);
      expect(expectedOrigin(request(), "https://solguard.example")).toBe("https://solguard.example");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires an exact same-origin header and rejects invalid fetch-site metadata", () => {
    expect(requireSameOrigin(request({ origin: "https://solguard.example" }))).toBe("https://solguard.example");
    expect(() => requireSameOrigin(request())).toThrow(HttpError);
    expect(() => requireSameOrigin(request({ origin: "https://solguard.example/" }))).toThrow(HttpError);
    expect(() => requireSameOrigin(request({
      origin: "https://solguard.example",
      "sec-fetch-site": "same-site",
    }))).toThrow(HttpError);
  });

  it("uses only validated client address values", () => {
    const identity = clientAddress(request());
    const headerCases: HeadersInit[] = [
      { "x-forwarded-for": "192.0.2.1" },
      { "x-forwarded-for": "198.51.100.2, 192.0.2.1" },
      { "x-forwarded-for": "2001:db8::1" },
      { "x-forwarded-for": "2001:db8::1, [::1]" },
      { "x-forwarded-for": "999.1.1.1" },
      { "x-forwarded-for": "attacker", "x-real-ip": "192.0.2.2" },
      { "x-real-ip": "2001:db8::1" },
      { "x-forwarded-for": "x".repeat(4096) },
    ];
    for (const headers of headerCases) {
      expect(clientAddress(request(headers))).toBe(identity);
    }
    expect(identity).toBe("unattributed");
  });

  it("enforces rate limits at exact boundaries, rejects bad policies and recovers expired keys", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now, 2);
    expect(limiter.take("one", 1)).toBeUndefined();
    expect(limiter.take("one", 1)).toBe(60);
    expect(limiter.take("two", 1)).toBeUndefined();
    expect(limiter.take("three", 1)).toBe(60);
    now += 60_000;
    expect(limiter.take("three", 1)).toBeUndefined();
    expect(limiter.take("two", 1)).toBeUndefined();
    expect(() => limiter.take("bad", 0)).toThrow(RangeError);
    expect(() => limiter.take("x".repeat(257), 1)).toThrow(RangeError);
    expect(() => limiter.take("bad", 1, 0)).toThrow(RangeError);
    expect(() => new RateLimiter(() => now, 0)).toThrow(RangeError);
  });

  it("does not grant quota when its clock moves backwards", () => {
    let now = 100;
    const limiter = new RateLimiter(() => now, 1);
    expect(limiter.take("wallet:a", 1, 1_000)).toBeUndefined();
    now = 50;
    expect(limiter.take("wallet:a", 1, 1_000)).toBe(2);
  });

  it("fails closed when the clock cannot represent a future quota window", () => {
    const limiter = new RateLimiter(() => Number.MAX_VALUE);
    expect(() => limiter.take("global", 1)).toThrow(/cannot represent/);
  });

  it("bounds and periodically reclaims limiter storage without evicting active quotas", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now, 2);
    expect(limiter.take("active", 2, 10_000)).toBeUndefined();
    expect(limiter.take("expired-a", 1, 1)).toBeUndefined();
    expect(limiter.take("new", 1, 1)).toBe(1);
    now = 1;
    expect(limiter.take("new", 1, 1)).toBeUndefined();
    expect(limiter.take("active", 2, 10_000)).toBeUndefined();
    expect(limiter.take("active", 2, 10_000)).toBe(10);
  });

  it("atomically caps in-flight work and releases once after completion or failure", () => {
    const limiter = new InFlightLimiter(2);
    const releaseFirst = limiter.tryAcquire([
      { key: "all", limit: 2 },
      { key: "parse", limit: 1 },
    ]);
    expect(releaseFirst).toBeTypeOf("function");
    expect(limiter.tryAcquire([
      { key: "all", limit: 2 },
      { key: "parse", limit: 1 },
    ])).toBeUndefined();
    const releaseSecond = limiter.tryAcquire([
      { key: "all", limit: 2 },
      { key: "build", limit: 2 },
    ]);
    expect(releaseSecond).toBeTypeOf("function");
    expect(limiter.tryAcquire([{ key: "all", limit: 2 }])).toBeUndefined();
    releaseFirst?.();
    releaseFirst?.();
    expect(limiter.tryAcquire([
      { key: "all", limit: 2 },
      { key: "parse", limit: 1 },
    ])).toBeTypeOf("function");
    releaseSecond?.();
    expect(() => new InFlightLimiter(0)).toThrow(RangeError);
    expect(() => limiter.tryAcquire([{ key: "same", limit: 1 }, { key: "same", limit: 1 }])).toThrow(RangeError);
  });

  it("rejects malformed length and JSON while accepting valid JSON", async () => {
    const invalidLength = request({ "content-length": "1.5" }, "{}");
    await expect(readJson(invalidLength, (value) => value)).rejects.toMatchObject({ status: 400 });
    const malformed = request({}, "{");
    await expect(readJson(malformed, (value) => value)).rejects.toMatchObject({ status: 400 });
    await expect(readJson(request(), (value) => value)).rejects.toMatchObject({ status: 400 });
    await expect(readJson(new Request("https://solguard.example", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }), (value) => value)).rejects.toMatchObject({ status: 415 });
    await expect(readJson(request({}, "{\"ok\":true}"), (value) => value)).resolves.toEqual({ ok: true });
  });

  it("keeps internal errors private and marks API responses non-cacheable", async () => {
    const internal = errorResponse(new Error("secret-bearing internal detail"));
    expect(internal.status).toBe(502);
    expect(await internal.json()).toEqual({ error: "Could not complete the request" });

    const limited = errorResponse(new HttpError(429, "Slow down", 7));
    expect(limited.headers.get("retry-after")).toBe("7");
    expect(limited.headers.get("cache-control")).toBe("no-store");

    const response = jsonResponse({ ok: true }, { headers: { "x-test": "present" } });
    expect(response.headers.get("x-test")).toBe("present");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
