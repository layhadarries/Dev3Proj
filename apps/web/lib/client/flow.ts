import { VersionedTransaction } from "@solana/web3.js";
import type { Explanation, ParseResult } from "@solguard/agent";
import type { BuiltTransaction, IntentWire, SecurityReportWire } from "@solguard/shared";
import type { Api } from "./api";
import type { WalletProvider } from "./wallet";

/** The server's window from confirmation to submission. */
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
  expiresAt: number;
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
): Promise<{ card: Card } | { reason: string }> {
  const parsed = await api<ParseResult>("parse", { message });
  if (parsed.status === "needs_clarification") return { reason: parsed.question };
  if (parsed.status === "unsupported") return { reason: parsed.reason };
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
  return { card };
}

/** Call only from the user's explicit click on the card. */
export async function confirmAndCheck(api: Api, card: Card): Promise<Review> {
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
  return { id: card.id, expiresAt: intent.confirmedAt + WINDOW_MS, ...built, explanation };
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
): Promise<string> {
  const { verdict } = review.report;
  if (verdict === "BLOCK") throw new Error("This transaction is blocked.");
  if (verdict === "WARN") {
    if (!acknowledged) throw new Error("Acknowledge the warning first.");
    await api("acknowledge", { id: review.id });
  }
  const { wire } = await api<{ wire: string }>("handoff", { id: review.id });
  const unsigned = VersionedTransaction.deserialize(fromBase64(wire));
  const expected = base64(unsigned.message.serialize());
  if (expected !== review.transaction.messageBase64) {
    throw new Error("The transaction to sign differs from the one that was checked.");
  }
  if (wallet.publicKey?.toString() !== address) throw new Error("The wallet account changed. Start again.");
  const signed = await wallet.signTransaction(unsigned);
  if (base64(signed.message.serialize()) !== expected) {
    throw new Error("The wallet changed the transaction, so it was not submitted.");
  }
  if (wallet.publicKey?.toString() !== address) throw new Error("The wallet account changed. Start again.");
  const { signature } = await api<{ signature: string }>("submit", { id: review.id, signed: base64(signed.serialize()) });
  return signature;
}
