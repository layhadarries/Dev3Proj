// TEMP: pending team agreement

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map<string, number>();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  const ch = BASE58_ALPHABET[i];
  if (ch !== undefined) {
    BASE58_MAP.set(ch, i);
  }
}

/**
 * Decodes a base58 string into bytes. Returns null if the string contains
 * invalid base58 characters.
 */
export function decodeBase58(input: string): Uint8Array | null {
  if (input.length === 0) {
    return null;
  }

  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") {
    zeros++;
  }

  // Base58 expansion factor is log(58)/log(256) ≈ 0.733; allocate slightly more
  const size = Math.floor((input.length * 733) / 1000) + 1;
  const b256 = new Uint8Array(size);
  let length = 0;

  for (let i = zeros; i < input.length; i++) {
    const ch = input[i];
    if (ch === undefined) {
      return null;
    }
    const val = BASE58_MAP.get(ch);
    if (val === undefined) {
      return null;
    }

    let carry = val;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      const current = b256[k] ?? 0;
      carry += 58 * current;
      b256[k] = carry % 256;
      carry = Math.floor(carry / 256);
    }
    length = j;
  }

  let firstNonZero = size - length;
  while (firstNonZero < size && b256[firstNonZero] === 0) {
    firstNonZero++;
  }

  const out = new Uint8Array(zeros + (size - firstNonZero));
  out.fill(0, 0, zeros);
  let outIdx = zeros;
  for (let k = firstNonZero; k < size; k++) {
    out[outIdx++] = b256[k] ?? 0;
  }
  return out;
}

/**
 * Returns true if the string is a valid base58-encoded 32-byte Solana public key.
 */
export function isValidBase58Pubkey(input: string): boolean {
  if (input.length < 32 || input.length > 44) {
    return false;
  }
  const bytes = decodeBase58(input);
  return bytes !== null && bytes.length === 32;
}
