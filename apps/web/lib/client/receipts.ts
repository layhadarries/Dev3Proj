/**
 * Remembers a transaction whose result is not yet known, so that a reload cannot hide it and invite
 * a second payment. Only the public signature is stored, separately for each wallet on Devnet.
 */
export type ReceiptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const key = (wallet: string) => `solguard:devnet:unsettled:${wallet}`;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** Returns undefined where the browser refuses storage, for example in some private windows. */
export function browserStorage(): ReceiptStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function saveReceipt(storage: ReceiptStorage | undefined, wallet: string, signature: string): void {
  try {
    storage?.setItem(key(wallet), signature);
  } catch {
    // Storage is full or blocked; the receipt then lasts only as long as the page.
  }
}

export function loadReceipt(storage: ReceiptStorage | undefined, wallet: string): string | undefined {
  try {
    const value = storage?.getItem(key(wallet));
    return value && SIGNATURE.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the record only if it is still the one that was settled. */
export function clearReceipt(storage: ReceiptStorage | undefined, wallet: string, signature: string): void {
  try {
    if (storage?.getItem(key(wallet)) === signature) storage.removeItem(key(wallet));
  } catch {
    // Nothing was stored if storage is blocked.
  }
}
