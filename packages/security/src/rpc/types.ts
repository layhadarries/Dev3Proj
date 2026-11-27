import type { createDevnetRpc } from "./devnet.js";
/** Trusted server dependency. Never accept a client or RPC evidence from a proposal. */
export type RpcClient = ReturnType<typeof createDevnetRpc>;
