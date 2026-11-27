import { Connection } from "@solana/web3.js";
import {
  Base58PubkeySchema,
  PositiveBigIntWireSchema,
  SecurityReportWireSchema,
  serializeIntent,
} from "@solguard/shared";
import { createConfirmationGateway, createDevnetRpc, getRecentBlockhash, type RpcClient } from "@solguard/security";
import { agentHandlers, explainReport, llmFromEnv, parseTransfer } from "@solguard/agent";
import { clientAddress, errorResponse, HttpError, jsonResponse, RateLimiter, readJson, requireSameOrigin } from "./http";
import { SessionStore } from "./sessions";

const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_CONNECTION = new Connection(SOLANA_DEVNET_RPC, "confirmed");
const MAX_SPEND_U64 = 0xffffffffffffffffn;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function objectInput(input: unknown, keys: string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_INPUT");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error("INVALID_INPUT");
  return record;
}

function walletInput(input: unknown): { wallet: string } {
  const record = objectInput(input, ["wallet"]);
  if (typeof record.wallet !== "string" || !Base58PubkeySchema.safeParse(record.wallet).success) throw new Error("INVALID_INPUT");
  return { wallet: record.wallet };
}

function emptyInput(input: unknown): Record<string, never> {
  objectInput(input, []);
  return {};
}

function signInInput(input: unknown): { wallet: string; signature: string } {
  const record = objectInput(input, ["wallet", "signature"]);
  const wallet = walletInput({ wallet: record.wallet }).wallet;
  if (typeof record.signature !== "string" || record.signature.length < 84 || record.signature.length > 88) throw new Error("INVALID_INPUT");
  return { wallet, signature: record.signature };
}

function parseInput(input: unknown): { message: string } {
  const record = objectInput(input, ["message"]);
  if (typeof record.message !== "string" || record.message.length > 32 * 1024) throw new Error("INVALID_INPUT");
  return { message: record.message };
}

function draftInput(input: unknown): { recipient: string; amountBaseUnits: string } {
  const record = objectInput(input, ["recipient", "amountBaseUnits"]);
  if (
    typeof record.recipient !== "string" ||
    !Base58PubkeySchema.safeParse(record.recipient).success ||
    typeof record.amountBaseUnits !== "string" ||
    !PositiveBigIntWireSchema.safeParse(record.amountBaseUnits).success
  ) throw new Error("INVALID_INPUT");
  return { recipient: record.recipient, amountBaseUnits: record.amountBaseUnits };
}

function idInput(input: unknown): { id: string } {
  const record = objectInput(input, ["id"]);
  if (typeof record.id !== "string" || !UUID.test(record.id)) throw new Error("INVALID_INPUT");
  return { id: record.id };
}

function buildInput(input: unknown): { confirmationId: string } {
  const record = objectInput(input, ["confirmationId"]);
  if (typeof record.confirmationId !== "string" || !UUID.test(record.confirmationId)) throw new Error("INVALID_INPUT");
  return { confirmationId: record.confirmationId };
}

function explainInput(input: unknown) {
  return SecurityReportWireSchema.parse(input);
}

function submitInput(input: unknown): { id: string; signed: string } {
  const record = objectInput(input, ["id", "signed"]);
  if (
    typeof record.id !== "string" ||
    !UUID.test(record.id) ||
    typeof record.signed !== "string" ||
    record.signed.length < 4 ||
    record.signed.length > 1644 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(record.signed)
  ) throw new Error("INVALID_INPUT");
  return { id: record.id, signed: record.signed };
}

export interface ApplicationDependencies {
  allowedOrigin?: string;
  sessions?: SessionStore;
  gateway?: ReturnType<typeof createConfirmationGateway>;
  rpc?: RpcClient;
  maxSpendLamports?: bigint;
  rateLimiter?: RateLimiter;
  now?: () => number;
  llm?: ReturnType<typeof llmFromEnv>;
  blockhash?: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  submit?: (signedBytes: Uint8Array) => Promise<string>;
}

function configuredSpendLimit(explicit?: bigint): bigint | undefined {
  if (explicit !== undefined) {
    if (explicit < 0n || explicit > MAX_SPEND_U64) {
      throw new Error("maxSpendLamports must be a non-negative u64 value");
    }
    return explicit;
  }
  const raw = process.env.SOLGUARD_MAX_SPEND_LAMPORTS;
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error("SOLGUARD_MAX_SPEND_LAMPORTS must be a decimal u64 value");
  }
  const limit = BigInt(raw);
  if (limit > MAX_SPEND_U64) {
    throw new Error("SOLGUARD_MAX_SPEND_LAMPORTS must be a decimal u64 value");
  }
  return limit;
}

function routeError(error: unknown): Response {
  if (error instanceof Error && error.message === "CONFIRMATION_CAPACITY") {
    return errorResponse(new HttpError(503, "Security checks are temporarily at capacity"));
  }
  if (error instanceof Error && error.message === "INVALID_PROPOSAL_BINDING") {
    return errorResponse(new HttpError(409, "The transaction proposal could not be verified"));
  }
  return errorResponse(error);
}

export function createApplicationHandlers(dependencies: ApplicationDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const sessions = dependencies.sessions ?? new SessionStore(now);
  const limiter = dependencies.rateLimiter ?? new RateLimiter(now);
  const spendLimit = configuredSpendLimit(dependencies.maxSpendLamports);
  const securityRpc = dependencies.rpc ?? createDevnetRpc();
  const gateway = dependencies.gateway ?? createConfirmationGateway({
    rpc: securityRpc,
    maxSpendLamports: spendLimit ?? 0n,
  });
  const blockhash = dependencies.blockhash ?? (async () => {
    const recent = await getRecentBlockhash();
    const lastValidBlockHeight = Number(recent.lastValidBlockHeight);
    if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1) {
      throw new Error("INVALID_BLOCKHASH_HEIGHT");
    }
    return { blockhash: recent.blockhash, lastValidBlockHeight };
  });
  const submit = dependencies.submit ?? (async (signedBytes: Uint8Array) =>
    DEVNET_CONNECTION.sendRawTransaction(Buffer.from(signedBytes), {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "confirmed",
    }));
  const agent = agentHandlers({
    rpc: { getLatestBlockhash: blockhash },
    llm: dependencies.llm ?? llmFromEnv(process.env),
    confirmations: (request) => {
      const current = sessions.resolve(request);
      const resolve = () => current;
      return {
        intent: (id) => gateway.intent(resolve, id),
        inspect: (id, proposal) => gateway.inspect(resolve, id, proposal),
      };
    },
  });

  async function invoke<T>(
    request: Request,
    route: string,
    parse: (input: unknown) => T,
    options: { public?: boolean; ipLimit?: number; sessionLimit?: number; globalLimit?: number } = {},
    run: (input: T, session: ReturnType<SessionStore["resolve"]> | undefined, origin: string, request: Request) => Promise<unknown> | unknown,
  ): Promise<Response> {
    try {
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
      const origin = requireSameOrigin(request, dependencies.allowedOrigin ?? process.env.APP_ORIGIN);
      const address = clientAddress(request);
      const ipLimit = limiter.take(`ip:${address}:${route}`, options.ipLimit ?? 120);
      if (ipLimit !== undefined) throw new HttpError(429, "Too many requests", ipLimit);
      if (options.globalLimit !== undefined) {
        const globalLimit = limiter.take(`global:${route}`, options.globalLimit);
        if (globalLimit !== undefined) throw new HttpError(429, "Too many requests", globalLimit);
      }

      const input = await readJson(request, parse);
      const session = options.public ? undefined : sessions.resolve(request);
      if (session) {
        const sessionLimit = limiter.take(`session:${session.sessionId}:${route}`, options.sessionLimit ?? 30);
        if (sessionLimit !== undefined) throw new HttpError(429, "Too many requests", sessionLimit);
      } else if (options.public) {
        const publicLimit = limiter.take(`public:${address}:${route}`, options.sessionLimit ?? 12);
        if (publicLimit !== undefined) throw new HttpError(429, "Too many requests", publicLimit);
      }

      const result = await run(input, session, origin, request);
      return result instanceof Response ? result : jsonResponse(result);
    } catch (error) {
      return routeError(error);
    }
  }

  const publicOptions = { public: true, ipLimit: 60, sessionLimit: 12, globalLimit: 120 };
  const protectedRoute = (route: string, limit: number) => ({
    route,
    options: { sessionLimit: limit },
  });

  return {
    challenge: (request: Request) =>
      invoke(request, "session/challenge", walletInput, publicOptions, (input, _session, origin) => ({
        message: sessions.issueChallenge(input.wallet, origin),
      })),

    signIn: (request: Request) =>
      invoke(request, "session", signInInput, publicOptions, (input, _session, origin, currentRequest) => {
        const authenticated = sessions.authenticate(input.wallet, input.signature, origin, currentRequest);
        return new Response(JSON.stringify({ wallet: authenticated.session.walletPublicKey }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "set-cookie": sessions.cookieHeader(authenticated.cookie),
          },
        });
      }),

    logout: (request: Request) =>
      invoke(request, "session/logout", emptyInput, publicOptions, (_input, _session, _origin, currentRequest) => {
        sessions.revoke(currentRequest);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "set-cookie": sessions.expiredCookieHeader(),
          },
        });
      }),

    parse: (request: Request) => {
      const { route, options } = protectedRoute("parse", 30);
      return invoke(request, route, parseInput, options, async (input) => parseTransfer(input.message, dependencies.llm ?? llmFromEnv(process.env)));
    },

    stage: (request: Request) => {
      const { route, options } = protectedRoute("stage", 20);
      return invoke(request, route, draftInput, options, (input, session) => {
        if (!session) throw new HttpError(401, "Sign in with your wallet to continue");
        return gateway.stage(() => session, input);
      });
    },

    confirm: (request: Request) => {
      const { route, options } = protectedRoute("confirm", 12);
      return invoke(request, route, idInput, options, (input, session) => {
        if (!session) throw new HttpError(401, "Sign in with your wallet to continue");
        return { intent: serializeIntent(gateway.confirm(() => session, input.id)) };
      });
    },

    build: (request: Request) => {
      const { route, options } = protectedRoute("build", 8);
      return invoke(request, route, buildInput, options, async (input) => {
        if (spendLimit === undefined) {
          throw new HttpError(503, "Transaction building is disabled until a server spending limit is configured");
        }
        const forwarded = new Request(request.url, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: request.headers.get("cookie") ?? "" },
          body: JSON.stringify(input),
        });
        const response = await agent.build(forwarded);
        const result: unknown = await response.json();
        if (!response.ok) {
          const error = (result as { error?: unknown } | null)?.error;
          throw new HttpError(response.status, typeof error === "string" ? error : "Could not complete the request");
        }
        return result;
      });
    },

    explain: (request: Request) => {
      const { route, options } = protectedRoute("explain", 30);
      return invoke(request, route, explainInput, options, (input) => explainReport(input));
    },

    acknowledge: (request: Request) => {
      const { route, options } = protectedRoute("acknowledge", 12);
      return invoke(request, route, idInput, options, (input, session) => {
        if (!session) throw new HttpError(401, "Sign in with your wallet to continue");
        gateway.acknowledgeWarning(() => session, input.id);
        return { ok: true };
      });
    },

    handoff: (request: Request) => {
      const { route, options } = protectedRoute("handoff", 12);
      return invoke(request, route, idInput, options, async (input, session) => {
        if (!session) throw new HttpError(401, "Sign in with your wallet to continue");
        const wire = await gateway.handoff(() => session, input.id);
        return { wire: Buffer.from(wire).toString("base64") };
      });
    },

    submit: (request: Request) => {
      const { route, options } = protectedRoute("submit", 8);
      return invoke(request, route, submitInput, options, async (input, session) => {
        if (!session) throw new HttpError(401, "Sign in with your wallet to continue");
        const signed = Buffer.from(input.signed, "base64");
        if (signed.toString("base64") !== input.signed || signed.length > 1232) {
          throw new HttpError(400, "Invalid signed transaction");
        }
        const signature = await gateway.submitAndConfirm(
          () => session,
          input.id,
          signed,
          (snapshot) => submit(snapshot),
        );
        return { signature };
      });
    },
  };
}

const globalRuntime = globalThis as typeof globalThis & {
  __solguardWebHandlers?: ReturnType<typeof createApplicationHandlers>;
};

export const applicationHandlers =
  globalRuntime.__solguardWebHandlers ??
  (globalRuntime.__solguardWebHandlers = createApplicationHandlers());
