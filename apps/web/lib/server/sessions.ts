import { createPublicKey, randomBytes, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { Base58PubkeySchema } from "@solguard/shared";
import { HttpError } from "./http";

const SESSION_TTL_MS = 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const AUTH_CONTEXT_TTL_MS = 10 * 60 * 1000;
const MAX_CHALLENGES_PER_CONTEXT = 3;
const MAX_RECORDS = 10_000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface AuthenticatedSession {
  sessionId: string;
  walletPublicKey: string;
  network: "devnet";
}

interface Challenge {
  wallet: string;
  message: string;
  contextId: string;
  expiresAt: number;
}

interface AuthContext {
  contextId: string;
  expiresAt: number;
  origin: string;
}

interface SessionRecord extends AuthenticatedSession {
  expiresAt: number;
}

export class SessionStore {
  private readonly challenges = new Map<string, Challenge>();
  private readonly authContexts = new Map<string, AuthContext>();
  private readonly sessions = new Map<string, SessionRecord>();
  readonly cookieName: string;
  readonly authContextCookieName: string;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly secureCookies = process.env.NODE_ENV === "production",
  ) {
    this.cookieName = secureCookies ? "__Host-solguard_session" : "solguard_session";
    this.authContextCookieName = secureCookies
      ? "__Host-solguard_auth_context"
      : "solguard_auth_context";
  }

  issueChallenge(wallet: string, origin: string, request?: Request): { message: string; cookie?: string } {
    if (!Base58PubkeySchema.safeParse(wallet).success) throw new HttpError(400, "Invalid wallet address");
    this.prune();
    if (this.challenges.size >= MAX_RECORDS) throw new HttpError(503, "Authentication is temporarily unavailable");

    const existingContext = request
      ? this.readCookieValue(request.headers.get("cookie") ?? "", this.authContextCookieName)
      : undefined;
    let context = existingContext ? this.authContexts.get(existingContext) : undefined;
    if (context && (this.now() >= context.expiresAt || context.origin !== origin)) context = undefined;

    let contextCookie: string | undefined;
    if (!context) {
      if (this.authContexts.size >= MAX_RECORDS) throw new HttpError(503, "Authentication is temporarily unavailable");
      const contextId = randomBytes(32).toString("base64url");
      context = {
        contextId,
        origin,
        expiresAt: this.now() + AUTH_CONTEXT_TTL_MS,
      };
      this.authContexts.set(contextId, context);
      contextCookie = contextId;
    }

    const activeForContext = [...this.challenges.values()].filter((item) => item.contextId === context.contextId);
    if (activeForContext.length >= MAX_CHALLENGES_PER_CONTEXT) {
      throw new HttpError(429, "Too many sign-in challenges for this browser", 60);
    }

    const issuedAt = new Date(this.now()).toISOString();
    const nonce = randomBytes(24).toString("base64url");
    const message = [
      "SolGuard Devnet sign-in",
      `Origin: ${origin}`,
      `Wallet: ${wallet}`,
      "Environment: Solana Devnet",
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt}`,
    ].join("\n");
    this.challenges.set(message, {
      wallet,
      message,
      contextId: context.contextId,
      expiresAt: this.now() + CHALLENGE_TTL_MS,
    });
    return { message, cookie: contextCookie };
  }

  authenticate(wallet: string, signatureBase64: string, origin: string, request?: Request): { cookie: string; session: AuthenticatedSession } {
    if (!Base58PubkeySchema.safeParse(wallet).success) throw new HttpError(400, "Invalid wallet address");
    const signature = Buffer.from(signatureBase64, "base64");
    if (
      signature.length !== 64 ||
      signature.toString("base64") !== signatureBase64
    ) {
      throw new HttpError(401, "Wallet signature is invalid or expired");
    }

    this.prune();
    const contextId = request
      ? this.readCookieValue(request.headers.get("cookie") ?? "", this.authContextCookieName)
      : undefined;
    const context = contextId ? this.authContexts.get(contextId) : undefined;
    if (
      !context ||
      this.now() >= context.expiresAt ||
      context.origin !== origin
    ) {
      throw new HttpError(401, "Wallet authentication challenge is missing or expired");
    }

    const candidates = [...this.challenges.entries()].filter(([, item]) =>
      item.wallet === wallet &&
      item.contextId === contextId &&
      item.message.includes(`Environment: Solana Devnet\n`)
    );
    let matched: string | undefined;
    try {
      const key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(wallet).toBuffer()]),
        format: "der",
        type: "spki",
      });
      matched = candidates.find(([, item]) => item.message.includes(`Origin: ${origin}\n`) &&
        verify(null, Buffer.from(item.message, "utf8"), key, signature))?.[0];
    } catch {
      matched = undefined;
    }
    if (!matched) throw new HttpError(401, "Wallet signature is invalid or expired");
    const previousToken = request ? this.readCookie(request.headers.get("cookie") ?? "") : undefined;
    const replaced = [...this.sessions.entries()].filter(([token, session]) =>
      session.walletPublicKey === wallet || token === previousToken);
    if (this.sessions.size - replaced.length >= MAX_RECORDS) {
      throw new HttpError(503, "Sessions are temporarily unavailable");
    }
    this.challenges.delete(matched);
    for (const [message, challenge] of this.challenges) {
      if (challenge.contextId === contextId) this.challenges.delete(message);
    }
    if (contextId) this.authContexts.delete(contextId);
    for (const [token] of replaced) this.sessions.delete(token);

    const cookie = randomBytes(32).toString("base64url");
    const session = {
      sessionId: randomBytes(32).toString("base64url"),
      walletPublicKey: wallet,
      network: "devnet" as const,
      expiresAt: this.now() + SESSION_TTL_MS,
    };
    this.sessions.set(cookie, session);
    return { cookie, session };
  }

  resolve(request: Request): AuthenticatedSession {
    const token = this.readCookie(request.headers.get("cookie") ?? "");
    const record = token ? this.sessions.get(token) : undefined;
    if (!record || this.now() >= record.expiresAt) {
      if (token) this.sessions.delete(token);
      throw new HttpError(401, "Sign in with your wallet to continue");
    }
    return {
      sessionId: record.sessionId,
      walletPublicKey: record.walletPublicKey,
      network: record.network,
    };
  }

  cookieHeader(token: string): string {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${this.secureCookies ? "; Secure" : ""}`;
  }

  authContextCookieHeader(token: string): string {
    return `${this.authContextCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${AUTH_CONTEXT_TTL_MS / 1000}${this.secureCookies ? "; Secure" : ""}`;
  }

  expiredAuthContextCookieHeader(): string {
    return `${this.authContextCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${this.secureCookies ? "; Secure" : ""}`;
  }

  expiredCookieHeader(): string {
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${this.secureCookies ? "; Secure" : ""}`;
  }

  revoke(request: Request): void {
    const token = this.readCookie(request.headers.get("cookie") ?? "");
    if (token) this.sessions.delete(token);
  }

  private readCookie(header: string): string | undefined {
    return this.readCookieValue(header, this.cookieName);
  }

  private readCookieValue(header: string, cookieName: string): string | undefined {
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
      const value = part.slice(separator + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
    }
    return undefined;
  }

  private prune(): void {
    const now = this.now();
    for (const [message, challenge] of this.challenges) {
      if (now >= challenge.expiresAt) this.challenges.delete(message);
    }
    for (const [token, session] of this.sessions) {
      if (now >= session.expiresAt) this.sessions.delete(token);
    }
    for (const [contextId, context] of this.authContexts) {
      if (now >= context.expiresAt) this.authContexts.delete(contextId);
    }
  }
}
