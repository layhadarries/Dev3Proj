import { expect, it, vi } from "vitest";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { verify } from "../../src/index.js";
const p = PublicKey.unique(), r = PublicKey.unique(), hash = PublicKey.unique().toBase58();
const intent = {id:"11111111-1111-4111-8111-111111111111",confirmedAt:1,kind:"transfer",asset:{type:"SOL"},
  payer:String(p),recipient:String(r),amountBaseUnits:8n} as const;
const msg = new Transaction({feePayer:p,recentBlockhash:hash}).add(SystemProgram.transfer({
  fromPubkey:p,toPubkey:r,lamports:8n})).serializeMessage();
function setup(initial = 2n) {
  const context = {slot:100};
  const value = {err:null,fee:5000n,preBalances:[10000n,initial,1n],postBalances:[4992n,initial+8n,1n],
    accounts:[4992n,initial+8n].map(lamports=>({owner:"11111111111111111111111111111111" as const,
      executable:false as const,lamports,data:["","base64"] as ["","base64"]})),
    innerInstructions:[],preTokenBalances:[],postTokenBalances:[],replacementBlockhash:null,logs:["fixture"],unitsConsumed:150};
  const rpc = {identity:vi.fn(),fresh:vi.fn(),fee:vi.fn(async()=>({context,value:5000n})),
    simulate:vi.fn(async()=>({context,value}))};
  return {value,rpc,deps:{rpc,walletPublicKey:String(p),network:"devnet" as const}};
}
it("binds fee and simulation to identical bytes and verifies freshness after simulation", async()=>{
  const {deps,rpc} = setup();
  expect((await verify(intent,msg,deps)).verdict).toBe("PASS");
  expect(rpc.fee).toHaveBeenCalledWith(msg.toString("base64"));
  expect(rpc.simulate).toHaveBeenCalledWith(msg.toString("base64"),[String(p),String(r)],100);
  expect(rpc.fresh).toHaveBeenCalledWith(hash,100n);
});
it("warns on new recipient and blocks inconsistent deltas, fees and missing evidence", async()=>{
  const {value,deps,rpc} = setup(0n);
  expect((await verify(intent,msg,deps)).verdict).toBe("WARN");
  value.postBalances[1] = 9n;
  expect((await verify(intent,msg,deps)).findings[0]?.ruleId).toBe("UNEXPECTED_BALANCE_CHANGE");
  expect((await verify(intent,msg,{...deps,maxFeeLamports:4999n})).findings[0]?.ruleId).toBe("EXCESSIVE_PRIORITY_FEE");
  rpc.simulate.mockRejectedValue(new Error("private rpc detail"));
  expect((await verify(intent,msg,deps)).findings[0]?.ruleId).toBe("RPC_UNAVAILABLE");
});
