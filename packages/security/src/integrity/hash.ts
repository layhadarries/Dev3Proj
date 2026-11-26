import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Computes the lowercase SHA-256 hex digest of the exact serialized message bytes.
 */
export function hashMessage(messageBytes: Uint8Array): string {
  return bytesToHex(sha256(messageBytes));
}
