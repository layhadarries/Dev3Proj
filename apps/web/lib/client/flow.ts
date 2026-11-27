import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Explanation, ParseResult } from "@solguard/agent";
import type { BuiltTransaction, IntentWire, SecurityReportWire } from "@solguard/shared";
import { ApiError, type Api } from "./api";
import type { WalletProvider } from "./wallet";

/** The server's window, both for confirming a card and from confirmation to submission. */
export const WINDOW_MS = 60_000;

/** What the server stored, and what the user is asked to confirm. */
export interface Card {
  id: string;
  network: string;
  wallet: string;
  asset: string;
  recipient: string;
  amountBaseUnits: string;
  expiresAt: number;
}

export interface Review {
  id: string;
  /** On this device's clock, so that a wrong clock cannot distort the countdown. */
  deadline: number;
  transaction: BuiltTransaction;
  report: SecurityReportWire;
  explanation: Explanation;
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function signIn(api: Api, wallet: WalletProvider): Promise<string> {
  await wallet.connect();
  const address = wallet.publicKey?.toString();
  if (!address) throw new Error("The wallet did not share an address.");
  const { message } = await api<{ message: string }>("session/challenge", { wallet: address });
  const { signature } = await wallet.signMessage(new TextEncoder().encode(message), "utf8");
  await api("session", { wallet: address, signature: base64(signature) });
  return address;
}

export async function prepare(
  api: Api,
  address: string,
  message: string,
  now: () => number = Date.now,
): Promise<{ card: Card; deadline: number } | { reason: string }> {
  const parsed = await api<ParseResult>("parse", { message });
  if (parsed.status === "needs_clarification") return { reason: parsed.question };
  if (parsed.status === "unsupported") return { reason: parsed.reason };
  // Counted from before the request, so the displayed time never exceeds the server's.
  const deadline = now() + WINDOW_MS;
  const card = await api<Card>("stage", parsed.draft);
  if (
    card.wallet !== address ||
    card.network !== "devnet" ||
    card.asset !== "SOL" ||
    card.recipient !== parsed.draft.recipient ||
    card.amountBaseUnits !== parsed.draft.amountBaseUnits
  ) {
    throw new Error("The server's confirmation does not match your request or wallet. Nothing was confirmed.");
  }
  return { card, deadline };
}

/** Call only from the user's explicit click on the card. */
export async function confirmAndCheck(api: Api, card: Card, now: () => number = Date.now): Promise<Review> {
  const deadline = now() + WINDOW_MS;
  const { intent } = await api<{ intent: IntentWire }>("confirm", { id: card.id });
  if (
    intent.id !== card.id ||
    intent.payer !== card.wallet ||
    intent.recipient !== card.recipient ||
    intent.amountBaseUnits !== card.amountBaseUnits
  ) {
    throw new Error("The confirmed details differ from the card you saw.");
  }
  const built = await api<{ transaction: BuiltTransaction; report: SecurityReportWire }>("build", {
    confirmationId: card.id,
  });
  if (built.report.intentId !== card.id || built.report.messageHash !== built.transaction.messageHash) {
    throw new Error("The security report is for a different transaction.");
  }
  const explanation = await api<Explanation>("explain", built.report);
  return { id: card.id, deadline, ...built, explanation };
}

export type SubmissionOutcome = "confirmed" | "failed" | "not_sent" | "unknown";

/** Decides what a failed submit request means. Anything unclear counts as possibly sent. */
export function submissionOutcome(error: unknown): SubmissionOutcome {
  if (!(error instanceof ApiError)) return "unknown";
  if (error.status >= 400 && error.status < 500) return "not_sent";
  return /failed on Devnet/.test(error.message) ? "failed" : "unknown";
}

export interface SigningHooks {
  /** False once the user has abandoned this review; nothing further is signed or sent. */
  isCurrent(): boolean;
  /** Called with the transaction signature immediately before it is sent to the server. */
  onSubmit(signature: string): void;
}

/** Says what a wallet altered, using only public program addresses and counts. */
export function describeChange(expected: VersionedTransaction["message"], signed: VersionedTransaction["message"]): string {
  const programs = (message: typeof expected) =>
    message.compiledInstructions.map((ix) => message.staticAccountKeys[ix.programIdIndex]?.toBase58() ?? "unknown");
  const before = programs(expected);
  const after = programs(signed);
  const added = [...after];
  for (const program of before) {
    const index = added.indexOf(program);
    if (index >= 0) added.splice(index, 1);
  }
  const notes = [`instructions: ${before.length} before, ${after.length} after`];
  if (added.length) notes.push(`added programs: ${[...new Set(added)].join(", ")}`);
  if (expected.recentBlockhash !== signed.recentBlockhash) notes.push("blockhash replaced");
  return notes.join("; ");
}

/**
 * Releases the verified transaction, has the wallet sign it and returns it to the server.
 * `acknowledged` must come from the user's explicit action on a warning.
 */
export async function signAndSubmit(
  api: Api,
  wallet: WalletProvider,
  address: string,
  review: Review,
  acknowledged: boolean,
  hooks: SigningHooks,
): Promise<string> {
  const assertCurrent = () => {
    if (!hooks.isCurrent()) throw new Error("Cancelled. Nothing was sent.");
    if (wallet.publicKey?.toString() !== address) throw new Error("The wallet account changed. Start again.");
  };
  const { verdict } = review.report;
  if (verdict === "BLOCK") throw new Error("This transaction is blocked.");
  if (verdict === "WARN") {
    if (!acknowledged) throw new Error("Acknowledge the warning first.");
    assertCurrent();
    await api("acknowledge", { id: review.id });
  }
  assertCurrent();
  const { wire } = await api<{ wire: string }>("handoff", { id: review.id });
  const unsigned = VersionedTransaction.deserialize(fromBase64(wire));
  const expected = base64(unsigned.message.serialize());
  if (expected !== review.transaction.messageBase64) {
    throw new Error("The transaction to sign differs from the one that was checked.");
  }
  assertCurrent();
  const signed = await wallet.signTransaction(unsigned);
  if (base64(signed.message.serialize()) !== expected) {
    throw new Error(
      `The wallet changed the transaction, so it was not submitted (${describeChange(VersionedTransaction.deserialize(fromBase64(wire)).message, signed.message)}).`,
    );
  }
  assertCurrent();
  const first = signed.signatures[0];
  if (!first || first.every((byte) => byte === 0)) throw new Error("The wallet did not sign the transaction.");
  const expectedSignature = bs58.encode(first);
  hooks.onSubmit(expectedSignature);
  const { signature } = await api<{ signature: string }>("submit", { id: review.id, signed: base64(signed.serialize()) });
  // A success reply counts only if it names the transaction that was just signed.
  if (signature !== expectedSignature) {
    throw new Error("The server's reply does not match the signed transaction. Check Explorer before sending again.");
  }
  return signature;
}
