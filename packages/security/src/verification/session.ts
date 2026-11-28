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
  message?:Buffer; report?:SecurityReport; warningAcknowledged?:true;
}
const draftSchema = z.object({recipient:Base58PubkeySchema, amountBaseUnits:PositiveBigIntWireSchema}).strict();
const uuid = z.string().uuid();

/** One instance per trusted Node process. Restart/eviction invalidates all pending requests. */
export function createConfirmationGateway(policy: Omit<VerifyDeps,"network"|"walletPublicKey"> = {}) {
  const entries = new Map<string,Entry>();
  const now = policy.now ?? Date.now;
  function clock() {
    const t = now();
    if (!Number.isSafeInteger(t) || t < 0) throw Error("INVALID_SERVER_CLOCK");
    return t;
  }
  function expiry(t:number) {
    const at = t + APPROVAL_TTL_MS;
    if (!Number.isSafeInteger(at)) throw Error("INVALID_SERVER_CLOCK");
    return at;
  }
  function session(resolve:CurrentSession) {
    const s = resolve();
    if (!s || typeof s.sessionId !== "string" || s.sessionId.length < 1 || s.sessionId.length > 256 ||
      s.network !== "devnet" || !Base58PubkeySchema.safeParse(s.walletPublicKey).success)
      throw Error("AUTHENTICATED_DEVNET_SESSION_REQUIRED");
    return s;
  }
  function expired(e:Entry, wallTime?: number) {
    const wall = wallTime ?? clock();
    const monotonic = performance.now();
    if (!Number.isFinite(monotonic) || monotonic < 0) throw Error("INVALID_SERVER_CLOCK");
    return wall >= e.expiresAt || monotonic >= e.deadline;
  }
  function entry(resolve:CurrentSession,id:string) {
    if (!uuid.safeParse(id).success) throw Error("INVALID_CONFIRMATION");
    const s=session(resolve), e=entries.get(id);
    if (!e || e.owner !== s.sessionId || e.intent.payer !== s.walletPublicKey || e.intent.id !== id)
      throw Error("INVALID_CONFIRMATION");
    return e;
  }
  function find(resolve:CurrentSession,id:string) {
    const e=entry(resolve,id);
    if (expired(e)) {
      if (e.phase !== "draft") entries.delete(id);
      throw Error("CONFIRMATION_EXPIRED");
    }
    return e;
  }
  function get(resolve:CurrentSession,id:string,phase:Phase) {
    const e = find(resolve,id);
    if (e.phase !== phase) throw Error("INVALID_CONFIRMATION_PHASE");
    if (phase !== "draft" && (!Number.isSafeInteger(e.intent.confirmedAt) || e.intent.confirmedAt <= 0))
      throw Error("INVALID_CONFIRMATION");
    return e;
  }
  const deps = (e:Entry):VerifyDeps => ({...policy,network:"devnet",walletPublicKey:e.intent.payer});
  return {
    /** Non-consuming read available only in the confirmed (pre-inspection) phase. */
    intent(resolve:CurrentSession,id:string):Intent {
      const e=find(resolve,id);
      if (e.phase === "draft") throw Error("INTENT_NOT_CONFIRMED");
      if (e.phase !== "confirmed") throw Error("INVALID_CONFIRMATION_PHASE");
      if (!Number.isSafeInteger(e.intent.confirmedAt) || e.intent.confirmedAt <= 0)
        throw Error("INVALID_CONFIRMATION");
      return structuredClone(e.intent);
    },
    stage(resolve:CurrentSession,input:unknown) {
      const s=session(resolve), draft=draftSchema.parse(input);
      if (draft.recipient === s.walletPublicKey) throw Error("SELF_TRANSFER");
      const wallNow=clock();
      const monotonicNow=performance.now();
      if (!Number.isFinite(monotonicNow) || monotonicNow < 0) throw Error("INVALID_SERVER_CLOCK");
      for (const [key,e] of entries)
        if (wallNow >= e.expiresAt || monotonicNow >= e.deadline) entries.delete(key);
      if (entries.size >= 2048) throw Error("CONFIRMATION_CAPACITY");
      const id=randomUUID(), expiresAt=expiry(wallNow);
      const deadline=monotonicNow+APPROVAL_TTL_MS;
      if (!Number.isFinite(monotonicNow) || monotonicNow < 0 ||
        !Number.isFinite(deadline) || deadline <= 0)
        throw Error("INVALID_SERVER_CLOCK");
      const intent:Intent={id,kind:"transfer",asset:{type:"SOL"},payer:s.walletPublicKey,...draft,
        amountBaseUnits:BigInt(draft.amountBaseUnits),confirmedAt:0};
      entries.set(id,{intent,owner:s.sessionId,phase:"draft",deadline,expiresAt});
      return {id,network:s.network,wallet:s.walletPublicKey,asset:"SOL",...draft,expiresAt};
    },
    /** Invoke only for a CSRF-protected explicit user gesture on the displayed server draft. */
    confirm(resolve:CurrentSession,id:string) {
      const e=entry(resolve,id);
      const wallAtConfirm=clock();
      if (e.phase !== "draft") throw Error("INVALID_CONFIRMATION_PHASE");
      if (wallAtConfirm <= 0) throw Error("INVALID_SERVER_CLOCK");
      if (wallAtConfirm >= e.expiresAt) throw Error("CONFIRMATION_EXPIRED");
      const monotonicAtConfirm=performance.now();
      if (!Number.isFinite(monotonicAtConfirm) || monotonicAtConfirm < 0)
        throw Error("INVALID_SERVER_CLOCK");
      if (monotonicAtConfirm >= e.deadline) throw Error("CONFIRMATION_EXPIRED");
      const confirmedAt=wallAtConfirm;
      if (confirmedAt <= 0) throw Error("INVALID_SERVER_CLOCK");
      const currentMonotonic=monotonicAtConfirm;
      const expiresAt=expiry(confirmedAt);
      if (expiresAt <= confirmedAt) throw Error("INVALID_SERVER_CLOCK");
      const deadline=currentMonotonic+APPROVAL_TTL_MS;
      if (!Number.isFinite(deadline) || deadline <= currentMonotonic)
        throw Error("INVALID_SERVER_CLOCK");
      const intent=structuredClone(e.intent);
      intent.confirmedAt=confirmedAt;
      const result=structuredClone(intent);
      const proposed={...e,intent,phase:"confirmed" as const,deadline,expiresAt};
      if (!Number.isSafeInteger(proposed.intent.confirmedAt) || proposed.intent.confirmedAt <= 0 ||
        !Number.isSafeInteger(proposed.expiresAt) || proposed.expiresAt <= proposed.intent.confirmedAt ||
        proposed.expiresAt <= wallAtConfirm ||
        !Number.isFinite(proposed.deadline) || proposed.deadline <= currentMonotonic ||
        proposed.intent.id.length === 0 || proposed.owner.length === 0)
        throw Error("INVALID_CONFIRMATION");
      // Commit the state only after every timestamp, expiry and copy validates.
      e.intent=intent;
      e.phase="confirmed";
      // Restart the TTL window: the 60 s budget covers build→inspect→handoff→submit,
      // not the user's card-reading time. The wall-clock expiry tracks the new window.
      e.deadline=deadline;
      e.expiresAt=expiresAt;
      return result;
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
    /** Invoke only for a CSRF-protected explicit acknowledgement of the displayed WARN. */
    acknowledgeWarning(resolve:CurrentSession,id:string) {
      const e=get(resolve,id,"verified");
      if (e.report?.verdict!=="WARN" || e.warningAcknowledged) throw Error("INVALID_WARNING_ACKNOWLEDGEMENT");
      e.warningAcknowledged=true;
    },
    async handoff(resolve:CurrentSession,id:string) {
      const e=get(resolve,id,"verified"); e.phase="preparing";
      try {
        if (!e.message || !e.report) throw Error("MISSING_VERIFICATION");
        const wire=await prepareWalletApproval(e.intent,e.message,e.report,deps(e),e.warningAcknowledged);
        get(resolve,id,"preparing"); e.phase="handed"; return wire;
      } catch(error) {entries.delete(id); throw error;}
    },
    /** Privileged transport receives only the exact, privately copied, verified signed bytes. */
    async submitAndConfirm<T>(resolve:CurrentSession,id:string,signed:Uint8Array,
      transport:(snapshot:Uint8Array)=>Promise<T>):Promise<T> {
      if (typeof transport !== "function") throw Error("INVALID_TRANSPORT");
      const e=get(resolve,id,"handed"); entries.delete(id);
      if (!e.report || !(signed instanceof Uint8Array) || signed.length <= 65 || signed.length>1232) throw Error("INVALID_SIGNED_WIRE");
      const snapshot=Buffer.from(signed);
      const report=await verifySigned(e.intent,snapshot,e.report,deps(e));
      const s=session(resolve);
      if (expired(e) || s.sessionId!==e.owner || s.walletPublicKey!==e.intent.payer || report.verdict==="BLOCK")
        throw Error("SUBMISSION_BLOCKED");
      return transport(snapshot);
    },
  };
}
