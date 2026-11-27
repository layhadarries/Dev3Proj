import { afterEach, expect, it, vi } from "vitest";
import { getWalletBalance } from "../../src/index.js";

const address = "11111111111111111111111111111111";
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
afterEach(() => vi.unstubAllGlobals());

function fixture(value: string) {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: genesis }))
    .mockResolvedValueOnce(new Response(`{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":31},"value":${value}}}`));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("preserves every bit of a u64 and requests the confirmed address", async () => {
  const fetch = fixture("18446744073709551615");
  expect(await getWalletBalance(address, {})).toEqual({
    network: "devnet", address, commitment: "confirmed", lamports: 18446744073709551615n, slot: 31n,
  });
  expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toMatchObject({
    method: "getBalance", params: [address, { commitment: "confirmed" }],
  });
});

it.each(["18446744073709551616", "-1", "0.5", "null", '"9"'])("rejects invalid RPC amount %s", async value => {
  fixture(value);
  await expect(getWalletBalance(address, {})).rejects.toThrow("DEVNET_RPC_UNAVAILABLE");
});

it("rejects malformed addresses before any RPC call", async () => {
  const fetch = fixture("0");
  await expect(getWalletBalance("bad", {})).rejects.toThrow("INVALID_PUBLIC_KEY");
  expect(fetch).not.toHaveBeenCalled();
});
