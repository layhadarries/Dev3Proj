import { performance } from "node:perf_hooks";

export const MAX_BODY_BYTES = 32 * 1024;
const WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_KEY_LENGTH = 256;
const MAX_RECLAIM_PER_REQUEST = 32;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(publicMessage);
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private sweepIterator: Iterator<string> | undefined;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly maxBuckets = 10_000,
  ) {
    if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
      throw new RangeError("Rate-limit bucket capacity must be a positive safe integer");
    }
  }

  take(key: string, limit: number, windowMs = WINDOW_MS): number | undefined {
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > MAX_RATE_LIMIT_KEY_LENGTH ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(windowMs) ||
      windowMs < 1
    ) {
      throw new RangeError("Invalid rate-limit policy");
    }
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error("Rate-limit clock is unavailable");
    this.reclaimExpired(now);
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      if (!bucket && this.buckets.size >= this.maxBuckets) {
        return Math.max(1, Math.ceil(windowMs / 1000));
      }
      const resetAt = now + windowMs;
      if (!Number.isFinite(resetAt) || resetAt <= now) {
        throw new Error("Rate-limit clock cannot represent the configured window");
      }
      bucket = { count: 0, resetAt };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) {
      return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    }
    bucket.count += 1;
    return undefined;
  }

  private reclaimExpired(now: number): void {
    this.sweepIterator ??= this.buckets.keys();
    for (let checked = 0; checked < MAX_RECLAIM_PER_REQUEST; checked += 1) {
      const next = this.sweepIterator.next();
      if (next.done) {
        this.sweepIterator = this.buckets.keys();
        return;
      }
      const bucket = this.buckets.get(next.value);
      if (bucket && now >= bucket.resetAt) this.buckets.delete(next.value);
    }
  }
}

export class InFlightLimiter {
  private readonly activeByKey = new Map<string, number>();
  private active = 0;

  constructor(private readonly maxActive = 16) {
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
      throw new RangeError("In-flight capacity must be a positive safe integer");
    }
  }

  tryAcquire(policies: readonly { key: string; limit: number }[]): (() => void) | undefined {
    if (
      policies.length === 0 ||
      policies.some(({ key, limit }) =>
        !key ||
        key.length > MAX_RATE_LIMIT_KEY_LENGTH ||
        !Number.isSafeInteger(limit) ||
        limit < 1
      ) ||
      new Set(policies.map(({ key }) => key)).size !== policies.length
    ) {
      throw new RangeError("Invalid in-flight policy");
    }
    if (this.active >= this.maxActive || policies.some(({ key, limit }) =>
      (this.activeByKey.get(key) ?? 0) >= limit
    )) {
      return undefined;
    }

    this.active += 1;
    for (const { key } of policies) {
      this.activeByKey.set(key, (this.activeByKey.get(key) ?? 0) + 1);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      for (const { key } of policies) {
        const remaining = (this.activeByKey.get(key) ?? 1) - 1;
        if (remaining === 0) this.activeByKey.delete(key);
        else this.activeByKey.set(key, remaining);
      }
    };
  }
}

export function expectedOrigin(request: Request, configuredOrigin?: string): string {
  if (configuredOrigin) {
    let origin: URL;
    try {
      origin = new URL(configuredOrigin);
    } catch {
      throw new HttpError(503, "Server origin is misconfigured");
    }
    if (
      origin.origin !== configuredOrigin ||
      (process.env.NODE_ENV === "production" && origin.protocol !== "https:")
    ) {
      throw new HttpError(503, "Server origin is misconfigured");
    }
    return origin.origin;
  }
  if (process.env.NODE_ENV === "production") {
    throw new HttpError(503, "Server origin is not configured");
  }
  return new URL(request.url).origin;
}

export function requireSameOrigin(request: Request, configuredOrigin?: string): string {
  const expected = expectedOrigin(request, configuredOrigin);
  const originHeader = request.headers.get("origin");
  let actual: string;
  try {
    actual = new URL(originHeader ?? "").origin;
  } catch {
    throw new HttpError(403, "Cross-origin request rejected");
  }
  if (actual !== expected || originHeader !== expected) {
    throw new HttpError(403, "Cross-origin request rejected");
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") {
    throw new HttpError(403, "Cross-origin request rejected");
  }
  return expected;
}

export function clientAddress(request: Request): string {
  void request;
  // Next.js Request has no verified peer address; forwarded headers are attacker-controlled.
  return "unattributed";
}

export async function readJson<T>(
  request: Request,
  parse: (input: unknown) => T,
): Promise<T> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) {
    throw new HttpError(415, "Expected a JSON request");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new HttpError(400, "Invalid request");
    if (Number(contentLength) > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = request.body?.getReader();
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new HttpError(413, "Request body is too large");
        }
        chunks.push(value);
      }
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parse(input);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid request");
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const headers = new Headers({ "cache-control": "no-store" });
    if (error.retryAfterSeconds !== undefined) {
      headers.set("retry-after", String(error.retryAfterSeconds));
    }
    return Response.json({ error: error.publicMessage }, { status: error.status, headers });
  }
  if (error instanceof Error && /^(INVALID_CONFIRMATION|INVALID_CONFIRMATION_PHASE|CONFIRMATION_EXPIRED|AUTHENTICATED_DEVNET_SESSION_REQUIRED|INVALID_WARNING_ACKNOWLEDGEMENT|SUBMISSION_BLOCKED)$/.test(error.message)) {
    return Response.json(
      { error: "Confirmation is missing or no longer valid. Start again." },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  if (error instanceof Error && error.message === "SELF_TRANSFER") {
    return Response.json({ error: "Recipient must differ from the connected wallet." }, {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
  return Response.json({ error: "Could not complete the request" }, {
    status: 502,
    headers: { "cache-control": "no-store" },
  });
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}
