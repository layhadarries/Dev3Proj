import { readFileSync } from "node:fs";
import { it,expect } from "vitest";
import { BuiltTransactionSchema, IntentWireSchema, SecurityReportWireSchema } from "@solguard/shared";
const report=JSON.parse(readFileSync(new URL("../../mocks/pass.json",import.meta.url),"utf8"));
it("rejects empty or contradictory success reports",()=>{
  for(const fields of [{simulation:null},{checkedAtSlot:0},{feeLamports:null},{decodedInstructions:[]},{verdict:"WARN"},
    {findings:[{...report.findings[0],severity:"BLOCK"}]}])
    expect(SecurityReportWireSchema.safeParse({...report,...fields}).success).toBe(false);
});
it("enforces distinct addresses and u64 on shared wire ingress",()=>{
  const ix=report.decodedInstructions[0];
  const draft={id:report.intentId,kind:"transfer",asset:{type:"SOL"},payer:ix.from,recipient:ix.to,confirmedAt:10,
    amountBaseUnits:"18446744073709551615"};
  expect(IntentWireSchema.safeParse(draft).success).toBe(true);
  for(const fields of [{recipient:ix.from},{amountBaseUnits:"18446744073709551616"}])
    expect(IntentWireSchema.safeParse({...draft,...fields}).success).toBe(false);
  expect(BuiltTransactionSchema.safeParse({intentId:draft.id, messageBase64:"not base64",messageHash:report.messageHash,
    recentBlockhash:ix.from,lastValidBlockHeight:123}).success).toBe(false);
});
