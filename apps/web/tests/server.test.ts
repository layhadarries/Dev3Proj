import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { Keypair, Message, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { RpcClient } from "@solguard/security";
import bs58 from "bs58";
import { describe, expect, it, vi } from "vitest";
import { confirmSignature, createApplicationHandlers, createDevnetSubmissionTransport, type ApplicationDependencies } from "../lib/server/application";
import { HttpError, InFlightLimiter, RateLimiter } from "../lib/server/http";
import { SessionStore } from "../lib/server/sessions";

const origin = "http://localhost:3000";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function expectedSignature(signedBytes: Uint8Array): string {
  const transaction = VersionedTransaction.deserialize(Buffer.from(signedBytes));
  const signature = transaction.signatures[0];
  if (!signature) throw new Error("Missing transaction signature");
  return bs58.encode(signature);
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
  // 10,000 spare, less the 5,000 base fee and the 1 lamport priority fee.
  const payerAfter = 4_999n;
  const recipientAfter = 2n + transferLamports;
  let freshCalls = 0;
  return {
    identity: async () => ({ network: "devnet", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }),
    fresh: async (hash) => {
      freshCalls += 1;
      await pauses.beforeFresh?.(freshCalls);
      return { network: "devnet", commitment: "confirmed", blockhash: hash, slot: 100n };
    },
    fee: async () => ({ context, value: 5_001n }),
    simulate: async (encoded) => {
      await pauses.beforeSimulate?.();
      let keyCount = 4;
      try {
        keyCount = Message.from(Buffer.from(encoded, "base64")).staticAccountKeys.length;
      } catch {
        // Keep a conservative fixture width if the test RPC receives unexpected bytes.
      }
      const preBalances = Array.from({ length: keyCount }, () => 1n);
      const postBalances = Array.from({ length: keyCount }, () => 1n);
      preBalances[0] = transferLamports + 10_000n;
      preBalances[1] = 2n;
      postBalances[0] = payerAfter;
      postBalances[1] = recipientAfter;
      const simulation = {
        err: null,
        fee: 5_001n,
        preBalances,
        postBalances,
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

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function signIn(
  handlers: ReturnType<typeof createApplicationHandlers>,
  wallet = Keypair.generate(),
  options: { origin?: string; cookie?: string } = {},
) {
  const challengeResponse = await handlers.challenge(request("session/challenge", { wallet: wallet.publicKey.toBase58() }, options));
  const { message } = await challengeResponse.json();
  const challengeCookie = challengeResponse.headers.get("set-cookie")?.split(";", 1)[0];
  const cookies = [challengeCookie, options.cookie].filter((cookie): cookie is string => Boolean(cookie)).join("; ");
  const response = await handlers.signIn(request("session", {
    wallet: wallet.publicKey.toBase58(),
    signature: signatureFor(wallet, message),
  }, { ...options, cookie: cookies || undefined }));
  return { wallet, response, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] };
}

async function submitPreparedTransaction(
  options: Pick<ApplicationDependencies, "getSignatureStatus" | "now" | "sleep" | "submit" | "broadcastTimeoutMs" | "confirmationTimeoutMs">,
) {
  return withSpendLimit("1000000000", async () => {
    const owner = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    let submittedBytes: Uint8Array | undefined;
    const submit = vi.fn(async (bytes: Uint8Array, signal: AbortSignal) => {
      submittedBytes = Buffer.from(bytes);
      if (options.submit) return options.submit(bytes, signal);
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

describe("SDK submission transport", () => {
  function mockTransport(firstStatus: number) {
    const sends: string[] = [];
    const submit = createDevnetSubmissionTransport(async (input, init) => {
      expect(String(input)).toBe("https://api.devnet.solana.com");
      if (typeof init?.body !== "string") throw new Error("Expected JSON-RPC request body");
      const rpc = JSON.parse(init.body);
      expect(rpc.method).toBe("sendTransaction");
      expect(rpc.params[1]).toMatchObject({
        encoding: "base64",
        maxRetries: 0,
        preflightCommitment: "confirmed",
      });
      // The SDK leaves skipPreflight out when it is false, so preflight stays on unless it is sent.
      expect(rpc.params[1].skipPreflight).toBeUndefined();
      const wire = rpc.params[0] as string;
      sends.push(wire);
      if (sends.length === 1 && firstStatus !== 200) {
        return new Response("synthetic RPC failure", { status: firstStatus });
      }
      // A retry would receive a valid receipt, making the attempt-count assertion essential.
      const transaction = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: bs58.encode(transaction.signatures[0]!),
      });
    });
    return { submit, sends };
  }

  for (const firstStatus of [200, 429, 500, 503]) {
    it(`makes exactly one SDK HTTP send attempt for HTTP ${firstStatus} and reconciles the original signature`, async () => {
      const { submit, sends } = mockTransport(firstStatus);
      const getSignatureStatus = vi.fn<NonNullable<ApplicationDependencies["getSignatureStatus"]>>(async () => ({
        slot: 123,
        confirmations: 1,
        err: null,
        confirmationStatus: "confirmed" as const,
      }));
      const result = await submitPreparedTransaction({ submit, getSignatureStatus });
      const signed = VersionedTransaction.deserialize(Buffer.from(result.signedBase64, "base64"));
      const expected = bs58.encode(signed.signatures[0]!);

      expect(result.response.status).toBe(200);
      expect(await result.response.json()).toEqual({ signature: expected });
      expect(getSignatureStatus).toHaveBeenCalledWith(expected);
      expect(sends).toEqual([result.signedBase64]);
      expect((await result.retry()).status).toBe(409);
      expect(sends).toEqual([result.signedBase64]);
    });
  }

  it("aborts the SDK HTTP request at the broadcast deadline and reconciles without resending", async () => {
    let time = 1_000;
    let observedSignal: AbortSignal | null | undefined;
    const transport = vi.fn<NonNullable<Parameters<typeof createDevnetSubmissionTransport>[0]>>(
      async (_input, init) => {
        observedSignal = init?.signal;
        if (!observedSignal) throw new Error("Expected a per-submission abort signal");
        const signal = observedSignal;
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new Error("HTTP request aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    );
    const getSignatureStatus = vi.fn<NonNullable<ApplicationDependencies["getSignatureStatus"]>>(async () => null);
    const result = await submitPreparedTransaction({
      submit: createDevnetSubmissionTransport(transport),
      getSignatureStatus,
      broadcastTimeoutMs: 20,
      confirmationTimeoutMs: 1_000,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(result.response.status).toBe(504);
    expect((await result.response.json()).error).toMatch(/unconfirmed.*broadcast timed out.*Do not submit again/);
    expect(getSignatureStatus).toHaveBeenCalledWith(expectedSignature(result.submittedBytes ?? new Uint8Array()));
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await result.retry()).status).toBe(409);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps simultaneous SDK transport abort signals isolated", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const observed: (AbortSignal | null | undefined)[] = [];
    const submit = createDevnetSubmissionTransport(async (_input, init) => {
      observed.push(init?.signal);
      if (typeof init?.body !== "string") throw new Error("Expected JSON-RPC body");
      const rpc = JSON.parse(init.body);
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: bs58.encode(new Uint8Array(64).fill(1)) });
    });
    await Promise.all([
      submit(new Uint8Array([1]), first.signal),
      submit(new Uint8Array([2]), second.signal),
    ]);
    expect(observed).toEqual([first.signal, second.signal]);
    first.abort();
    expect(second.signal.aborted).toBe(false);
  });

  it("keeps an unreconciled HTTP 429 submission unknown without a second SDK send", async () => {
    let time = 1_000;
    const { submit, sends } = mockTransport(429);
    const getSignatureStatus = vi.fn<NonNullable<ApplicationDependencies["getSignatureStatus"]>>(async () => null);
    const result = await submitPreparedTransaction({
      submit,
      getSignatureStatus,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
      confirmationTimeoutMs: 1_000,
    });
    const signed = VersionedTransaction.deserialize(Buffer.from(result.signedBase64, "base64"));
    const expected = bs58.encode(signed.signatures[0]!);

    expect(result.response.status).toBe(504);
    expect((await result.response.json()).error).toMatch(/unconfirmed.*Do not submit again/);
    expect(getSignatureStatus).toHaveBeenCalledWith(expected);
    expect(sends).toEqual([result.signedBase64]);
    expect((await result.retry()).status).toBe(409);
    expect(sends).toEqual([result.signedBase64]);
  });
});

describe("transaction commitment classification", () => {
  const confirmedSuccess = {
    slot: 100,
    confirmations: 2,
    err: null,
    confirmationStatus: "confirmed" as const,
  };
  const finalizedSuccess = {
    slot: 101,
    confirmations: null,
    err: null,
    confirmationStatus: "finalized" as const,
  };
  const confirmedFailure = {
    slot: 102,
    confirmations: 1,
    err: { InstructionError: [0, { Custom: 1 }] },
    confirmationStatus: "confirmed" as const,
  };
  const finalizedFailure = {
    slot: 103,
    confirmations: null,
    err: { InstructionError: [0, { Custom: 2 }] },
    confirmationStatus: "finalized" as const,
  };
  const processedSuccess = {
    slot: 99,
    confirmations: 0,
    err: null,
    confirmationStatus: "processed" as const,
  };
  const processedFailure = {
    slot: 99,
    confirmations: 0,
    err: { InstructionError: [0, { Custom: 1 }] },
    confirmationStatus: "processed" as const,
  };

  function clock() {
    let time = 1_000;
    return {
      now: () => time,
      sleep: async (milliseconds: number) => { time += milliseconds; },
    };
  }

  it("continues from processed success and processed failure to confirmed success", async () => {
    for (const processed of [processedSuccess, processedFailure]) {
      let call = 0;
      const getStatus = vi.fn(async () => call++ === 0 ? processed : confirmedSuccess);
      const { now, sleep } = clock();
      expect(await confirmSignature("signature", getStatus, now, sleep)).toEqual({ outcome: "confirmed" });
      expect(getStatus).toHaveBeenCalledTimes(2);
    }
  });

  it("continues from processed failure to confirmed and finalized failure", async () => {
    for (const terminal of [confirmedFailure, finalizedFailure]) {
      let call = 0;
      const getStatus = vi.fn(async () => call++ === 0 ? processedFailure : terminal);
      const { now, sleep } = clock();
      expect(await confirmSignature("signature", getStatus, now, sleep)).toEqual({ outcome: "failed" });
      expect(getStatus).toHaveBeenCalledTimes(2);
    }
  });

  it("continues after missing status and returns timeout for persistent processed success or failure", async () => {
    for (const processed of [processedSuccess, processedFailure]) {
      let call = 0;
      const getStatus = vi.fn(async () => call++ === 0 ? null : processed);
      const { now, sleep } = clock();
      expect(await confirmSignature("signature", getStatus, now, sleep)).toEqual({
        outcome: "unconfirmed",
        reason: "timeout",
      });
      expect(getStatus.mock.calls.length).toBeGreaterThan(1);
    }
  });

  it("accepts direct confirmed and finalized success/failure only at those commitments", async () => {
    for (const [status, outcome] of [
      [confirmedSuccess, "confirmed"],
      [finalizedSuccess, "confirmed"],
      [confirmedFailure, "failed"],
      [finalizedFailure, "failed"],
    ] as const) {
      const { now, sleep } = clock();
      expect(await confirmSignature("signature", vi.fn(async () => status), now, sleep)).toEqual({
        outcome,
      });
    }
  });

  it("classifies known string-form ledger errors only with terminal commitment evidence", async () => {
    for (const err of ["AccountNotFound", "BlockhashNotFound", "InsufficientFundsForFee"]) {
      for (const status of [confirmedFailure, finalizedFailure, {
        slot: 103, confirmations: null, err,
      }]) {
        const { now, sleep } = clock();
        const getStatus = vi.fn(async () => ({ ...status, err }));
        expect(await confirmSignature("signature", getStatus, now, sleep)).toEqual({ outcome: "failed" });
        expect(getStatus).toHaveBeenCalledTimes(1);
      }
      const { now, sleep } = clock();
      const getStatus = vi.fn(async () => ({ ...processedFailure, err }));
      expect(await confirmSignature("signature", getStatus, now, sleep, 1_000)).toEqual({
        outcome: "unconfirmed", reason: "timeout",
      });
    }
  });

  it("continues from a processed string-form failure to confirmed success", async () => {
    let call = 0;
    const getStatus = vi.fn(async () => call++ === 0
      ? { ...processedFailure, err: "AccountNotFound" }
      : confirmedSuccess);
    const { now, sleep } = clock();
    expect(await confirmSignature("signature", getStatus, now, sleep)).toEqual({ outcome: "confirmed" });
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("keeps malformed or unknown error variants and contradictory legacy metadata provisional", async () => {
    for (const status of [
      { ...finalizedFailure, err: "" },
      { ...finalizedFailure, err: "malformed" },
      { ...finalizedFailure, err: [] },
      { ...finalizedFailure, err: {} },
      { ...finalizedFailure, err: "InstructionError" },
      { ...confirmedFailure, confirmations: 0, err: "AccountNotFound" },
      { slot: -1, confirmations: null, err: "AccountNotFound" },
      { slot: 103, confirmations: null, err: "unknown variant" },
      { ...processedFailure, confirmations: null, err: "AccountNotFound" },
    ]) {
      const { now, sleep } = clock();
      expect(await confirmSignature("signature", vi.fn(async () => status as never), now, sleep, 1_000)).toEqual({
        outcome: "unconfirmed", reason: "timeout",
      });
    }
  });

  it("rejects contradictory and malformed confirmation metadata conservatively", async () => {
    const contradictory = [
      { ...confirmedSuccess, confirmations: 0 },
      { ...finalizedSuccess, confirmations: 0 },
      { ...confirmedSuccess, confirmations: -1 },
      { ...confirmedSuccess, confirmationStatus: "unknown" },
      { ...confirmedSuccess, confirmationStatus: "confirmed", slot: -1 },
      { ...confirmedSuccess, err: "malformed" },
      { ...confirmedSuccess, err: undefined },
    ];
    for (const status of contradictory) {
      const { now, sleep } = clock();
      const getStatus = vi.fn(async () => status as never);
      expect(await confirmSignature("signature", getStatus, now, sleep)).toEqual({
        outcome: "unconfirmed",
        reason: "timeout",
      });
    }
  });

  it("requires evidence for missing, malformed and contradictory status objects", async () => {
    const malformed = [
      null,
      {},
      { confirmationStatus: "confirmed", err: null, confirmations: "many" },
      { confirmationStatus: "finalized", err: null, slot: "unknown" },
      { confirmationStatus: "confirmed", err: null, confirmations: null, slot: null },
    ];
    for (const status of malformed) {
      const { now, sleep } = clock();
      expect(await confirmSignature("signature", vi.fn(async () => status as never), now, sleep)).toEqual({
        outcome: "unconfirmed",
        reason: "timeout",
      });
    }
  });

  it("returns RPC polling failure, not transaction failure", async () => {
    const { now, sleep } = clock();
    expect(await confirmSignature(
      "signature",
      vi.fn(async () => { throw new Error("RPC unavailable"); }),
      now,
      sleep,
    )).toEqual({ outcome: "unconfirmed", reason: "rpc" });
  });

  it("returns timeout for a response that arrives only after the deadline", async () => {
    const late = deferredPromise<typeof confirmedSuccess>();
    const resultPromise = confirmSignature(
      "signature",
      vi.fn(async () => late.promise as never),
      () => 1_000,
      async () => undefined,
      5,
    );
    expect(await resultPromise).toEqual({ outcome: "unconfirmed", reason: "timeout" });
    late.resolve(confirmedSuccess);
    await Promise.resolve();
  });
});

describe("wallet challenge authentication", () => {
  it("uses secure __Host pre-auth cookies in production and non-Secure cookies in development", () => {
    const secure = new SessionStore(Date.now, true);
    expect(secure.authContextCookieName).toBe("__Host-solguard_auth_context");
    expect(secure.authContextCookieHeader("A".repeat(43))).toContain("__Host-solguard_auth_context=");
    expect(secure.authContextCookieHeader("A".repeat(43))).toContain("; Secure");
    const development = new SessionStore(Date.now, false);
    expect(development.authContextCookieName).toBe("solguard_auth_context");
    expect(development.authContextCookieHeader("A".repeat(43))).not.toContain("; Secure");
  });

  it("binds a challenge to the initiating browser context and rejects a different browser", async () => {
    const app = handlers();
    const wallet = Keypair.generate();
    const browserA = await app.challenge(request("session/challenge", {
      wallet: wallet.publicKey.toBase58(),
    }));
    expect(browserA.status).toBe(200);
    const contextA = browserA.headers.get("set-cookie")?.split(";", 1)[0];
    const message = (await browserA.json()).message as string;

    expect((await app.signIn(request("session", {
      wallet: wallet.publicKey.toBase58(),
      signature: signatureFor(wallet, message),
    }))).status).toBe(401);
    expect((await app.signIn(request("session", {
      wallet: wallet.publicKey.toBase58(),
      signature: signatureFor(wallet, message),
    }, { cookie: contextA }))).status).toBe(200);
  });

  it("rejects missing, forged and expired authentication contexts", async () => {
    let now = 1_000;
    const app = handlers({ now: () => now });
    const wallet = Keypair.generate();
    const challengeResponse = await app.challenge(request("session/challenge", {
      wallet: wallet.publicKey.toBase58(),
    }));
    const context = challengeResponse.headers.get("set-cookie")?.split(";", 1)[0];
    const message = (await challengeResponse.json()).message as string;
    const signature = signatureFor(wallet, message);

    expect((await app.signIn(request("session", {
      wallet: wallet.publicKey.toBase58(),
      signature,
    }, { cookie: "solguard_auth_context=not-a-token" }))).status).toBe(401);
    expect((await app.signIn(request("session", {
      wallet: wallet.publicKey.toBase58(),
      signature,
    }, { cookie: "solguard_auth_context=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }))).status).toBe(401);

    now += 10 * 60 * 1000;
    expect((await app.signIn(request("session", {
      wallet: wallet.publicKey.toBase58(),
      signature,
    }, { cookie: context }))).status).toBe(401);
  });

  it("allows one browser to consume a challenge concurrently only once", async () => {
    const app = handlers();
    const wallet = Keypair.generate();
    const challengeResponse = await app.challenge(request("session/challenge", {
      wallet: wallet.publicKey.toBase58(),
    }));
    const context = challengeResponse.headers.get("set-cookie")?.split(";", 1)[0];
    const message = (await challengeResponse.json()).message as string;
    const body = {
      wallet: wallet.publicKey.toBase58(),
      signature: signatureFor(wallet, message),
    };
    const first = app.signIn(request("session", body, { cookie: context }));
    const second = app.signIn(request("session", body, { cookie: context }));
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  });

  it("does not let challenge exhaustion or claimed-wallet abuse target the owner's browser", async () => {
    const app = handlers();
    const owner = Keypair.generate();
    const ownerWallet = owner.publicKey.toBase58();

    let attackerContext = "";
    for (let index = 0; index < 3; index += 1) {
      const response = await app.challenge(request("session/challenge", { wallet: ownerWallet }, {
        cookie: attackerContext || undefined,
      }));
      expect(response.status).toBe(200);
      attackerContext = response.headers.get("set-cookie")?.split(";", 1)[0] ?? attackerContext;
    }
    expect(attackerContext).toBeTruthy();
    expect((await app.challenge(request("session/challenge", { wallet: ownerWallet }, {
      cookie: attackerContext,
    }))).status).toBe(429);

    const ownerChallenge = await app.challenge(request("session/challenge", { wallet: ownerWallet }));
    expect(ownerChallenge.status).toBe(200);
    const ownerContext = ownerChallenge.headers.get("set-cookie")?.split(";", 1)[0];
    const ownerMessage = (await ownerChallenge.json()).message as string;
    expect((await app.signIn(request("session", {
      wallet: ownerWallet,
      signature: signatureFor(owner, ownerMessage),
    }, { cookie: ownerContext }))).status).toBe(200);
  });

  it("allows multiple browsers to authenticate the same wallet with separate challenges", async () => {
    const app = handlers();
    const wallet = Keypair.generate();
    const firstChallenge = await app.challenge(request("session/challenge", {
      wallet: wallet.publicKey.toBase58(),
    }));
    const secondChallenge = await app.challenge(request("session/challenge", {
      wallet: wallet.publicKey.toBase58(),
    }));
    const firstContext = firstChallenge.headers.get("set-cookie")?.split(";", 1)[0];
    const secondContext = secondChallenge.headers.get("set-cookie")?.split(";", 1)[0];
    const firstMessage = (await firstChallenge.json()).message as string;
    const secondMessage = (await secondChallenge.json()).message as string;

    expect((await app.signIn(request("session", {
      wallet: wallet.publicKey.toBase58(),
      signature: signatureFor(wallet, firstMessage),
    }, { cookie: firstContext }))).status).toBe(200);
    expect((await app.signIn(request("session", {
      wallet: wallet.publicKey.toBase58(),
      signature: signatureFor(wallet, secondMessage),
    }, { cookie: secondContext }))).status).toBe(200);
  });

  it("rejects wrong-wallet, replayed and wrong-origin challenge signatures", async () => {
    const app = handlers();
    const challengedWallet = Keypair.generate();
    const wrongWallet = Keypair.generate();
    const challengeResponse = await app.challenge(request("session/challenge", {
      wallet: challengedWallet.publicKey.toBase58(),
    }));
    const context = challengeResponse.headers.get("set-cookie")?.split(";", 1)[0];
    const message = (await challengeResponse.json()).message as string;

    expect((await app.signIn(request("session", {
      wallet: challengedWallet.publicKey.toBase58(),
      signature: signatureFor(wrongWallet, message),
    }, { cookie: context }))).status).toBe(401);
    expect((await app.signIn(request("session", {
      wallet: wrongWallet.publicKey.toBase58(),
      signature: signatureFor(wrongWallet, message),
    }, { cookie: context }))).status).toBe(401);
  });

  it("prunes expired challenges and authentication contexts without evicting live ones", async () => {
    let now = 10_000;
    const store = new SessionStore(() => now, false);
    const wallet = Keypair.generate().publicKey.toBase58();
    let context = "";
    for (let index = 0; index < 3; index += 1) {
      const issued = store.issueChallenge(wallet, origin, context
        ? new Request(origin, { headers: { cookie: `${store.authContextCookieName}=${context}` } })
        : undefined);
      expect(issued.message).toContain("Environment: Solana Devnet");
      context = issued.cookie ?? context;
    }
    let contextLimited: unknown;
    try {
      store.issueChallenge(wallet, origin, new Request(origin, {
        headers: { cookie: `${store.authContextCookieName}=${context}` },
      }));
    } catch (error) {
      contextLimited = error;
    }
    expect(contextLimited).toBeInstanceOf(HttpError);
    expect((contextLimited as HttpError).status).toBe(429);

    now += 10 * 60 * 1000 + 1;
    const liveStoreWallet = Keypair.generate().publicKey.toBase58();
    expect(store.issueChallenge(liveStoreWallet, origin).message).toContain("Solana Devnet");
  });

  it("fails closed at global challenge and authentication-context storage capacity", () => {
    const store = new SessionStore();
    const wallet = "11111111111111111111111111111111";
    let response: unknown;
    for (let index = 0; index < 10_001; index += 1) {
      try {
        store.issueChallenge(wallet, origin);
      } catch (error) {
        response = error;
        break;
      }
    }
    expect(response).toBeInstanceOf(HttpError);
    expect((response as HttpError).status).toBe(503);
  }, 60_000);
  it("verifies the one-time origin- and wallet-bound signature and issues an HttpOnly session cookie", async () => {
    const app = handlers({ sessions: new SessionStore(Date.now, true) });
    const { wallet, response, cookie } = await signIn(app);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wallet: wallet.publicKey.toBase58() });
    const setCookies = response.headers.get("set-cookie") ?? "";
    expect(setCookies).toContain("__Host-solguard_session=");
    expect(setCookies).toContain("HttpOnly; SameSite=Strict; Max-Age=3600; Secure");
    expect(setCookies).toContain("__Host-solguard_auth_context=");
    expect(setCookies).toContain("Max-Age=0");
    expect(cookie).toBeTruthy();
    expect((await app.stage(request("stage", {
      recipient: Keypair.generate().publicKey.toBase58(),
      amountBaseUnits: "1",
    }, { cookie })).then((result) => result.status))).toBe(200);
  });

  it("rejects forged, replayed, expired, and wrong-origin signatures", async () => {
    const app = handlers();
    const wallet = Keypair.generate();
    const challengeResponse = await app.challenge(request("session/challenge", {
      wallet: wallet.publicKey.toBase58(),
    }));
    const challengeCookie = challengeResponse.headers.get("set-cookie")?.split(";", 1)[0];
    const message = (await challengeResponse.json()).message as string;
    const signInBody = {
      wallet: wallet.publicKey.toBase58(),
      signature: signatureFor(wallet, message),
    };
    expect((await app.signIn(request("session", signInBody, { origin: "http://attacker.example" }))).status).toBe(403);
    expect((await app.signIn(request("session", { ...signInBody, signature: Buffer.alloc(64).toString("base64") }, { cookie: challengeCookie }))).status).toBe(401);
    expect((await app.signIn(request("session", signInBody, { cookie: challengeCookie }))).status).toBe(200);
    expect((await app.signIn(request("session", signInBody, { cookie: challengeCookie }))).status).toBe(401);

    let now = 1_000;
    const expiring = handlers({ now: () => now });
    const nextWallet = Keypair.generate();
    const expiringChallengeResponse = await expiring.challenge(request("session/challenge", {
      wallet: nextWallet.publicKey.toBase58(),
    }));
    const expiringChallengeCookie = expiringChallengeResponse.headers.get("set-cookie")?.split(";", 1)[0];
    const challenge = (await expiringChallengeResponse.json()).message as string;
    now += 5 * 60 * 1000;
    expect((await expiring.signIn(request("session", {
      wallet: nextWallet.publicKey.toBase58(),
      signature: signatureFor(nextWallet, challenge),
    }, { cookie: expiringChallengeCookie }))).status).toBe(401);
  });

  it("does not accept a challenge signed for another origin", async () => {
    const wallet = Keypair.generate();
    const sharedSessions = new SessionStore();
    const original = createApplicationHandlers({ allowedOrigin: origin, sessions: sharedSessions });
    const otherOrigin = "https://other.example";
    const other = createApplicationHandlers({ allowedOrigin: otherOrigin, sessions: sharedSessions });
    const challengeResponse = await original.challenge(request("session/challenge", {
      wallet: wallet.publicKey.toBase58(),
    }));
    const challengeCookie = challengeResponse.headers.get("set-cookie")?.split(";", 1)[0];
    const challenge = (await challengeResponse.json()).message as string;
    const response = await other.signIn(request("session", {
      wallet: wallet.publicKey.toBase58(),
      signature: signatureFor(wallet, challenge),
    }, { origin: otherOrigin, cookie: challengeCookie }));
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

describe("external transaction analysis", () => {
  function unsignedTransfer(payer: Keypair, recipient: string, lamports = 8) {
    const transaction = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(recipient),
      lamports,
    }));
    return Buffer.concat([
      Buffer.from([1]),
      Buffer.alloc(64),
      transaction.serializeMessage(),
    ]);
  }

  it("requires a live wallet session before decoding or making RPC calls", async () => {
    const rpc = verificationRpc(8n);
    const identity = vi.spyOn(rpc, "identity");
    const app = handlers({ rpc });
    const payer = Keypair.generate();
    const recipient = Keypair.generate().publicKey.toBase58();
    const response = await app.analyze(request("analyze", {
      recipient,
      amountBaseUnits: "8",
      transactionBase64: unsignedTransfer(payer, recipient).toString("base64"),
    }));
    expect(response.status).toBe(401);
    expect(identity).not.toHaveBeenCalled();
  });

  it("does not return analysis evidence after the authenticated session is rotated during RPC", async () => {
    await withSpendLimit("1000000000", async () => {
      const payer = Keypair.generate();
      const recipient = Keypair.generate().publicKey.toBase58();
      const simulation = deferredCall();
      const rpc = verificationRpc(8n, { beforeSimulate: simulation.wait });
      const app = handlers({ rpc });
      const first = await signIn(app, payer);
      const pending = app.analyze(request("analyze", {
        recipient,
        amountBaseUnits: "8",
        transactionBase64: unsignedTransfer(payer, recipient).toString("base64"),
      }, { cookie: first.cookie }));
      await simulation.entered;
      await signIn(app, payer, { cookie: first.cookie });
      simulation.release();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "Confirmation is missing or no longer valid. Start again.",
      });
    });
  });

  it("analyzes a canonical unsigned transfer against the session wallet without signing or submitting", async () => {
    await withSpendLimit("1000000000", async () => {
      const payer = Keypair.generate();
      const recipient = Keypair.generate().publicKey.toBase58();
      const rpc = verificationRpc(8n);
      const identity = vi.spyOn(rpc, "identity");
      const fee = vi.spyOn(rpc, "fee");
      const simulate = vi.spyOn(rpc, "simulate");
      const fresh = vi.spyOn(rpc, "fresh");
      const submit = vi.fn(async () => "must-not-submit");
      const app = handlers({ rpc, submit });
      const session = await signIn(app, payer);
      const wire = unsignedTransfer(payer, recipient);
      const response = await app.analyze(request("analyze", {
        recipient,
        amountBaseUnits: "8",
        transactionBase64: wire.toString("base64"),
      }, { cookie: session.cookie }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.report).toMatchObject({
        verdict: "PASS",
        findings: [],
        feeLamports: "5001",
        simulation: { deltas: expect.arrayContaining([
          { account: payer.publicKey.toBase58(), lamportsDelta: "-5009" },
          { account: recipient, lamportsDelta: "8" },
        ]) },
      });
      expect(body.report.messageHash).toMatch(/^[0-9a-f]{64}$/);
      expect(identity).toHaveBeenCalledTimes(1);
      expect(fee).toHaveBeenCalledTimes(1);
      expect(simulate).toHaveBeenCalledTimes(1);
      expect(fresh).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  it("blocks a mismatched external transaction before simulation", async () => {
    await withSpendLimit("1000000000", async () => {
      const payer = Keypair.generate();
      const actualRecipient = Keypair.generate().publicKey.toBase58();
      const claimedRecipient = Keypair.generate().publicKey.toBase58();
      const rpc = verificationRpc(8n);
      const simulate = vi.spyOn(rpc, "simulate");
      const app = handlers({ rpc });
      const session = await signIn(app, payer);
      const response = await app.analyze(request("analyze", {
        recipient: claimedRecipient,
        amountBaseUnits: "8",
        transactionBase64: unsignedTransfer(payer, actualRecipient).toString("base64"),
      }, { cookie: session.cookie }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.report.verdict).toBe("BLOCK");
      expect(body.report.findings[0].ruleId).toBe("RECIPIENT_MISMATCH");
      expect(body.report.simulation).toBeNull();
      expect(simulate).not.toHaveBeenCalled();

      const wrongAmount = await app.analyze(request("analyze", {
        recipient: actualRecipient,
        amountBaseUnits: "9",
        transactionBase64: unsignedTransfer(payer, actualRecipient).toString("base64"),
      }, { cookie: session.cookie }));
      const wrongAmountBody = await wrongAmount.json();
      expect(wrongAmount.status).toBe(200);
      expect(wrongAmountBody.report.verdict).toBe("BLOCK");
      expect(wrongAmountBody.report.findings[0].ruleId).toBe("AMOUNT_MISMATCH");
      expect(wrongAmountBody.report.simulation).toBeNull();
      expect(simulate).not.toHaveBeenCalled();
    });
  });

  it("binds the analyzed transaction payer to the authenticated wallet and rejects self-transfers", async () => {
    await withSpendLimit("1000000000", async () => {
      const payer = Keypair.generate();
      const otherPayer = Keypair.generate();
      const recipient = Keypair.generate().publicKey.toBase58();
      const rpc = verificationRpc(8n);
      const simulate = vi.spyOn(rpc, "simulate");
      const app = handlers({ rpc });
      const session = await signIn(app, payer);
      const foreign = await app.analyze(request("analyze", {
        recipient,
        amountBaseUnits: "8",
        transactionBase64: unsignedTransfer(otherPayer, recipient).toString("base64"),
      }, { cookie: session.cookie }));
      const foreignBody = await foreign.json();
      expect(foreign.status).toBe(200);
      expect(foreignBody.report.verdict).toBe("BLOCK");
      expect(foreignBody.report.findings[0].ruleId).toBe("PAYER_MISMATCH");
      expect(foreignBody.report.simulation).toBeNull();
      expect(simulate).not.toHaveBeenCalled();

      const self = await app.analyze(request("analyze", {
        recipient: payer.publicKey.toBase58(),
        amountBaseUnits: "8",
        transactionBase64: unsignedTransfer(payer, payer.publicKey.toBase58()).toString("base64"),
      }, { cookie: session.cookie }));
      expect(self.status).toBe(400);
      expect(simulate).not.toHaveBeenCalled();
    });
  });

  it("fails closed for non-canonical base64 and signed or multi-signer wire data", async () => {
    await withSpendLimit("1000000000", async () => {
      const payer = Keypair.generate();
      const recipient = Keypair.generate().publicKey.toBase58();
      const rpc = verificationRpc(8n);
      const app = handlers({ rpc });
      const session = await signIn(app, payer);
      const invalid = await app.analyze(request("analyze", {
        recipient, amountBaseUnits: "8", transactionBase64: "%%%=",
      }, { cookie: session.cookie }));
      expect(invalid.status).toBe(400);

      const signed = unsignedTransfer(payer, recipient);
      signed[1] = 1;
      const blocked = await app.analyze(request("analyze", {
        recipient, amountBaseUnits: "8", transactionBase64: signed.toString("base64"),
      }, { cookie: session.cookie }));
      const body = await blocked.json();
      expect(blocked.status).toBe(200);
      expect(body.report.verdict).toBe("BLOCK");
      expect(body.report.findings[0].ruleId).toBe("UNDECODABLE_MESSAGE");
      expect(body.report.simulation).toBeNull();

      const multiSigner = Buffer.concat([
        Buffer.from([2]),
        Buffer.alloc(128),
        signed.subarray(65),
      ]);
      const multi = await app.analyze(request("analyze", {
        recipient, amountBaseUnits: "8", transactionBase64: multiSigner.toString("base64"),
      }, { cookie: session.cookie }));
      const multiBody = await multi.json();
      expect(multi.status).toBe(200);
      expect(multiBody.report.verdict).toBe("BLOCK");
      expect(multiBody.report.findings[0].ruleId).toBe("UNDECODABLE_MESSAGE");
      expect(multiBody.report.simulation).toBeNull();
    });
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

  it("limits sign-in abuse without allowing claimed-wallet lockout", async () => {
    const app = handlers();
    const wallet = Keypair.generate().publicKey.toBase58();
    const challenge = await app.challenge(request("session/challenge", { wallet }));
    expect(challenge.status).toBe(200);
    const challengeCookie = challenge.headers.get("set-cookie")?.split(";", 1)[0];
    for (let attempt = 0; attempt < 13; attempt += 1) {
      const response = await app.signIn(request("session", {
        wallet,
        signature: Buffer.alloc(64).toString("base64"),
      }, { forwardedFor: `198.51.100.${attempt + 1}`, cookie: challengeCookie }));
      expect([401, 429]).toContain(response.status);
    }
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

  it("keeps unauthenticated parse abuse out of authenticated global quotas and AI work", async () => {
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

    for (let index = 0; index < 60; index += 1) {
      const crossOrigin = await app.parse(request("parse", {
        message: `could you move 0.5 SOL over to ${recipient} for me`,
      }, { origin: "http://attacker.example" }));
      expect(crossOrigin.status).toBe(403);
    }

    for (let index = 0; index < 121; index += 1) {
      const response = await app.parse(request("parse", {
        message: `could you move 0.5 SOL over to ${recipient} for me`,
      }, { forwardedFor: `198.51.100.${index + 1}` }));
      expect(response.status).toBe(index < 120 ? 401 : 429);
    }
    expect(modelCalls).toBe(0);

    const { cookie } = await signIn(app);
    const authenticated = await app.parse(request("parse", {
      message: `could you move 0.5 SOL over to ${recipient} for me`,
    }, { cookie }));
    expect(authenticated.status).toBe(200);
    expect(modelCalls).toBe(1);
  });

  it("keeps invalid and expired build requests out of authenticated quotas and RPC work", async () => {
    let now = 10_000;
    const rpc = verificationRpc(8n);
    const simulate = vi.spyOn(rpc, "simulate");
    const blockhash = vi.fn(async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 123,
    }));
    const app = handlers({ now: () => now, rpc, blockhash });
    const expired = await signIn(app);
    now += 60 * 60 * 1000 + 1;

    for (let index = 0; index < 15; index += 1) {
      const invalid = await app.build(request("build", { confirmationId: randomUUID() }, {
        cookie: "solguard_session=not-a-token",
      }));
      const expiredResponse = await app.build(request("build", { confirmationId: randomUUID() }, {
        cookie: expired.cookie,
      }));
      expect(invalid.status).toBe(401);
      expect(expiredResponse.status).toBe(401);
    }
    expect(blockhash).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();

    const authenticated = await signIn(app);
    const staged = await app.stage(request("stage", {
      recipient: Keypair.generate().publicKey.toBase58(),
      amountBaseUnits: "8",
    }, { cookie: authenticated.cookie }));
    const { id } = await staged.json();
    expect(staged.status).toBe(200);
    expect((await app.confirm(request("confirm", { id }, { cookie: authenticated.cookie }))).status).toBe(200);
    const built = await app.build(request("build", { confirmationId: id }, { cookie: authenticated.cookie }));
    expect(built.status).toBe(200);
    expect(blockhash).toHaveBeenCalledTimes(1);
    expect(simulate).toHaveBeenCalledTimes(1);
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

  it("bounds a never-resolving broadcast, reconciles it, and never resubmits", async () => {
    let time = 1_000;
    const pending = new Promise<string>(() => undefined);
    const getSignatureStatus = vi.fn(async () => null);
    const result = await submitPreparedTransaction({
      submit: vi.fn(async () => pending),
      getSignatureStatus,
      broadcastTimeoutMs: 5,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });

    expect(result.response.status).toBe(504);
    expect((await result.response.json()).error).toMatch(/unconfirmed.*broadcast timed out.*Do not submit again/);
    expect(result.submit).toHaveBeenCalledTimes(1);
    expect(getSignatureStatus).toHaveBeenCalledWith(
      expectedSignature(result.submittedBytes ?? new Uint8Array()),
    );
  });

  it("bounds a broadcast that resolves after the deadline and reconciles the derived signature", async () => {
    const late = deferredPromise<string>();
    let time = 1_000;
    const getSignatureStatus = vi.fn(async () => null);
    const resultPromise = submitPreparedTransaction({
      submit: vi.fn(async () => late.promise),
      getSignatureStatus,
      broadcastTimeoutMs: 5,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });

    const result = await resultPromise;
    expect(result.response.status).toBe(504);
    late.resolve("late-signature");
    await Promise.resolve();
    expect(result.submit).toHaveBeenCalledTimes(1);
  });

  it("reconciles a timed-out broadcast successfully only after confirmed commitment", async () => {
    let time = 1_000;
    const getSignatureStatus = vi.fn(async (signature: string) => ({
      slot: 123,
      confirmations: 1,
      err: null,
      confirmationStatus: "confirmed" as const,
      signature,
    }));
    const result = await submitPreparedTransaction({
      submit: vi.fn(async () => new Promise<string>(() => undefined)),
      getSignatureStatus,
      broadcastTimeoutMs: 5,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });

    expect(result.response.status).toBe(200);
    expect((await result.response.json()).signature).toBe(
      getSignatureStatus.mock.calls[0]?.[0],
    );
    expect(result.submit).toHaveBeenCalledTimes(1);
  });

  it("handles RPC failure during timed-out broadcast reconciliation", async () => {
    let time = 1_000;
    const getSignatureStatus = vi.fn(async () => {
      throw new Error("RPC unavailable");
    });
    const result = await submitPreparedTransaction({
      submit: vi.fn(async () => new Promise<string>(() => undefined)),
      getSignatureStatus,
      broadcastTimeoutMs: 5,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });

    expect(result.response.status).toBe(504);
    expect((await result.response.json()).error).toMatch(/Devnet RPC could not confirm.*Do not submit again/);
    expect(result.submit).toHaveBeenCalledTimes(1);
  });

  it("contains a late broadcast promise rejection without resubmitting", async () => {
    const late = deferredPromise<string>();
    let time = 1_000;
    const getSignatureStatus = vi.fn(async () => null);
    const resultPromise = submitPreparedTransaction({
      submit: vi.fn(async () => late.promise),
      getSignatureStatus,
      broadcastTimeoutMs: 5,
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });

    const result = await resultPromise;
    late.reject(new Error("late socket rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(result.response.status).toBe(504);
    expect(result.submit).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent submission attempts and releases capacity after a successful broadcast", async () => {
    await withSpendLimit("1000000000", async () => {
      const owner = Keypair.generate();
      const recipient = Keypair.generate().publicKey;
      const entered = deferredPromise<void>();
      const pending = deferredPromise<string>();
      let submittedBytes = Buffer.alloc(0);
      const submit = vi.fn(async (bytes: Uint8Array) => {
        submittedBytes = Buffer.from(bytes);
        entered.resolve();
        return pending.promise;
      });
      const getSignatureStatus = vi.fn(async (signature: string) => ({
        slot: 123,
        confirmations: 1,
        err: null,
        confirmationStatus: "confirmed" as const,
        signature,
      }));
      const app = handlers({
        rpc: verificationRpc(8n),
        blockhash: async () => ({
          blockhash: Keypair.generate().publicKey.toBase58(),
          lastValidBlockHeight: 123,
        }),
        submit,
        getSignatureStatus,
        broadcastTimeoutMs: 30_000,
        inFlightLimiter: new InFlightLimiter(1),
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

      const first = app.submit(submitRequest());
      await entered.promise;
      const concurrent = await app.submit(submitRequest());
      expect(concurrent.status).toBe(429);

      pending.resolve(expectedSignature(submittedBytes));
      expect((await first).status).toBe(200);
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await app.submit(submitRequest())).status).toBe(409);
      expect(submit).toHaveBeenCalledTimes(1);
    });
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

  it("reports a finalized string-form ledger failure and never resends", async () => {
    const getSignatureStatus = vi.fn<NonNullable<ApplicationDependencies["getSignatureStatus"]>>(async () => ({
      slot: 123, confirmations: null, err: "AccountNotFound",
      confirmationStatus: "finalized" as const,
    }));
    const result = await submitPreparedTransaction({ getSignatureStatus });
    const signed = VersionedTransaction.deserialize(Buffer.from(result.signedBase64, "base64"));
    const expected = bs58.encode(signed.signatures[0]!);
    expect(result.response.status).toBe(502);
    expect((await result.response.json()).error).toBe(`Transaction failed on Devnet (signature: ${expected})`);
    expect(getSignatureStatus).toHaveBeenCalledWith(expected);
    expect(result.submit).toHaveBeenCalledTimes(1);
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
        { amount: 999_994_998n, verdict: "PASS" },
        { amount: 999_994_999n, verdict: "PASS" },
        { amount: 999_995_000n, verdict: "BLOCK" },
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
      const amount = 999_995_000n;
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
