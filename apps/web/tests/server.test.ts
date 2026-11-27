import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import type { RpcClient } from "@solguard/security";
import { describe, expect, it, vi } from "vitest";
import { createApplicationHandlers, type ApplicationDependencies } from "../lib/server/application";
import { InFlightLimiter, RateLimiter } from "../lib/server/http";
import { SessionStore } from "../lib/server/sessions";

const origin = "http://localhost:3000";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  const encoded: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < encoded.length; index += 1) {
      const value = (encoded[index] ?? 0) * 256 + carry;
      encoded[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      encoded.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return "1".repeat(leadingZeroes) + encoded.reverse().map((digit) => BASE58_ALPHABET[digit]).join("");
}

function expectedSignature(signedBytes: Uint8Array): string {
  const transaction = VersionedTransaction.deserialize(Buffer.from(signedBytes));
  const signature = transaction.signatures[0];
  if (!signature) throw new Error("Missing transaction signature");
  return base58Encode(signature);
}

function request(route: string, body: unknown, options: {
  cookie?: string;
  origin?: string;
  contentType?: string;
  fetchSite?: string;
  forwardedFor?: string;
} = {}) {
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json",
    origin: options.origin ?? origin,
    "x-forwarded-for": options.forwardedFor ?? "192.0.2.10",
  });
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.fetchSite) headers.set("sec-fetch-site", options.fetchSite);
  return new Request(`${origin}/api/${route}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function signatureFor(wallet: Keypair, message: string): string {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, wallet.secretKey.subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(message, "utf8"), key).toString("base64");
}

interface RpcPauses {
  beforeFresh?: (call: number) => Promise<void>;
  beforeSimulate?: () => Promise<void>;
}

function verificationRpc(transferLamports: bigint, pauses: RpcPauses = {}): RpcClient {
  const context = { slot: 100 };
  const payerAfter = 5_000n;
  const recipientAfter = 2n + transferLamports;
  let freshCalls = 0;
  const simulation = {
    err: null,
    fee: 5_000n,
    preBalances: [transferLamports + 10_000n, 2n, 1n],
    postBalances: [payerAfter, recipientAfter, 1n],
    accounts: [payerAfter, recipientAfter].map((lamports) => ({
      owner: "11111111111111111111111111111111" as const,
      executable: false as const,
      lamports,
      data: ["", "base64"] as ["", "base64"],
    })),
    innerInstructions: [],
    preTokenBalances: [],
    postTokenBalances: [],
    replacementBlockhash: null,
    logs: ["mock simulation"],
    unitsConsumed: 150,
  };
  return {
    identity: async () => ({ network: "devnet", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }),
    fresh: async (hash) => {
      freshCalls += 1;
      await pauses.beforeFresh?.(freshCalls);
      return { network: "devnet", commitment: "confirmed", blockhash: hash, slot: 100n };
    },
    fee: async () => ({ context, value: 5_000n }),
    simulate: async () => {
      await pauses.beforeSimulate?.();
      return { context, value: simulation };
    },
  };
}

function deferredCall() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await waiting;
    },
  };
}

async function signIn(
  handlers: ReturnType<typeof createApplicationHandlers>,
  wallet = Keypair.generate(),
  options: { origin?: string; cookie?: string } = {},
) {
  const challengeResponse = await handlers.challenge(request("session/challenge", { wallet: wallet.publicKey.toBase58() }, options));
  const { message } = await challengeResponse.json();
  const response = await handlers.signIn(request("session", {
    wallet: wallet.publicKey.toBase58(),
    signature: signatureFor(wallet, message),
  }, options));
  return { wallet, response, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] };
}

async function submitPreparedTransaction(
  options: Pick<ApplicationDependencies, "getSignatureStatus" | "now" | "sleep" | "submit">,
) {
  return withSpendLimit("1000000000", async () => {
    const owner = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    let submittedBytes: Uint8Array | undefined;
    const submit = vi.fn(async (bytes: Uint8Array) => {
      submittedBytes = Buffer.from(bytes);
      if (options.submit) return options.submit(bytes);
      else {
        submittedBytes = Buffer.from(bytes);
        return expectedSignature(bytes);
      }
    });
    const app = handlers({
      ...options,
      rpc: verificationRpc(8n),
      blockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 123,
      }),
      submit,
    });
    const { cookie } = await signIn(app, owner);
    const staged = await app.stage(request("stage", {
      recipient: recipient.toBase58(),
      amountBaseUnits: "8",
    }, { cookie }));
    const { id } = await staged.json();
    await app.confirm(request("confirm", { id }, { cookie }));
    const built = await app.build(request("build", { confirmationId: id }, { cookie }));
    const { transaction } = await built.json();
    const handoff = await app.handoff(request("handoff", { id }, { cookie }));
    const { wire } = await handoff.json();
    const signed = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
    expect(Buffer.from(signed.message.serialize()).toString("base64")).toBe(transaction.messageBase64);
    signed.sign([owner]);
    const signedBase64 = Buffer.from(signed.serialize()).toString("base64");
    const submitRequest = () => request("submit", { id, signed: signedBase64 }, { cookie });
    const response = await app.submit(submitRequest());

    return {
      response,
      signedBase64,
      submit,
      submittedBytes,
      retry: () => app.submit(submitRequest()),
    };
  });
}

function handlers(options: ApplicationDependencies = {}) {
  return createApplicationHandlers({ allowedOrigin: origin, ...options });
}

async function withSpendLimit<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.SOLGUARD_MAX_SPEND_LAMPORTS;
  if (value === undefined) delete process.env.SOLGUARD_MAX_SPEND_LAMPORTS;
  else process.env.SOLGUARD_MAX_SPEND_LAMPORTS = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.SOLGUARD_MAX_SPEND_LAMPORTS;
    else process.env.SOLGUARD_MAX_SPEND_LAMPORTS = previous;
  }
}

describe("wallet challenge authentication", () => {
  it("verifies the one-time origin- and wallet-bound signature and issues an HttpOnly session cookie", async () => {
    const app = handlers({ sessions: new SessionStore(Date.now, true) });
    const { wallet, response, cookie } = await signIn(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wallet: wallet.publicKey.toBase58() });
    expect(response.headers.get("set-cookie")).toMatch(/^__Host-solguard_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=3600; Secure$/);
    expect(cookie).toBeTruthy();
    expect((await app.stage(request("stage", {
      recipient: Keypair.generate().publicKey.toBase58(),
      amountBaseUnits: "1",
    }, { cookie })).then((result) => result.status))).toBe(200);
  });

  it("rejects forged, replayed, expired, and wrong-origin signatures", async () => {
    const app = handlers();
    const wallet = Keypair.generate();
    const message = (await (await app.challenge(request("session/challenge", {
      wallet: wallet.publicKey.toBase58(),
    }))).json()).message as string;
    const signInBody = {
      wallet: wallet.publicKey.toBase58(),
      signature: signatureFor(wallet, message),
    };
    expect((await app.signIn(request("session", signInBody, { origin: "http://attacker.example" }))).status).toBe(403);
    expect((await app.signIn(request("session", { ...signInBody, signature: Buffer.alloc(64).toString("base64") }))).status).toBe(401);
    expect((await app.signIn(request("session", signInBody))).status).toBe(200);
    expect((await app.signIn(request("session", signInBody))).status).toBe(401);

    let now = 1_000;
    const expiring = handlers({ now: () => now });
    const nextWallet = Keypair.generate();
    const challenge = (await (await expiring.challenge(request("session/challenge", {
      wallet: nextWallet.publicKey.toBase58(),
    }))).json()).message as string;
    now += 5 * 60 * 1000;
    expect((await expiring.signIn(request("session", {
      wallet: nextWallet.publicKey.toBase58(),
      signature: signatureFor(nextWallet, challenge),
    }))).status).toBe(401);
  });

  it("does not accept a challenge signed for another origin", async () => {
    const wallet = Keypair.generate();
    const sharedSessions = new SessionStore();
    const original = createApplicationHandlers({ allowedOrigin: origin, sessions: sharedSessions });
    const otherOrigin = "https://other.example";
    const other = createApplicationHandlers({ allowedOrigin: otherOrigin, sessions: sharedSessions });
    const challenge = (await (await original.challenge(request("session/challenge", {
      wallet: wallet.publicKey.toBase58(),
    }))).json()).message as string;
    const response = await other.signIn(request("session", {
      wallet: wallet.publicKey.toBase58(),
      signature: signatureFor(wallet, challenge),
    }, { origin: otherOrigin }));
    expect(response.status).toBe(401);
  });

  it("revokes the previous same-wallet session when a new one is issued", async () => {
    const app = handlers();
    const previous = await signIn(app);
    const rotated = await signIn(app, previous.wallet, { cookie: previous.cookie });
    const draft = { recipient: Keypair.generate().publicKey.toBase58(), amountBaseUnits: "1" };
    expect((await app.stage(request("stage", draft, { cookie: previous.cookie }))).status).toBe(401);
    expect((await app.stage(request("stage", draft, { cookie: rotated.cookie }))).status).toBe(200);
  });

  it("revokes the current server session and expires its cookie on logout", async () => {
    const app = handlers();
    const { cookie } = await signIn(app);
    const response = await app.logout(request("session/logout", {}, { cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await app.stage(request("stage", {
      recipient: Keypair.generate().publicKey.toBase58(),
      amountBaseUnits: "1",
    }, { cookie }))).status).toBe(401);
  });
});

describe("request boundaries", () => {
  it("rejects missing, cross-origin, and cross-site request metadata", async () => {
    const app = handlers();
    expect((await app.challenge(request("session/challenge", { wallet: Keypair.generate().publicKey.toBase58() }, { origin: "" }))).status).toBe(403);
    expect((await app.challenge(request("session/challenge", { wallet: Keypair.generate().publicKey.toBase58() }, { origin: "http://evil.example" }))).status).toBe(403);
    expect((await app.challenge(request("session/challenge", { wallet: Keypair.generate().publicKey.toBase58() }, { fetchSite: "cross-site" }))).status).toBe(403);
    expect((await app.challenge(request("session/challenge", { wallet: Keypair.generate().publicKey.toBase58() }, { contentType: "text/plain" }))).status).toBe(415);
  });

  it("bounds streamed bodies and rejects invalid or over-posted JSON", async () => {
    const app = handlers();
    const wallet = Keypair.generate().publicKey.toBase58();
    const oversized = request("session/challenge", "x".repeat(32 * 1024 + 1));
    expect((await app.challenge(oversized)).status).toBe(413);
    const declaredTooLarge = new Request(`${origin}/api/session/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "content-length": String(32 * 1024 + 1) },
      body: "{}",
    });
    expect((await app.challenge(declaredTooLarge)).status).toBe(413);
    expect((await app.challenge(request("session/challenge", { wallet, injected: true }))).status).toBe(400);
    expect((await app.stage(request("stage", {
      recipient: Keypair.generate().publicKey.toBase58(),
      amountBaseUnits: "1",
    }))).status).toBe(401);
    const { cookie } = await signIn(app);
    expect((await app.stage(request("stage", {
      recipient: Keypair.generate().publicKey.toBase58(),
      amountBaseUnits: "0",
    }, { cookie }))).status).toBe(400);
  });

  it("rejects unauthenticated, malformed, and expired session cookies", async () => {
    let now = 10_000;
    const app = handlers({ now: () => now });
    const draft = { recipient: Keypair.generate().publicKey.toBase58(), amountBaseUnits: "1" };
    expect((await app.stage(request("stage", draft))).status).toBe(401);
    const { cookie } = await signIn(app);
    expect(cookie).toBeTruthy();
    expect((await app.stage(request("stage", draft, { cookie: "solguard_session=not-a-token" }))).status).toBe(401);
    now += 60 * 60 * 1000;
    expect((await app.stage(request("stage", draft, { cookie }))).status).toBe(401);
  });

  it("rejects malformed and out-of-u64 server spend-limit configuration at startup", () => {
    for (const invalid of ["", "01", "-1", "1.0", "18446744073709551616"]) {
      const previous = process.env.SOLGUARD_MAX_SPEND_LAMPORTS;
      process.env.SOLGUARD_MAX_SPEND_LAMPORTS = invalid;
      try {
        expect(() => createApplicationHandlers()).toThrow(/SOLGUARD_MAX_SPEND_LAMPORTS/);
      } finally {
        if (previous === undefined) delete process.env.SOLGUARD_MAX_SPEND_LAMPORTS;
        else process.env.SOLGUARD_MAX_SPEND_LAMPORTS = previous;
      }
    }
  });
});

describe("confirmation authorization and abuse controls", () => {
  it("binds staged confirmation IDs to the authenticated wallet session", async () => {
    const app = handlers();
    const first = await signIn(app);
    const second = await signIn(app);
    const draft = {
      recipient: Keypair.generate().publicKey.toBase58(),
      amountBaseUnits: "999",
    };
    const staged = await app.stage(request("stage", draft, { cookie: first.cookie }));
    const card = await staged.json();
    expect(staged.status).toBe(200);
    expect((await app.confirm(request("confirm", { id: card.id }, { cookie: second.cookie }))).status).toBe(409);
    const confirmed = await app.confirm(request("confirm", { id: card.id }, { cookie: first.cookie }));
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).intent.payer).toBe(first.wallet.publicKey.toBase58());
  });

  it("checks session ownership at build, acknowledgement, handoff and submit", async () => {
    const submit = vi.fn(async () => "should-not-run");
    const app = handlers({ submit });
    const owner = await signIn(app);
    const foreign = await signIn(app);
    const staged = await app.stage(request("stage", {
      recipient: Keypair.generate().publicKey.toBase58(),
      amountBaseUnits: "5",
    }, { cookie: owner.cookie }));
    const { id } = await staged.json();
    expect((await app.confirm(request("confirm", { id }, { cookie: owner.cookie }))).status).toBe(200);
    expect((await app.build(request("build", { confirmationId: id }, { cookie: foreign.cookie }))).status).toBe(409);
    expect((await app.acknowledge(request("acknowledge", { id }, { cookie: foreign.cookie }))).status).toBe(409);
    expect((await app.handoff(request("handoff", { id }, { cookie: foreign.cookie }))).status).toBe(409);
    expect((await app.submit(request("submit", {
      id,
      signed: Buffer.alloc(64).toString("base64"),
    }, { cookie: foreign.cookie }))).status).toBe(409);
    expect(submit).not.toHaveBeenCalled();
  });

  it("rate-limits independently by key and resets after its window", () => {
    let now = 100;
    const limiter = new RateLimiter(() => now, 2);
    expect(limiter.take("one", 2, 1_000)).toBeUndefined();
    expect(limiter.take("one", 2, 1_000)).toBeUndefined();
    expect(limiter.take("one", 2, 1_000)).toBe(1);
    expect(limiter.take("two", 2, 1_000)).toBeUndefined();
    now += 1_000;
    expect(limiter.take("one", 2, 1_000)).toBeUndefined();
  });

  it("rate-limits unauthenticated challenge attempts by client and wallet", async () => {
    const app = handlers();
    let limited = false;
    for (let index = 0; index < 13; index += 1) {
      const response = await app.challenge(request("session/challenge", {
        wallet: Keypair.generate().publicKey.toBase58(),
      }, { forwardedFor: `198.51.100.${index + 1}` }));
      if (response.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });

  it("limits claimed-wallet sign-in attempts before signature verification", async () => {
    const app = handlers();
    const wallet = Keypair.generate().publicKey.toBase58();
    const challenge = await app.challenge(request("session/challenge", { wallet }));
    expect(challenge.status).toBe(200);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.signIn(request("session", {
        wallet,
        signature: Buffer.alloc(64).toString("base64"),
      }, { forwardedFor: `198.51.100.${attempt + 1}` }));
      expect(response.status).toBe(401);
    }
    const limited = await app.signIn(request("session", {
      wallet,
      signature: Buffer.alloc(64).toString("base64"),
    }, { forwardedFor: "198.51.100.250" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("rejects malformed parse requests before invoking the AI model", async () => {
    let modelCalls = 0;
    const app = handlers({
      llm: {
        complete: async () => {
          modelCalls += 1;
          return "{}";
        },
      },
    });
    const { cookie } = await signIn(app);
    expect((await app.parse(request("parse", { message: 42 }, { cookie }))).status).toBe(400);
    expect((await app.parse(request("parse", { message: "x".repeat(32 * 1024 + 1) }, { cookie }))).status).toBe(413);
    expect(modelCalls).toBe(0);
  });

  it("keeps per-wallet parse quotas across session rotation and aggregates many wallets globally", async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    let modelCalls = 0;
    const app = handlers({
      llm: {
        complete: async () => {
          modelCalls += 1;
          return JSON.stringify({ action: "transfer", asset: "SOL", amount: "0.5", recipient });
        },
      },
    });
    const first = await signIn(app);
    const parse = (cookie: string, ip: number) => app.parse(request("parse", {
      message: `could you move 0.5 SOL over to ${recipient} for me`,
    }, { cookie, forwardedFor: `203.0.113.${ip}` }));

    for (let index = 0; index < 30; index += 1) {
      expect((await parse(first.cookie!, index + 1)).status).toBe(200);
    }
    expect(modelCalls).toBe(30);

    const rotated = await signIn(app, first.wallet, { cookie: first.cookie });
    const walletLimited = await parse(rotated.cookie!, 100);
    expect(walletLimited.status).toBe(429);
    expect(walletLimited.headers.get("retry-after")).toBeTruthy();
    expect(modelCalls).toBe(30);

    let globalModelCalls = 0;
    const globalApp = handlers({
      llm: {
        complete: async () => {
          globalModelCalls += 1;
          return JSON.stringify({ action: "transfer", asset: "SOL", amount: "0.5", recipient });
        },
      },
    });
    const second = await signIn(globalApp);
    for (let index = 0; index < 30; index += 1) {
      expect((await globalApp.parse(request("parse", {
        message: `could you move 0.5 SOL over to ${recipient} for me`,
      }, { cookie: second.cookie, forwardedFor: `203.0.113.${index + 101}` }))).status).toBe(200);
    }
    const third = await signIn(globalApp);
    for (let index = 0; index < 30; index += 1) {
      expect((await globalApp.parse(request("parse", {
        message: `could you move 0.5 SOL over to ${recipient} for me`,
      }, { cookie: third.cookie, forwardedFor: `203.0.113.${index + 131}` }))).status).toBe(200);
    }
    const fourth = await signIn(globalApp);
    const globalLimited = await globalApp.parse(request("parse", {
      message: `could you move 0.5 SOL over to ${recipient} for me`,
    }, { cookie: fourth.cookie, forwardedFor: "203.0.113.250" }));
    expect(globalLimited.status).toBe(429);
    expect(globalLimited.headers.get("retry-after")).toBeTruthy();
    expect(globalModelCalls).toBe(60);
  });

  it("rejects excess concurrent AI work before model invocation and releases capacity after failure", async () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const pause = deferredCall();
    let modelCalls = 0;
    const app = handlers({
      inFlightLimiter: new InFlightLimiter(1),
      llm: {
        complete: async () => {
          modelCalls += 1;
          if (modelCalls === 1) {
            await pause.wait();
            throw new Error("mock model failure");
          }
          return JSON.stringify({ action: "transfer", asset: "SOL", amount: "0.5", recipient });
        },
      },
    });
    const { cookie } = await signIn(app);
    const parseRequest = () => request("parse", {
      message: `could you move 0.5 SOL over to ${recipient} for me`,
    }, { cookie });

    const first = app.parse(parseRequest());
    await pause.entered;
    const concurrent = await app.parse(parseRequest());
    expect(concurrent.status).toBe(429);
    expect(concurrent.headers.get("retry-after")).toBe("1");
    expect(modelCalls).toBe(1);

    pause.release();
    expect((await first).status).toBe(200);
    expect((await app.parse(parseRequest())).status).toBe(200);
    expect(modelCalls).toBe(2);
  });

  it("rejects excess concurrent transaction builds before another RPC call", async () => {
    const pause = deferredCall();
    const rpc = verificationRpc(8n);
    const simulate = vi.spyOn(rpc, "simulate");
    let blockhashCalls = 0;
    const blockhash = vi.fn(async () => ({
      blockhash: await (async () => {
        blockhashCalls += 1;
        if (blockhashCalls === 1) {
          await pause.wait();
          throw new Error("mock RPC failure");
        }
        return Keypair.generate().publicKey.toBase58();
      })(),
      lastValidBlockHeight: 123,
    }));
    const app = handlers({ rpc, blockhash, inFlightLimiter: new InFlightLimiter(1) });
    const { cookie } = await signIn(app);
    const stageAndConfirm = async () => {
      const staged = await app.stage(request("stage", {
        recipient: Keypair.generate().publicKey.toBase58(),
        amountBaseUnits: "8",
      }, { cookie }));
      const { id } = await staged.json();
      expect((await app.confirm(request("confirm", { id }, { cookie }))).status).toBe(200);
      return id as string;
    };
    const firstId = await stageAndConfirm();
    const secondId = await stageAndConfirm();

    const firstBuild = app.build(request("build", { confirmationId: firstId }, { cookie }));
    await pause.entered;
    const rejected = await app.build(request("build", { confirmationId: secondId }, { cookie }));
    expect(rejected.status).toBe(429);
    expect(blockhash).toHaveBeenCalledTimes(1);
    expect(simulate).not.toHaveBeenCalled();

    pause.release();
    expect((await firstBuild).status).toBe(502);
    expect((await app.build(request("build", { confirmationId: secondId }, { cookie }))).status).toBe(200);
    expect(blockhash).toHaveBeenCalledTimes(2);
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed signed transaction input before transport", async () => {
    const submit = vi.fn(async () => "should-not-run");
    const app = handlers({ submit });
    const { cookie } = await signIn(app);
    expect((await app.submit(request("submit", {
      id: randomUUID(),
      signed: "not base64!",
    }, { cookie }))).status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it("completes the server-owned flow through a mocked transport after gateway verification", async () => {
    const owner = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const blockhash = Keypair.generate().publicKey.toBase58();
    let signedSnapshot = Buffer.alloc(0);
    const submit = vi.fn(async (bytes: Uint8Array) => {
      signedSnapshot = Buffer.from(bytes);
      return expectedSignature(bytes);
    });
    let expected = "";
    const getSignatureStatus = vi.fn(async (signature: string) => {
      expected = signature;
      return {
        slot: 123,
        confirmations: 1,
        err: null,
        confirmationStatus: "confirmed" as const,
      };
    });
    await withSpendLimit("1000000000", async () => {
    const app = handlers({
      rpc: verificationRpc(8n),
      blockhash: async () => ({ blockhash, lastValidBlockHeight: 123 }),
      submit,
      getSignatureStatus,
    });
    const { cookie } = await signIn(app, owner);
    const staged = await app.stage(request("stage", {
      recipient: recipient.toBase58(),
      amountBaseUnits: "8",
    }, { cookie }));
    const card = await staged.json();
    expect(staged.status).toBe(200);
    expect((await app.confirm(request("confirm", { id: card.id }, { cookie }))).status).toBe(200);

    const builtResponse = await app.build(request("build", { confirmationId: card.id }, { cookie }));
    expect(builtResponse.status).toBe(200);
    const { transaction, report } = await builtResponse.json();
    expect(report.verdict).toBe("PASS");
    const explanation = await app.explain(request("explain", report, { cookie }));
    expect((await explanation.json()).verdict).toBe("PASS");

    const handoff = await app.handoff(request("handoff", { id: card.id }, { cookie }));
    expect(handoff.status).toBe(200);
    const { wire } = await handoff.json();
    const signed = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
    expect(Buffer.from(signed.message.serialize()).toString("base64")).toBe(transaction.messageBase64);
    signed.sign([owner]);
    const signedBase64 = Buffer.from(signed.serialize()).toString("base64");
    const submitted = await app.submit(request("submit", { id: card.id, signed: signedBase64 }, { cookie }));
    expect(submitted.status).toBe(200);
    const submittedJson = await submitted.json();
    expect(submittedJson.signature).toBe(expected);
    expect(signedSnapshot.toString("base64")).toBe(signedBase64);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(getSignatureStatus).toHaveBeenCalledWith(expected);
    });
  });

  it("reports an on-chain transaction error as failed", async () => {
    const result = await submitPreparedTransaction({
      getSignatureStatus: async () => ({
        slot: 123,
        confirmations: 1,
        err: { InstructionError: [0, { Custom: 1 }] },
        confirmationStatus: "confirmed",
      }),
    });

    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error).toMatch(/Transaction failed on Devnet/);
    expect(result.submit).toHaveBeenCalledTimes(1);
    expect(Buffer.from(result.submittedBytes ?? []).toString("base64")).toBe(result.signedBase64);
  });

  it("reports a timed-out signature status as unconfirmed and never resubmits", async () => {
    let time = 1_000;
    const getSignatureStatus = vi.fn(async () => null);
    const result = await submitPreparedTransaction({
      getSignatureStatus,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });

    expect(result.response.status).toBe(504);
    expect((await result.response.json()).error).toMatch(/unconfirmed.*timed out.*Do not submit again/);
    expect(getSignatureStatus).toHaveBeenCalled();
    expect(result.submit).toHaveBeenCalledTimes(1);
    expect((await result.retry()).status).toBe(409);
    expect(result.submit).toHaveBeenCalledTimes(1);
  });

  it("reports a Devnet RPC confirmation error as unconfirmed and never resubmits", async () => {
    const getSignatureStatus = vi.fn(async () => {
      throw new Error("RPC unavailable");
    });
    const result = await submitPreparedTransaction({ getSignatureStatus });

    expect(result.response.status).toBe(504);
    expect((await result.response.json()).error).toMatch(/unconfirmed.*Devnet RPC could not confirm.*Do not submit again/);
    expect(getSignatureStatus).toHaveBeenCalledTimes(1);
    expect(result.submit).toHaveBeenCalledTimes(1);
    expect((await result.retry()).status).toBe(409);
    expect(result.submit).toHaveBeenCalledTimes(1);
  });

  it("reconciles an ambiguous send exception through the derived signature and confirms success", async () => {
    const submit = vi.fn(async (bytes: Uint8Array) => {
      expect(bytes.length).toBeGreaterThan(0);
      throw new Error("socket closed after broadcast");
    });
    const getSignatureStatus = vi.fn(async (signature: string) => ({
      slot: 123,
      confirmations: 1,
      err: null,
      confirmationStatus: "confirmed" as const,
      signature,
    }));
    const result = await submitPreparedTransaction({ submit, getSignatureStatus });

    expect(result.response.status).toBe(200);
    const responseJson = await result.response.json();
    expect(responseJson.signature).toBe(getSignatureStatus.mock.calls[0]?.[0]);
    expect(result.submit).toHaveBeenCalledTimes(1);
    expect(result.submittedBytes).toBeDefined();
    expect(getSignatureStatus).toHaveBeenCalledWith(
      expectedSignature(result.submittedBytes ?? new Uint8Array()),
    );
    expect((await result.retry()).status).toBe(409);
    expect(result.submit).toHaveBeenCalledTimes(1);
  });

  it("rejects a submission RPC signature that differs from the verified signed bytes", async () => {
    const submit = vi.fn(async (bytes: Uint8Array) => {
      expect(bytes.length).toBeGreaterThan(0);
      return "different-rpc-signature";
    });
    const getSignatureStatus = vi.fn(async () => null);
    const result = await submitPreparedTransaction({ submit, getSignatureStatus });

    expect(result.response.status).toBe(504);
    expect((await result.response.json()).error).toMatch(/different signature.*unconfirmed.*Do not submit again/);
    expect(result.submit).toHaveBeenCalledTimes(1);
    expect(getSignatureStatus).not.toHaveBeenCalled();
    expect((await result.retry()).status).toBe(409);
    expect(result.submit).toHaveBeenCalledTimes(1);
  });

  it("reconciles an ambiguous send exception and reports an on-chain failure", async () => {
    const submit = vi.fn(async (bytes: Uint8Array) => {
      expect(bytes.length).toBeGreaterThan(0);
      throw new Error("socket closed after broadcast");
    });
    const getSignatureStatus = vi.fn(async () => ({
      slot: 123,
      confirmations: 1,
      err: { InstructionError: [0, { Custom: 1 }] },
      confirmationStatus: "confirmed" as const,
    }));
    const result = await submitPreparedTransaction({ submit, getSignatureStatus });

    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error).toMatch(/Transaction failed on Devnet/);
    expect(result.submit).toHaveBeenCalledTimes(1);
    expect(getSignatureStatus).toHaveBeenCalledWith(
      expectedSignature(result.submittedBytes ?? new Uint8Array()),
    );
  });

  it("enforces below, exact, above and fee-inclusive spend limits through stage and build/inspect", async () => {
    await withSpendLimit("1000000000", async () => {
      const scenarios = [
        { amount: 999_994_999n, verdict: "PASS" },
        { amount: 999_995_000n, verdict: "PASS" },
        { amount: 999_995_001n, verdict: "BLOCK" },
        { amount: 999_999_999n, verdict: "BLOCK" },
      ] as const;
      for (const scenario of scenarios) {
        const wallet = Keypair.generate();
        const recipient = Keypair.generate().publicKey;
        const blockhash = Keypair.generate().publicKey.toBase58();
        const app = handlers({
          rpc: verificationRpc(scenario.amount),
          blockhash: async () => ({ blockhash, lastValidBlockHeight: 123 }),
        });
        const { cookie } = await signIn(app, wallet);
        const draft = { recipient: recipient.toBase58(), amountBaseUnits: scenario.amount.toString() };
        expect((await app.stage(request("stage", {
          ...draft,
          maxSpendLamports: "0",
        }, { cookie }))).status).toBe(400);
        const staged = await app.stage(request("stage", draft, { cookie }));
        const { id } = await staged.json();
        expect((await app.build(request("build", {
          confirmationId: id,
          maxSpendLamports: "0",
        }, { cookie }))).status).toBe(400);
        expect((await app.confirm(request("confirm", { id }, { cookie }))).status).toBe(200);
        const built = await app.build(request("build", { confirmationId: id }, { cookie }));
        expect(built.status).toBe(200);
        const { report } = await built.json();
        expect(report.verdict).toBe(scenario.verdict);
        if (scenario.verdict === "BLOCK") {
          expect(report.findings.map((finding: { ruleId: string }) => finding.ruleId)).toContain("AMOUNT_MISMATCH");
          expect((await app.handoff(request("handoff", { id }, { cookie }))).status).toBe(409);
        }
      }
    });
  });

  it("uses the one-SOL default when the server spend-limit variable is unset", async () => {
    await withSpendLimit(undefined, async () => {
      const amount = 999_995_001n;
      const wallet = Keypair.generate();
      const recipient = Keypair.generate().publicKey;
      const blockhash = Keypair.generate().publicKey.toBase58();
      const app = handlers({
        rpc: verificationRpc(amount),
        blockhash: async () => ({ blockhash, lastValidBlockHeight: 123 }),
      });
      const { cookie } = await signIn(app, wallet);
      const staged = await app.stage(request("stage", {
        recipient: recipient.toBase58(),
        amountBaseUnits: amount.toString(),
      }, { cookie }));
      const { id } = await staged.json();
      await app.confirm(request("confirm", { id }, { cookie }));
      const response = await app.build(request("build", { confirmationId: id }, { cookie }));
      expect((await response.json()).report.verdict).toBe("BLOCK");
    });
  });

  it.each(["inspect", "handoff", "submit"] as const)(
    "re-resolves the current server session after delayed %s and blocks revoked-session transport",
    async (phase) => {
      await withSpendLimit("1000000000", async () => {
        const owner = Keypair.generate();
        const recipient = Keypair.generate().publicKey;
        const blockhash = Keypair.generate().publicKey.toBase58();
        const pause = deferredCall();
        const pauses: RpcPauses = phase === "inspect"
          ? { beforeSimulate: pause.wait }
          : { beforeFresh: async (call) => {
            const targetCall = phase === "handoff" ? 2 : 3;
            if (call === targetCall) await pause.wait();
          } };
        const submit = vi.fn(async () => "should-not-submit");
        const app = handlers({
          rpc: verificationRpc(8n, pauses),
          blockhash: async () => ({ blockhash, lastValidBlockHeight: 123 }),
          submit,
        });
        const { cookie } = await signIn(app, owner);
        const staged = await app.stage(request("stage", {
          recipient: recipient.toBase58(),
          amountBaseUnits: "8",
        }, { cookie }));
        const { id } = await staged.json();
        await app.confirm(request("confirm", { id }, { cookie }));

        let pending: Promise<Response>;
        if (phase === "inspect") {
          pending = app.build(request("build", { confirmationId: id }, { cookie }));
        } else {
          const built = await app.build(request("build", { confirmationId: id }, { cookie }));
          expect(built.status).toBe(200);
          const handoffRequest = app.handoff(request("handoff", { id }, { cookie }));
          if (phase === "handoff") {
            pending = handoffRequest;
          } else {
            const handoff = await handoffRequest;
            expect(handoff.status).toBe(200);
            const { wire } = await handoff.json();
            const signed = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
            signed.sign([owner]);
            pending = app.submit(request("submit", {
              id,
              signed: Buffer.from(signed.serialize()).toString("base64"),
            }, { cookie }));
          }
        }

        await pause.entered;
        const logout = await app.logout(request("session/logout", {}, { cookie }));
        expect(logout.status).toBe(200);
        pause.release();
        const response = await pending;
        expect(response.status).toBe(409);
        expect(submit).not.toHaveBeenCalled();
      });
    },
  );
});
