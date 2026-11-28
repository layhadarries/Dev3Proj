"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, type Api } from "../lib/client/api";
import { analyze, describeInstructions, exampleAttack, type Analysis, type Example } from "../lib/client/analyze";
import { lamportsToSol } from "../lib/client/format";

const HEADLINE = {
  PASS: "This transaction matches what you described. Passing checks does not guarantee safety or the final result.",
  WARN: "Read the warnings. A warning does not prove anything is malicious.",
  BLOCK: "Do not sign this transaction.",
};

const EMPTY = { recipient: "", amountSol: "", transaction: "" };

/** Checks a transaction built by another app. It never asks the wallet to sign. */
export function Analyzer({ api, address, onSessionEnd }: { api: Api; address: string; onSessionEnd(): void }) {
  const [input, setInput] = useState(EMPTY);
  const [example, setExample] = useState(false);
  const [result, setResult] = useState<Analysis>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Bumped on every edit, so that a late result is never shown beside different input.
  const generation = useRef(0);
  // Also when this panel goes away, so that an old reply cannot end a newer session.
  useEffect(() => () => void (generation.current += 1), []);

  function change(next: typeof input, isExample: boolean) {
    generation.current += 1;
    setInput(next);
    setExample(isExample);
    setResult(undefined);
    setError("");
    setBusy(false);
  }
  const edit = (field: keyof typeof EMPTY, value: string) => change({ ...input, [field]: value }, false);
  const load = (kind: Example) => change(exampleAttack(kind, address), true);

  async function check() {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const analysis = await analyze(api, input);
      if (current === generation.current) setResult(analysis);
    } catch (failure) {
      if (current !== generation.current) return;
      if (failure instanceof ApiError && failure.status === 401) return onSessionEnd();
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  return (
    <details className="card analyzer">
      <summary>Check a transaction from another app</summary>
      <p className="note">
        Say what you meant to send, paste the unsigned transaction, and SolGuard compares the two. It does not sign or
        send anything.
      </p>
      <div className="actions">
        <button type="button" className="btn-secondary btn-sm" onClick={() => load("extra")}>
          Example: hidden extra transfer
        </button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => load("recipient")}>
          Example: swapped recipient
        </button>
      </div>
      {example && <p className="note" role="status">This is a made-up test transaction, not one from a real app.</p>}
      <label>
        Amount you meant to send (SOL)
        <input type="text" inputMode="decimal" maxLength={22} value={input.amountSol} onChange={(event) => edit("amountSol", event.target.value)} />
      </label>
      <label>
        Recipient you meant to pay
        <input type="text" maxLength={44} spellCheck={false} value={input.recipient} onChange={(event) => edit("recipient", event.target.value)} />
      </label>
      <label>
        Unsigned transaction (base64)
        <textarea maxLength={2000} spellCheck={false} value={input.transaction} onChange={(event) => edit("transaction", event.target.value)} />
      </label>
      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={busy || !input.amountSol.trim() || !input.recipient.trim() || !input.transaction.trim()}
          onClick={check}
        >
          Check transaction
        </button>
      </div>
      {busy && <p className="status-banner busy" role="status">Checking the transaction…</p>}
      {error && <p className="note error" role="alert">{error}</p>}
      {result && (
        <section className={`verdict ${result.explanation.verdict}`} aria-label="Analysis result">
          <h2>Analysis: {result.explanation.verdict}</h2>
          <p className="verdict-headline">{HEADLINE[result.explanation.verdict]}</p>
          <ul className="findings-list">
            {result.explanation.points.map((point, index) => (
              <li key={index}><strong>{point.ruleId}</strong>: {point.text}</li>
            ))}
          </ul>
          <p className="section-label">You meant to</p>
          <p className="intended">
            Send {lamportsToSol(result.intended.amountBaseUnits)} SOL to <code>{result.intended.recipient}</code>
          </p>
          <p className="section-label">The transaction would</p>
          {result.report.decodedInstructions.length === 0 ? (
            <p>Its instructions could not be accepted, so none are listed.</p>
          ) : (
            <ol className="instructions">
              {describeInstructions(result).map((line) => (
                <li key={line.number} value={line.number} className={line.flagged ? "flagged" : undefined}>
                  {line.text}
                  {line.flagged && <strong> (not what you asked for)</strong>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </details>
  );
}
