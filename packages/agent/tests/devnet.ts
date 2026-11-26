// Manual live check, no keys or funds needed: builds a transfer with a real Devnet blockhash and simulates it.
import { Connection, Keypair, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { buildTransfer, confirmIntent, parseTransfer } from "../src";

const rpc = new Connection("https://api.devnet.solana.com", "confirmed");
// Any funded Devnet address can be passed as the payer; simulation does not need its key.
const sender = process.argv[2] ?? Keypair.generate().publicKey.toBase58();
const parsed = await parseTransfer(`send 0.001 SOL to ${Keypair.generate().publicKey.toBase58()}`);
if (parsed.status !== "ready") throw new Error(parsed.status);
const built = await buildTransfer(confirmIntent(parsed.draft, sender), rpc);
const message = Buffer.from(built.messageBase64, "base64");
const tx = new VersionedTransaction(VersionedMessage.deserialize(message));
const { value } = await rpc.simulateTransaction(tx, { sigVerify: false });
console.log({ payer: sender, blockhash: built.recentBlockhash, err: value.err, logs: value.logs });
