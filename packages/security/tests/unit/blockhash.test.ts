import { afterEach, expect, it, vi } from "vitest";
import { getRecentBlockhash, requireValidBlockhash } from "../../src/index.js";

const hash = "11111111111111111111111111111111";
function fixture(value: unknown, slot = 17) {
  const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
  const fetch = vi.fn()
    .mockResolvedValueOnce(reply("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"))
    .mockResolvedValueOnce(reply({ context: { slot }, value }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

it("retains both observation slot and distinct expiry height", async () => {
  fixture({ blockhash: hash, lastValidBlockHeight: 900 });
  expect(await getRecentBlockhash({})).toMatchObject({ blockhash: hash, slot: 17n, lastValidBlockHeight: 900n });
});

it("checks the supplied message hash against the minimum context slot", async () => {
  const fetch = fixture(true);
  expect(await requireValidBlockhash(hash, 16n, {})).toMatchObject({ blockhash: hash, slot: 17n });
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toMatchObject({
    method: "isBlockhashValid", params: [hash, { commitment: "confirmed", minContextSlot: 16 }],
  });
});

it.each([
  [false, 17, "BLOCKHASH_NOT_VALID"], [true, 15, "DEVNET_RPC_UNAVAILABLE"], ["true", 17, "DEVNET_RPC_UNAVAILABLE"],
] as const)("requires fresh affirmative evidence", async (value, slot, error) => {
  fixture(value, slot);
  await expect(requireValidBlockhash(hash, 16n, {})).rejects.toThrow(error);
});

it("rejects invalid input before any network request", async () => {
  const fetch = fixture(true);
  await expect(requireValidBlockhash("bad", 16n, {})).rejects.toThrow("INVALID_BLOCKHASH");
  await expect(requireValidBlockhash(hash, 2n ** 53n, {})).rejects.toThrow("INVALID_MIN_SLOT");
  expect(fetch).not.toHaveBeenCalled();
});
