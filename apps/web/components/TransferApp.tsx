"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createApi } from "../lib/client/api";
import {
  confirmAndCheck, prepare, signAndSubmit, signIn, submissionOutcome,
  type Card, type Review, type SubmissionOutcome,
} from "../lib/client/flow";
import { lamportsToSol } from "../lib/client/format";
import { browserStorage, clearReceipt, loadReceipt, saveReceipt } from "../lib/client/receipts";
import { findWallet, type WalletProvider } from "../lib/client/wallet";
import { Analyzer } from "./Analyzer";

type Step =
  | { name: "ask"; note?: string }
  | { name: "confirm"; card: Card; deadline: number }
  | { name: "review"; card: Card; review: Review };

/** A transaction sent for submission. It outlives resets, so its result is never lost. */
interface Submission {
  signature: string;
  state: "sending" | SubmissionOutcome;
  note?: string;
}

const SUBMISSION_TITLE: Record<Submission["state"], string> = {
  sending: "Sending. Waiting for Devnet to confirm…",
  confirmed: "Confirmed on Devnet",
  failed: "The transaction failed on Devnet",
  not_sent: "Not sent",
  unknown: "Outcome unknown. Do not send it again yet",
};

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
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  // Bumped on every reset, so that late results from an abandoned request are ignored.
  const generation = useRef(0);
  const [submission, setSubmission] = useState<Submission>();
  // Blocks another transfer until the last one has a known result or the user says they checked it.
  const unsettled = submission?.state === "sending" || submission?.state === "unknown";
  // The wallet whose receipts may be shown.
  const owner = useRef<string>(undefined);

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
      owner.current = undefined;
      setSubmission(undefined);
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

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("solguard_theme");
      if (saved === "light" || saved === "dark") {
        setTheme(saved);
        return;
      }
      if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
        setTheme("light");
      }
    } catch {
      // Ignore storage access errors in restricted environments.
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("solguard_theme", theme);
    } catch {
      // Ignore storage access errors in restricted environments.
    }
  }, [theme]);

  async function run<T>(label: string, work: (isCurrent: () => boolean) => Promise<T>, then: (result: T) => void) {
    const current = ++generation.current;
    const isCurrent = () => current === generation.current;
    setBusy(label);
    setError("");
    try {
      const result = await work(isCurrent);
      if (isCurrent()) then(result);
    } catch (failure) {
      if (!isCurrent()) return;
      // The session ended on the server, so offer to connect again. The request text is kept.
      if (failure instanceof ApiError && failure.status === 401) setAddress(undefined);
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
      // A failed step consumes the server's record, so start over.
      setAcknowledged(false);
      setStep({ name: "ask" });
    } finally {
      if (isCurrent()) setBusy("");
    }
  }

  function connect() {
    const found = findWallet();
    if (!found) return setError("No Solana wallet found. Install MetaMask, Phantom or Solflare and set it to Devnet.");
    void run("Connecting. Approve the sign-in message in your wallet.", () => signIn(api, found), (signedIn) => {
      // The account can change while signing in, before anything is listening for it.
      if (found.publicKey?.toString() !== signedIn) return setError("The wallet account changed. Connect again.");
      setWallet(found);
      setAddress(signedIn);
      owner.current = signedIn;
      const signature = loadReceipt(browserStorage(), signedIn);
      setSubmission(
        signature
          ? { signature, state: "unknown", note: "This transfer had no confirmed result when you left. Check it before sending again." }
          : undefined,
      );
    });
  }

  function signOut() {
    void run("Signing out", () => api("session/logout", {}), () => {
      owner.current = undefined;
      setAddress(undefined);
      setWallet(undefined);
      // The stored receipt stays, and returns when this wallet signs in again.
      setSubmission(undefined);
      setAcknowledged(false);
      setStep({ name: "ask" });
    });
  }

  function sign(review: Review) {
    let sent: string | undefined;
    const signer = address!;
    // A result is always stored, but shown only while its own wallet is the one in use.
    const record = (next: Submission) => {
      if (next.state === "sending" || next.state === "unknown") saveReceipt(browserStorage(), signer, next.signature);
      else clearReceipt(browserStorage(), signer, next.signature);
      if (owner.current === signer) setSubmission(next);
    };
    void run(
      "Approve the transaction in your wallet",
      async (isCurrent) => {
        try {
          const receiptSignature = await signAndSubmit(api, wallet!, address!, review, acknowledged, {
            isCurrent,
            onSubmit: (signature) => {
              sent = signature;
              record({ signature, state: "sending" });
            },
          });
          if (!sent || receiptSignature !== sent) {
            throw new Error("Confirmation could not be established: the submission receipt did not match the signed transaction.");
          }
          record({ signature: sent, state: "confirmed" });
        } catch (failure) {
          if (!sent) throw failure;
          const note = failure instanceof Error ? failure.message : undefined;
          record({ signature: sent, state: submissionOutcome(failure), ...(note ? { note } : {}) });
          if (failure instanceof ApiError && failure.status === 401) setAddress(undefined);
        }
      },
      () => {
        setAcknowledged(false);
        setStep({ name: "ask" });
      },
    );
  }

  const deadline = step.name === "confirm" ? step.deadline : step.name === "review" ? step.review.deadline : 0;
  const secondsLeft = Math.max(0, Math.ceil((deadline - now) / 1000));
  const expired = deadline > 0 && now > 0 && secondsLeft === 0;

  return (
    <main className="app-shell">
      <header>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </span>
          <div className="brand-text">
            <h1>SolGuard</h1>
            <p className="brand-subtitle">Intent-aware transaction firewall</p>
          </div>
          <span className="badge">Solana Devnet only</span>
        </div>

        <div className="header-actions">
          <button
            type="button"
            className="btn-secondary theme-toggle"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
          >
            <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
            <span>{theme === "dark" ? "Light" : "Dark"}</span>
          </button>

          {address ? (
            <span className="wallet-pill">
              <span className="wallet-dot" aria-hidden="true" />
              <code title={address}>{`${address.slice(0, 4)}…${address.slice(-4)}`}</code>{" "}
              <button className="btn-secondary btn-sm" onClick={signOut} disabled={!!busy}>Sign out</button>
            </span>
          ) : (
            <button className="btn-primary" onClick={connect} disabled={!!busy}>Connect wallet</button>
          )}
        </div>
      </header>

      <section className="card">
        <h2>1. Say what you want to send</h2>
        <textarea
          aria-label="Transfer request"
          maxLength={500}
          placeholder="send 0.1 SOL to <address>"
          value={message}
          readOnly={!!busy && step.name === "ask"}
          onChange={(event) => {
            setMessage(event.target.value);
            if (step.name !== "ask") reset("The request changed.");
          }}
        />
        <div className="actions">
          <button
            className="btn-primary"
            disabled={!address || !message.trim() || !!busy || unsettled}
            onClick={() => {
              // A settled result belongs to the previous transfer; do not show it beside a new one.
              setSubmission(undefined);
              void run("Reading your request", () => prepare(api, address!, message), (result) => {
                setAcknowledged(false);
                setStep(
                  "card" in result
                    ? { name: "confirm", card: result.card, deadline: result.deadline }
                    : { name: "ask", note: result.reason },
                );
              });
            }}
          >
            Continue
          </button>
        </div>
        {step.name === "ask" && step.note && <p className="note" role="status">{step.note}</p>}
      </section>

      {(step.name === "confirm" || step.name === "review") && (
        <section className="card">
          <h2>2. Confirm the details</h2>
          <dl>
            <dt>Network</dt><dd>Devnet</dd>
            <dt>From</dt><dd>{step.card.wallet}</dd>
            <dt>To</dt><dd>{step.card.recipient}</dd>
            <dt>Amount</dt><dd>{lamportsToSol(step.card.amountBaseUnits)} SOL</dd>
            <dt>Time left</dt><dd className={secondsLeft <= 15 ? "countdown-low" : ""}>{secondsLeft} s</dd>
          </dl>
          {step.name === "confirm" && (
            <div className="actions">
              <button
                className="btn-primary"
                disabled={!!busy || expired}
                onClick={() =>
                  void run("Building and checking the transaction", () => confirmAndCheck(api, step.card), (review) =>
                    setStep({ name: "review", card: step.card, review }),
                  )
                }
              >
                These details are correct
              </button>{" "}
              <button className="btn-secondary" onClick={() => reset()}>Cancel</button>
            </div>
          )}
        </section>
      )}

      {step.name === "review" && (
        <section className={`card ${step.review.explanation.verdict}`}>
          <h2>3. Security check: {step.review.explanation.verdict}</h2>
          <p className="verdict-headline">{step.review.explanation.headline}</p>
          <ul className="findings-list">
            {step.review.explanation.points.map((point, index) => (
              <li key={index}><strong>{point.ruleId}</strong>: {point.text}</li>
            ))}
          </ul>
          {step.review.explanation.balanceChanges.length > 0 && (
            <>
              <p className="section-label">Simulated balance changes (SOL)</p>
              <dl>
                {step.review.explanation.balanceChanges.filter((change) => !/^[+-]0$/.test(change.changeSol)).map((change) => (
                  <div key={change.account} className="contents">
                    <dt>{change.changeSol}</dt><dd>{change.account}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {step.review.explanation.feeSol && <p className="fee-line">Network fee: <code>{step.review.explanation.feeSol} SOL</code></p>}
          {step.review.explanation.verdict === "WARN" && (
            <p className="ack-box">
              <label>
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />{" "}
                I have read the warning and want to continue
              </label>
            </p>
          )}
          <div className="actions">
            {step.review.explanation.verdict !== "BLOCK" && (
              <button
                className="btn-primary"
                disabled={!!busy || expired || (step.review.explanation.verdict === "WARN" && !acknowledged)}
                onClick={() => sign(step.review)}
              >
                Sign with wallet
              </button>
            )}{" "}
            <button className="btn-secondary" onClick={() => reset()}>Start again</button>
          </div>
        </section>
      )}

      {expired && <p className="status-banner expired" role="status">Time ran out. Start again.</p>}

      {submission && (
        <section aria-live="polite" className={`card ${submission.state === "confirmed" ? "PASS" : submission.state === "sending" ? "" : "WARN"}`}>
          <h2>{SUBMISSION_TITLE[submission.state]}</h2>
          {submission.note && submission.state !== "confirmed" && <p>{submission.note}</p>}
          <p>
            <a className="explorer-link" href={`https://explorer.solana.com/tx/${encodeURIComponent(submission.signature)}?cluster=devnet`} target="_blank" rel="noreferrer">
              View on Solana Explorer
            </a>
          </p>
          {submission.state === "unknown" && (
            <div className="actions">
              <button
                className="btn-secondary"
                onClick={() => {
                  if (address) clearReceipt(browserStorage(), address, submission.signature);
                  setSubmission(undefined);
                }}
              >
                I have checked Explorer
              </button>
            </div>
          )}
        </section>
      )}

      {busy && <p className="status-banner busy" role="status">{busy}…</p>}
      {error && <section className="card error" role="alert">{error}</section>}

      {/* Keyed by wallet, so that one wallet's input and results are never shown to another. */}
      {address && (
        <Analyzer
          key={address}
          api={api}
          address={address}
          onSessionEnd={() => {
            // An open review cannot be signed without a session, so close it too.
            reset("Your session ended. Connect again.");
            setAddress(undefined);
          }}
        />
      )}
    </main>
  );
}
