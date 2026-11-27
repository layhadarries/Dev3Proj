import { Connection, VersionedTransaction, type ConnectionConfig, type SignatureStatus } from "@solana/web3.js";
import {
  Base58PubkeySchema,
  PositiveBigIntWireSchema,
  SecurityReportWireSchema,
  serializeIntent,
} from "@solguard/shared";
import { createConfirmationGateway, createDevnetRpc, getRecentBlockhash, type RpcClient } from "@solguard/security";
import { agentHandlers, explainReport, llmFromEnv, parseTransfer } from "@solguard/agent";
import { clientAddress, errorResponse, HttpError, InFlightLimiter, jsonResponse, RateLimiter, readJson, requireSameOrigin } from "./http";
import { SessionStore } from "./sessions";

const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
const DEVNET_CONNECTION = new Connection(SOLANA_DEVNET_RPC, "confirmed");

/** Separate write transport: maxRetries controls validator forwarding, not SDK HTTP retries. */
export function createDevnetSubmissionTransport(fetchOverride?: ConnectionConfig["fetch"]) {
  const connection = new Connection(SOLANA_DEVNET_RPC, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  });
  return (signedBytes: Uint8Array): Promise<string> =>
    connection.sendRawTransaction(Buffer.from(signedBytes), {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "confirmed",
    });
}

const submitDevnet = createDevnetSubmissionTransport();
const MAX_SPEND_U64 = 0xffffffffffffffffn;
const APPROVED_MAX_SPEND_LAMPORTS = 1_000_000_000n;
const DEFAULT_SPEND_LIMIT = APPROVED_MAX_SPEND_LAMPORTS.toString(10);
const SIGNATURE_CONFIRMATION_TIMEOUT_MS = 30_000;
const SIGNATURE_CONFIRMATION_POLL_MS = 500;
const BROADCAST_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type SignatureConfirmation =
  | { outcome: "confirmed" }
  | { outcome: "failed" }
  | { outcome: "unconfirmed"; reason: "timeout" | "rpc" };

interface ConfirmedBroadcast {
  signature: string;
  confirmation: Extract<SignatureConfirmation, { outcome: "confirmed" }>;
}

type BroadcastResult =
  | { outcome: "returned"; signature: string }
  | { outcome: "thrown" }
  | { outcome: "timeout" };

async function broadcastWithDeadline(
  submit: (signedBytes: Uint8Array) => Promise<string>,
  snapshot: Uint8Array,
  timeoutMs: number,
): Promise<BroadcastResult> {
  let broadcastPromise: Promise<string>;
  try {
    broadcastPromise = Promise.resolve(submit(snapshot));
  } catch {
    return { outcome: "thrown" };
  }

  void broadcastPromise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      broadcastPromise.then(
        (signature) => ({ outcome: "returned" as const, signature }),
        () => ({ outcome: "thrown" as const }),
      ),
      new Promise<{ outcome: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ outcome: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Solana serializes fieldless TransactionError variants as strings, while
// variants with associated data are objects. Unknown strings stay provisional.
// See https://solana.com/docs/rpc/json-structures#transaction-errors and
// https://docs.rs/solana-sdk/5.0.0/solana_sdk/transaction/enum.TransactionError.html
const STRING_TRANSACTION_ERRORS = new Set([
  "AccountInUse", "AccountLoadedTwice", "AccountNotFound", "ProgramAccountNotFound",
  "InsufficientFundsForFee", "InvalidAccountForFee", "AlreadyProcessed", "BlockhashNotFound",
  "CallChainTooDeep", "MissingSignatureForFee", "InvalidAccountIndex", "SignatureFailure",
  "InvalidProgramForExecution", "SanitizeFailure", "ClusterMaintenance", "AccountBorrowOutstanding",
  "WouldExceedMaxBlockCostLimit", "UnsupportedVersion", "InvalidWritableAccount",
  "WouldExceedMaxAccountCostLimit", "WouldExceedAccountDataBlockLimit", "TooManyAccountLocks",
  "AddressLookupTableNotFound", "InvalidAddressLookupTableOwner", "InvalidAddressLookupTableData",
  "InvalidAddressLookupTableIndex", "InvalidRentPayingAccount", "WouldExceedMaxVoteCostLimit",
  "WouldExceedAccountDataTotalLimit", "MaxLoadedAccountsDataSizeExceeded",
  "InvalidLoadedAccountsDataSizeLimit", "ResanitizationNeeded", "UnbalancedTransaction",
  "ProgramCacheHitMaxLimit", "CommitCancelled", "BailOut",
]);

function isLedgerError(value: unknown): boolean {
  if (typeof value === "string") return STRING_TRANSACTION_ERRORS.has(value);
  // Preserve structured transaction errors, but reject empty objects and arrays.
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.keys(value).length > 0;
}

export async function confirmSignature(
  signature: string,
  getStatus: (signature: string) => Promise<SignatureStatus | null>,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
  timeoutMs: number = SIGNATURE_CONFIRMATION_TIMEOUT_MS,
): Promise<SignatureConfirmation> {
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    const remaining = deadline - now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result:
      | { kind: "status"; status: SignatureStatus | null }
      | { kind: "rpc-error" }
      | { kind: "timeout" };
    try {
      result = await Promise.race([
        getStatus(signature).then(
          (status) => ({ kind: "status" as const, status }),
          () => ({ kind: "rpc-error" as const }),
        ),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
        }),
      ]);
    } catch {
      result = { kind: "rpc-error" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (result.kind === "timeout") return { outcome: "unconfirmed", reason: "timeout" };
    if (result.kind === "rpc-error") return { outcome: "unconfirmed", reason: "rpc" };
    const status = result.status;
    if (!status || typeof status !== "object") {
      // Missing status or malformed RPC data remains provisional.
    } else {
      const explicitCommitment = status.confirmationStatus;
      const confirmations = status.confirmations;
      if (
        explicitCommitment !== undefined &&
        explicitCommitment !== "processed" &&
        explicitCommitment !== "confirmed" &&
        explicitCommitment !== "finalized"
      ) {
        // Unknown or malformed commitment metadata is never a definitive result.
      } else if (explicitCommitment === "processed") {
        // Processed state is provisional, even if err or confirmations look final.
      } else if (explicitCommitment === "confirmed" || explicitCommitment === "finalized") {
        if (
          (confirmations !== undefined && confirmations !== null &&
            (!Number.isSafeInteger(confirmations) || confirmations < 0)) ||
          (status.slot !== undefined &&
            (!Number.isSafeInteger(status.slot) || status.slot < 0))
        ) {
          // Contradictory or malformed slot/count metadata is conservative.
        } else if (explicitCommitment === "confirmed" && confirmations === 0) {
          // A confirmed label cannot override zero confirmations.
        } else if (explicitCommitment === "finalized" && confirmations !== undefined &&
          confirmations !== null && confirmations < 1) {
          // A finalized label must not coexist with zero confirmations.
        } else if (status.err === undefined) {
          // Missing err evidence is ambiguous; continue polling.
        } else if (status.err === null) {
          return { outcome: "confirmed" };
        } else if (isLedgerError(status.err)) {
          return { outcome: "failed" };
        }
      } else if (
        explicitCommitment === undefined &&
        status.confirmations === null &&
        (status.slot === undefined || (Number.isSafeInteger(status.slot) && status.slot >= 0)) &&
        (status.err === null || isLedgerError(status.err))
      ) {
        // Legacy API fallback: confirmations null means no exact count, but
        // only when there is no explicit contradictory commitment metadata.
        if (status.err === null) return { outcome: "confirmed" };
        return { outcome: "failed" };
      }
    }

    const nextDelay = Math.min(SIGNATURE_CONFIRMATION_POLL_MS, deadline - now());
    if (nextDelay <= 0) break;
    await sleep(nextDelay);
  }

  return { outcome: "unconfirmed", reason: "timeout" };
}

function expectedTransactionSignature(signedBytes: Uint8Array): string {
  const transaction = VersionedTransaction.deserialize(Buffer.from(signedBytes));
  const signature = transaction.signatures[0];
  if (!signature || signature.length !== 64) throw new HttpError(400, "Invalid signed transaction");
  const bytes = Buffer.from(signature);
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
  rpc?: RpcClient;
  rateLimiter?: RateLimiter;
  inFlightLimiter?: InFlightLimiter;
  now?: () => number;
  llm?: ReturnType<typeof llmFromEnv>;
  blockhash?: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  submit?: (signedBytes: Uint8Array) => Promise<string>;
  getSignatureStatus?: (signature: string) => Promise<SignatureStatus | null>;
  sleep?: (milliseconds: number) => Promise<void>;
  broadcastTimeoutMs?: number;
  confirmationTimeoutMs?: number;
}

function configuredSpendLimit(): bigint {
  const raw = process.env.SOLGUARD_MAX_SPEND_LAMPORTS ?? DEFAULT_SPEND_LIMIT;
  if (raw.length > 20 || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error("SOLGUARD_MAX_SPEND_LAMPORTS must be a canonical non-negative decimal u64 value");
  }
  const limit = BigInt(raw);
  if (limit > MAX_SPEND_U64) {
    throw new Error("SOLGUARD_MAX_SPEND_LAMPORTS must be a canonical non-negative decimal u64 value");
  }
  return limit;
}

function currentGatewaySession(sessions: SessionStore, request: Request) {
  try {
    return sessions.resolve(request);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      throw new Error("AUTHENTICATED_DEVNET_SESSION_REQUIRED");
    }
    throw error;
  }
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
  const broadcastTimeoutMs = dependencies.broadcastTimeoutMs ?? BROADCAST_TIMEOUT_MS;
  if (!Number.isSafeInteger(broadcastTimeoutMs) || broadcastTimeoutMs < 1 || broadcastTimeoutMs > 30_000) {
    throw new RangeError("Broadcast timeout must be between 1 and 30000 milliseconds");
  }
  const confirmationTimeoutMs = dependencies.confirmationTimeoutMs ?? SIGNATURE_CONFIRMATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(confirmationTimeoutMs) || confirmationTimeoutMs < 1 || confirmationTimeoutMs > 30_000) {
    throw new RangeError("Confirmation timeout must be between 1 and 30000 milliseconds");
  }
  const sessions = dependencies.sessions ?? new SessionStore(now);
  const limiter = dependencies.rateLimiter ?? new RateLimiter();
  const inFlight = dependencies.inFlightLimiter ?? new InFlightLimiter();
  const spendLimit = configuredSpendLimit();
  const securityRpc = dependencies.rpc ?? createDevnetRpc();
  const gateway = createConfirmationGateway({
    rpc: securityRpc,
    maxSpendLamports: spendLimit,
  });
  const blockhash = dependencies.blockhash ?? (async () => {
    const recent = await getRecentBlockhash();
    const lastValidBlockHeight = Number(recent.lastValidBlockHeight);
    if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 1) {
      throw new Error("INVALID_BLOCKHASH_HEIGHT");
    }
    return { blockhash: recent.blockhash, lastValidBlockHeight };
  });
  const submit = dependencies.submit ?? submitDevnet;
  const getSignatureStatus = dependencies.getSignatureStatus ?? (async (signature: string) => {
    const { value } = await DEVNET_CONNECTION.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    return value[0] ?? null;
  });
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const agent = agentHandlers({
    rpc: { getLatestBlockhash: blockhash },
    llm: dependencies.llm ?? llmFromEnv(process.env),
    confirmations: (request) => {
      const resolve = () => currentGatewaySession(sessions, request);
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
    options: {
      public?: boolean;
      ipLimit?: number | false;
      publicLimit?: number;
      sessionLimit?: number;
      walletLimit?: number;
      claimedWallet?: (input: T) => string | undefined;
      globalLimit?: number;
      concurrencyGroup?: string;
      concurrencyLimit?: number;
      walletConcurrencyLimit?: number;
    } = {},
    run: (input: T, session: ReturnType<SessionStore["resolve"]> | undefined, origin: string, request: Request) => Promise<unknown> | unknown,
  ): Promise<Response> {
    try {
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
      const origin = requireSameOrigin(request, dependencies.allowedOrigin ?? process.env.APP_ORIGIN);
      const address = clientAddress(request);
      let session: ReturnType<SessionStore["resolve"]> | undefined;
      if (options.public) {
        if (options.ipLimit !== false) {
          const ipLimit = limiter.take(`client:${address}:${route}`, options.ipLimit ?? 120);
          if (ipLimit !== undefined) throw new HttpError(429, "Too many requests", ipLimit);
        }
        if (options.globalLimit !== undefined) {
          const globalLimit = limiter.take(`global:${route}`, options.globalLimit);
          if (globalLimit !== undefined) throw new HttpError(429, "Too many requests", globalLimit);
        }
      } else {
        try {
          session = sessions.resolve(request);
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 401) throw error;
          const unauthenticatedLimit = limiter.take(
            `unauthenticated:${address}:${route}`,
            typeof options.ipLimit === "number" ? options.ipLimit : 120,
          );
          if (unauthenticatedLimit !== undefined) {
            throw new HttpError(429, "Too many requests", unauthenticatedLimit);
          }
          throw error;
        }
        if (options.ipLimit !== false) {
          const ipLimit = limiter.take(`client:${address}:${route}`, options.ipLimit ?? 120);
          if (ipLimit !== undefined) throw new HttpError(429, "Too many requests", ipLimit);
        }
      }

      const input = await readJson(request, parse);
      let wallet: string | undefined;
      if (session) {
        const sessionLimit = limiter.take(`session:${session.sessionId}:${route}`, options.sessionLimit ?? 30);
        if (sessionLimit !== undefined) throw new HttpError(429, "Too many requests", sessionLimit);
        wallet = session.walletPublicKey;
        const walletLimit = limiter.take(`wallet:${wallet}:${route}`, options.walletLimit ?? options.sessionLimit ?? 30);
        if (walletLimit !== undefined) throw new HttpError(429, "Too many requests", walletLimit);
      } else if (options.public && options.publicLimit !== undefined) {
        const publicLimit = limiter.take(`public:${address}:${route}`, options.publicLimit);
        if (publicLimit !== undefined) throw new HttpError(429, "Too many requests", publicLimit);
      }

      wallet ??= options.claimedWallet?.(input);
      if (!session && wallet && options.walletLimit !== undefined) {
        const walletLimit = limiter.take(`wallet:${wallet}:${route}`, options.walletLimit);
        if (walletLimit !== undefined) throw new HttpError(429, "Too many requests", walletLimit);
      }

      if (!options.public && options.globalLimit !== undefined) {
        const globalLimit = limiter.take(`global:${route}`, options.globalLimit);
        if (globalLimit !== undefined) throw new HttpError(429, "Too many requests", globalLimit);
      }

      let release: (() => void) | undefined;
      if (options.concurrencyGroup) {
        const policies = [
          { key: "all-expensive-operations", limit: 16 },
          { key: `operation:${options.concurrencyGroup}`, limit: options.concurrencyLimit ?? 4 },
        ];
        if (wallet) {
          policies.push({
            key: `wallet:${wallet}:operation:${options.concurrencyGroup}`,
            limit: options.walletConcurrencyLimit ?? 2,
          });
        }
        release = inFlight.tryAcquire(policies);
        if (!release) throw new HttpError(429, "Too many requests", 1);
      }

      try {
        const result = await run(input, session, origin, request);
        return result instanceof Response ? result : jsonResponse(result);
      } finally {
        release?.();
      }
    } catch (error) {
      return routeError(error);
    }
  }

  const publicOptions = { public: true, ipLimit: 60, publicLimit: 12, globalLimit: 120 };
  const protectedRoute = (route: string, limit: number) => ({
    route,
    options: { sessionLimit: limit },
  });

  return {
    challenge: (request: Request) =>
      invoke(request, "session/challenge", walletInput, {
        ...publicOptions,
      }, (input, _session, origin, currentRequest) => {
        const issued = sessions.issueChallenge(input.wallet, origin, currentRequest);
        const headers = new Headers({
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        if (issued.cookie) {
          headers.set("set-cookie", sessions.authContextCookieHeader(issued.cookie));
        }
        return new Response(JSON.stringify({ message: issued.message }), {
          status: 200,
          headers,
        });
      }),

    signIn: (request: Request) =>
      invoke(request, "session", signInInput, {
        ...publicOptions,
      }, (input, _session, origin, currentRequest) => {
        const authenticated = sessions.authenticate(input.wallet, input.signature, origin, currentRequest);
        const headers = new Headers({
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        headers.append("set-cookie", sessions.cookieHeader(authenticated.cookie));
        headers.append("set-cookie", sessions.expiredAuthContextCookieHeader());
        return new Response(JSON.stringify({ wallet: authenticated.session.walletPublicKey }), {
          status: 200,
          headers,
        });
      }),

    logout: (request: Request) =>
      invoke(request, "session/logout", emptyInput, { public: true, ipLimit: false }, (_input, _session, _origin, currentRequest) => {
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
      return invoke(request, route, parseInput, {
        ...options,
        walletLimit: 30,
        globalLimit: 60,
        concurrencyGroup: "parse",
        concurrencyLimit: 4,
        walletConcurrencyLimit: 2,
      }, async (input) => parseTransfer(input.message, dependencies.llm ?? llmFromEnv(process.env)));
    },

    stage: (request: Request) => {
      const { route, options } = protectedRoute("stage", 20);
      return invoke(request, route, draftInput, { ...options, globalLimit: 240 }, (input, session, _origin, currentRequest) => {
        if (!session) throw new HttpError(401, "Sign in with your wallet to continue");
        return gateway.stage(() => currentGatewaySession(sessions, currentRequest), input);
      });
    },

    confirm: (request: Request) => {
      const { route, options } = protectedRoute("confirm", 12);
      return invoke(request, route, idInput, { ...options, globalLimit: 240 }, (input, session, _origin, currentRequest) => {
        if (!session) throw new HttpError(401, "Sign in with your wallet to continue");
        return { intent: serializeIntent(gateway.confirm(() => currentGatewaySession(sessions, currentRequest), input.id)) };
      });
    },

    build: (request: Request) => {
      const { route, options } = protectedRoute("build", 8);
      return invoke(request, route, buildInput, {
        ...options,
        walletLimit: 8,
        globalLimit: 30,
        concurrencyGroup: "build",
        concurrencyLimit: 4,
        walletConcurrencyLimit: 2,
      }, async (input) => {
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
      return invoke(request, route, explainInput, { ...options, globalLimit: 300 }, (input) => explainReport(input));
    },

    acknowledge: (request: Request) => {
      const { route, options } = protectedRoute("acknowledge", 12);
      return invoke(request, route, idInput, { ...options, globalLimit: 120 }, (input, session, _origin, currentRequest) => {
        if (!session) throw new HttpError(401, "Sign in with your wallet to continue");
        gateway.acknowledgeWarning(() => currentGatewaySession(sessions, currentRequest), input.id);
        return { ok: true };
      });
    },

    handoff: (request: Request) => {
      const { route, options } = protectedRoute("handoff", 12);
      return invoke(request, route, idInput, {
        ...options,
        walletLimit: 12,
        globalLimit: 60,
        concurrencyGroup: "handoff",
        concurrencyLimit: 8,
        walletConcurrencyLimit: 2,
      }, async (input, session, _origin, currentRequest) => {
        if (!session) throw new HttpError(401, "Sign in with your wallet to continue");
        const wire = await gateway.handoff(() => currentGatewaySession(sessions, currentRequest), input.id);
        return { wire: Buffer.from(wire).toString("base64") };
      });
    },

    submit: (request: Request) => {
      const { route, options } = protectedRoute("submit", 8);
      return invoke(request, route, submitInput, {
        ...options,
        walletLimit: 8,
        globalLimit: 30,
        concurrencyGroup: "submit",
        concurrencyLimit: 4,
        walletConcurrencyLimit: 1,
      }, async (input, session, _origin, currentRequest) => {
        if (!session) throw new HttpError(401, "Sign in with your wallet to continue");
        const signed = Buffer.from(input.signed, "base64");
        if (signed.toString("base64") !== input.signed || signed.length > 1232) {
          throw new HttpError(400, "Invalid signed transaction");
        }
        const broadcast = await gateway.submitAndConfirm(
          () => currentGatewaySession(sessions, currentRequest),
          input.id,
          signed,
          async (snapshot) => {
            const expectedSignature = expectedTransactionSignature(snapshot);
            const broadcast = await broadcastWithDeadline(submit, snapshot, broadcastTimeoutMs);
            if (broadcast.outcome === "thrown" || broadcast.outcome === "timeout") {
              const confirmation = await confirmSignature(
                expectedSignature,
                getSignatureStatus,
                now,
                sleep,
                confirmationTimeoutMs,
              );
              if (confirmation.outcome === "failed") {
                throw new HttpError(502, `Transaction failed on Devnet (signature: ${expectedSignature})`);
              }
              if (confirmation.outcome === "unconfirmed") {
                const reason = confirmation.reason === "rpc"
                  ? "the Devnet RPC could not confirm it"
                  : broadcast.outcome === "timeout"
                    ? "the broadcast timed out"
                    : "the confirmation timed out";
                throw new HttpError(
                  504,
                  `Transaction is unconfirmed because ${reason} (signature: ${expectedSignature}). Do not submit again; check Devnet status.`,
                );
              }
              return { signature: expectedSignature, confirmation } satisfies ConfirmedBroadcast;
            }
            const rpcSignature = broadcast.signature;
            if (rpcSignature !== expectedSignature) {
              throw new HttpError(
                504,
                `The submission RPC returned a different signature. The transaction outcome is unconfirmed (expected signature: ${expectedSignature}). Do not submit again; check Devnet status.`,
              );
            }
            return rpcSignature;
          },
        );
        const signature = typeof broadcast === "string" ? broadcast : broadcast.signature;
        const confirmation = typeof broadcast === "string"
          ? await confirmSignature(signature, getSignatureStatus, now, sleep, confirmationTimeoutMs)
          : broadcast.confirmation;
        if (confirmation.outcome === "failed") {
          throw new HttpError(502, `Transaction failed on Devnet (signature: ${signature})`);
        }
        if (confirmation.outcome === "unconfirmed") {
          const reason = confirmation.reason === "rpc"
            ? "the Devnet RPC could not confirm it"
            : "the confirmation timed out";
          throw new HttpError(
            504,
            `Transaction is unconfirmed because ${reason} (signature: ${signature}). Do not submit again; check Devnet status.`,
          );
        }
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
