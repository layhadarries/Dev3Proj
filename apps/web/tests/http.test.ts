import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { POST } from "../app/api/[...path]/route";
import {
  clientAddress,
  errorResponse,
  expectedOrigin,
  HttpError,
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
    expect(clientAddress(request({ "x-forwarded-for": "192.0.2.1, 198.51.100.2" }))).toBe("192.0.2.1");
    expect(clientAddress(request({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientAddress(request({ "x-forwarded-for": "attacker", "x-real-ip": "192.0.2.2" }))).toBe("unknown");
    expect(clientAddress(request())).toBe("unknown");
  });

  it("enforces rate limits at capacity and reclaims expired buckets", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now, 1);
    expect(limiter.take("one", 1)).toBeUndefined();
    expect(limiter.take("two", 1)).toBe(60);
    now += 60_000;
    expect(limiter.take("two", 1)).toBeUndefined();
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
