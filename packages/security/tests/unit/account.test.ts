import { afterEach, expect, it, vi } from "vitest";
import { inspectAccount } from "../../src/index.js";

const address = "11111111111111111111111111111111";
const account = { owner: address, executable: false, space: 0, lamports: 0 };
afterEach(() => vi.unstubAllGlobals());

function fixture(value: unknown) {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }))
    .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 12 }, value } })));
}

it("preserves existing zero-balance accounts", async () => {
  fixture(account);
  expect(await inspectAccount(address, {})).toMatchObject({ slot: 12n, account: { ...account, space: 0n, lamports: 0n } });
});

it("reports an explicit null as absent at the observed slot", async () => {
  fixture(null);
  expect(await inspectAccount(address, {})).toMatchObject({ slot: 12n, account: null });
});

it.each([undefined, { ...account, owner: "invalid" }, { ...account, executable: "false" }])(
  "rejects incomplete or invalid evidence", async value => {
    fixture(value);
    await expect(inspectAccount(address, {})).rejects.toThrow("DEVNET_RPC_UNAVAILABLE");
  }
);
