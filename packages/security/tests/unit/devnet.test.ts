import { afterEach, expect, it, vi } from "vitest";
import { checkDevnetIdentity } from "../../src/rpc/devnet.js";

afterEach(() => vi.unstubAllGlobals());

it.each([{ SOLANA_NETWORK: "mainnet-beta" }, { SOLANA_RPC_URL: "https://example.org" }])(
  "rejects unexpected settings without contacting RPC", async env => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(checkDevnetIdentity(env)).rejects.toThrow("DEVNET_CONFIG_INVALID");
    expect(fetch).not.toHaveBeenCalled();
  }
);

it.each([
  [{ id: 1, jsonrpc: "2.0", result: "other" }, "DEVNET_IDENTITY_MISMATCH"],
  [{ id: 2, jsonrpc: "2.0", result: "other" }, "DEVNET_RPC_UNAVAILABLE"],
  [{ id: 1, jsonrpc: "2.0", error: { message: "sensitive" } }, "DEVNET_RPC_UNAVAILABLE"],
] as const)("fails closed on invalid evidence", async (body, error) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
  await expect(checkDevnetIdentity({})).rejects.toThrow(error);
});
