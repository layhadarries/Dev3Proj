"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createApi } from "../lib/client/api";
import { confirmAndCheck, prepare, signAndSubmit, signIn, type Card, type Review } from "../lib/client/flow";
import { lamportsToSol } from "../lib/client/format";
import { findWallet, type WalletProvider } from "../lib/client/wallet";

type Step =
  | { name: "ask"; note?: string }
  | { name: "confirm"; card: Card }
  | { name: "review"; card: Card; review: Review }
  | { name: "done"; signature: string };

export function TransferApp() {
  const api = useMemo(() => createApi(), []);
  const [wallet, setWallet] = useState<WalletProvider>();
  const [address, setAddress] = useState<string>();
  const [message, setMessage] = useState("");
  const [step, setStep] = useState<Step>({ name: "ask" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [now, setNow] = useState(0);
  // Bumped on every reset, so that late results from an abandoned request are ignored.
  const generation = useRef(0);

  const reset = (note?: string) => {
    generation.current += 1;
    setBusy("");
    setError("");
    setAcknowledged(false);
    setStep(note ? { name: "ask", note } : { name: "ask" });
  };

  useEffect(() => {
    if (!wallet?.on) return;
    const changed = () => {
      setAddress(undefined);
      reset("The wallet changed. Connect again.");
    };
    wallet.on("accountChanged", changed);
    wallet.on("disconnect", changed);
    return () => {
      wallet.off?.("accountChanged", changed);
      wallet.off?.("disconnect", changed);
    };
  }, [wallet]);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [step]);

  async function run<T>(label: string, work: () => Promise<T>, then: (result: T) => void) {
    const current = ++generation.current;
    setBusy(label);
    setError("");
    try {
      const result = await work();
      if (current === generation.current) then(result);
    } catch (failure) {
      if (current !== generation.current) return;
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
      // A failed step consumes the server's record, so start over.
      setAcknowledged(false);
      setStep({ name: "ask" });
    } finally {
      if (current === generation.current) setBusy("");
    }
  }

  function connect() {
    const found = findWallet();
    if (!found) return setError("No Solana wallet found. Install MetaMask, Phantom or Solflare and set it to Devnet.");
    void run("Connecting. Approve the sign-in message in your wallet.", () => signIn(api, found), (signedIn) => {
      setWallet(found);
      setAddress(signedIn);
    });
  }

  const expiresAt = step.name === "confirm" ? step.card.expiresAt : step.name === "review" ? step.review.expiresAt : 0;
  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const expired = expiresAt > 0 && now > 0 && secondsLeft === 0;

  return (
    <main>
      <header>
        <h1>SolGuard</h1>
        <span className="badge">Solana Devnet only</span>
        {address ? <code title={address}>{`${address.slice(0, 4)}…${address.slice(-4)}`}</code> : (
          <button onClick={connect} disabled={!!busy}>Connect wallet</button>
        )}
      </header>

      <section>
        <h2>1. Say what you want to send</h2>
        <textarea
          aria-label="Transfer request"
          maxLength={500}
          placeholder="send 0.1 SOL to <address>"
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            if (step.name !== "ask") reset("The request changed.");
          }}
        />
        <button
          disabled={!address || !message.trim() || !!busy}
          onClick={() =>
            void run("Reading your request", () => prepare(api, address!, message), (result) => {
              setAcknowledged(false);
              setStep("card" in result ? { name: "confirm", card: result.card } : { name: "ask", note: result.reason });
            })
          }
        >
          Continue
        </button>
        {step.name === "ask" && step.note && <p role="status">{step.note}</p>}
      </section>

      {(step.name === "confirm" || step.name === "review") && (
        <section>
          <h2>2. Confirm the details</h2>
          <dl>
            <dt>Network</dt><dd>Devnet</dd>
            <dt>From</dt><dd>{step.card.wallet}</dd>
            <dt>To</dt><dd>{step.card.recipient}</dd>
            <dt>Amount</dt><dd>{lamportsToSol(step.card.amountBaseUnits)} SOL</dd>
            <dt>Time left</dt><dd>{secondsLeft} s</dd>
          </dl>
          {step.name === "confirm" && (
            <>
              <button
                disabled={!!busy || expired}
                onClick={() =>
                  void run("Building and checking the transaction", () => confirmAndCheck(api, step.card), (review) =>
                    setStep({ name: "review", card: step.card, review }),
                  )
                }
              >
                These details are correct
              </button>{" "}
              <button onClick={() => reset()}>Cancel</button>
            </>
          )}
        </section>
      )}

      {step.name === "review" && (
        <section className={step.review.explanation.verdict}>
          <h2>3. Security check: {step.review.explanation.verdict}</h2>
          <p>{step.review.explanation.headline}</p>
          <ul>
            {step.review.explanation.points.map((point, index) => (
              <li key={index}><strong>{point.ruleId}</strong>: {point.text}</li>
            ))}
          </ul>
          {step.review.explanation.balanceChanges.length > 0 && (
            <>
              <p>Simulated balance changes (SOL)</p>
              <dl>
                {step.review.explanation.balanceChanges.map((change) => (
                  <div key={change.account} style={{ display: "contents" }}>
                    <dt>{change.changeSol}</dt><dd>{change.account}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {step.review.explanation.feeSol && <p>Network fee: {step.review.explanation.feeSol} SOL</p>}
          {step.review.explanation.verdict === "WARN" && (
            <p>
              <label>
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />{" "}
                I have read the warning and want to continue
              </label>
            </p>
          )}
          {step.review.explanation.verdict !== "BLOCK" && (
            <button
              disabled={!!busy || expired || (step.review.explanation.verdict === "WARN" && !acknowledged)}
              onClick={() =>
                void run(
                  "Approve the transaction in your wallet",
                  () => signAndSubmit(api, wallet!, address!, step.review, acknowledged),
                  (signature) => setStep({ name: "done", signature }),
                )
              }
            >
              Sign with wallet
            </button>
          )}{" "}
          <button onClick={() => reset()}>Start again</button>
        </section>
      )}

      {expired && <p role="status">Time ran out. Start again.</p>}

      {step.name === "done" && (
        <section>
          <h2>Submitted</h2>
          <p>
            <a href={`https://explorer.solana.com/tx/${encodeURIComponent(step.signature)}?cluster=devnet`} target="_blank" rel="noreferrer">
              View on Solana Explorer
            </a>
          </p>
          <p>Check the Explorer page for the final result.</p>
        </section>
      )}

      {busy && <p role="status">{busy}…</p>}
      {error && <section className="error" role="alert">{error}</section>}
    </main>
  );
}
