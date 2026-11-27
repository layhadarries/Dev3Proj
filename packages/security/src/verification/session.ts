import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { Base58PubkeySchema, BuiltTransactionSchema, PositiveBigIntWireSchema, type Intent, type SecurityReport } from "@solguard/shared";
import { decodeTransaction } from "../decoder/sol.js";
import { hashMessage } from "../integrity/hash.js";
import { APPROVAL_TTL_MS, prepareWalletApproval, verify, verifySigned, type VerifyDeps } from "./verify.js";

/** Server-authenticated state, resolved from a request/session store, NEVER request JSON. */
export interface SessionIdentity { sessionId:string; walletPublicKey:string; network:"devnet" }
type CurrentSession = () => SessionIdentity;
type Phase = "draft"|"confirmed"|"checking"|"verified"|"preparing"|"handed";
interface Entry {
  owner:string; intent:Intent; phase:Phase; deadline:number; expiresAt:number;
  message?:Buffer; report?:SecurityReport;
}
const draftSchema = z.object({recipient:Base58PubkeySchema, amountBaseUnits:PositiveBigIntWireSchema}).strict();

/** One instance per trusted Node process. Restart/eviction invalidates all pending requests. */
export function createConfirmationGateway(policy: Omit<VerifyDeps,"network"|"walletPublicKey"> = {}) {
  const entries = new Map<string,Entry>();
  const now = policy.now ?? Date.now;
  function session(resolve:CurrentSession) {
    const s = resolve();
    if (!s?.sessionId || s.network !== "devnet" || !Base58PubkeySchema.safeParse(s.walletPublicKey).success)
      throw Error("AUTHENTICATED_DEVNET_SESSION_REQUIRED");
    return s;
  }
  function expired(e:Entry) { return now() >= e.expiresAt || performance.now() >= e.deadline; }
  function get(resolve:CurrentSession,id:string,phase:Phase) {
    const s = session(resolve), e = entries.get(id);
    if (!e || e.owner !== s.sessionId || e.intent.payer !== s.walletPublicKey) throw Error("INVALID_CONFIRMATION");
    if (expired(e)) {entries.delete(id); throw Error("CONFIRMATION_EXPIRED");}
    if (e.phase !== phase) throw Error("INVALID_CONFIRMATION_PHASE");
    return e;
  }
  const deps = (e:Entry):VerifyDeps => ({...policy,network:"devnet",walletPublicKey:e.intent.payer});
  return {
    /** Session-checked, non-consuming read. Returns a clone of the gateway-held intent; never mutates the record. */
    intent(resolve:CurrentSession,id:string):Intent {
      const s = session(resolve), e = entries.get(id);
      if (!e || e.owner !== s.sessionId || e.intent.payer !== s.walletPublicKey) throw Error("INVALID_CONFIRMATION");
      if (expired(e)) {entries.delete(id); throw Error("CONFIRMATION_EXPIRED");}
      return structuredClone(e.intent);
    },
    stage(resolve:CurrentSession,input:unknown) {
      const s=session(resolve), draft=draftSchema.parse(input);
      if (draft.recipient === s.walletPublicKey) throw Error("SELF_TRANSFER");
      for (const [key,e] of entries) if (expired(e)) entries.delete(key);
      if (entries.size >= 2048) throw Error("CONFIRMATION_CAPACITY");
      const id=randomUUID(), expiresAt=now()+APPROVAL_TTL_MS;
      const intent:Intent={id,kind:"transfer",asset:{type:"SOL"},payer:s.walletPublicKey,...draft,
        amountBaseUnits:BigInt(draft.amountBaseUnits),confirmedAt:0};
      entries.set(id,{intent,owner:s.sessionId,phase:"draft",deadline:performance.now()+APPROVAL_TTL_MS,expiresAt});
      return {id,network:s.network,wallet:s.walletPublicKey,asset:"SOL",...draft,expiresAt};
    },
    /** Invoke only for a CSRF-protected explicit user gesture on the displayed server draft. */
    confirm(resolve:CurrentSession,id:string) {
      const e=get(resolve,id,"draft");
      e.intent.confirmedAt=now(); e.phase="confirmed";
      return structuredClone(e.intent);
    },
    async inspect(resolve:CurrentSession,id:string,proposal:unknown) {
      const e=get(resolve,id,"confirmed"); e.phase="checking";
      try {
        const built=BuiltTransactionSchema.parse(proposal), bytes=Buffer.from(built.messageBase64,"base64");
        if (bytes.toString("base64")!==built.messageBase64 || built.intentId!==id || built.messageHash!==hashMessage(bytes) ||
          built.recentBlockhash!==decodeTransaction(bytes).recentBlockhash) throw Error("INVALID_PROPOSAL_BINDING");
        const report=await verify(e.intent,bytes,deps(e));
        get(resolve,id,"checking");
        if (report.verdict==="BLOCK") entries.delete(id);
        else {e.message=bytes; e.report=report; e.phase="verified";}
        return structuredClone(report);
      } catch(error) {entries.delete(id); throw error;}
    },
    async handoff(resolve:CurrentSession,id:string,acknowledgedWarning=false) {
      const e=get(resolve,id,"verified"); e.phase="preparing";
      try {
        if (!e.message || !e.report) throw Error("MISSING_VERIFICATION");
        const wire=await prepareWalletApproval(e.intent,e.message,e.report,deps(e),acknowledgedWarning);
        get(resolve,id,"preparing"); e.phase="handed"; return wire;
      } catch(error) {entries.delete(id); throw error;}
    },
    /** Privileged transport receives only the exact, privately copied, verified signed bytes. */
    async submitAndConfirm<T>(resolve:CurrentSession,id:string,signed:Uint8Array,
      transport:(snapshot:Uint8Array)=>Promise<T>):Promise<T> {
      const e=get(resolve,id,"handed"); entries.delete(id);
      if (!e.report || !(signed instanceof Uint8Array) || signed.length>1232) throw Error("INVALID_SIGNED_WIRE");
      const snapshot=Buffer.from(signed);
      const report=await verifySigned(e.intent,snapshot,e.report,deps(e));
      const s=session(resolve);
      if (expired(e) || s.sessionId!==e.owner || s.walletPublicKey!==e.intent.payer || report.verdict==="BLOCK")
        throw Error("SUBMISSION_BLOCKED");
      return transport(snapshot);
    },
  };
}
