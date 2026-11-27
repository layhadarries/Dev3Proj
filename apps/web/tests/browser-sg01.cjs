/* eslint-disable @typescript-eslint/no-require-imports, no-undef, no-empty */
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const process = require("node:process");
const bs58 = require("bs58").default;
const {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedMessage,
  VersionedTransaction,
} = require("@solana/web3.js");

const origin = "http://127.0.0.1:3100";
const owner = Keypair.generate();
const recipient = Keypair.generate();
const blockhash = Keypair.generate().publicKey.toBase58();
const address = owner.publicKey.toBase58();
const recipientAddress = recipient.publicKey.toBase58();
const mockSignatureBytes = new Uint8Array(64).fill(1);
const mockSignature = bs58.encode(mockSignatureBytes);
const cardId = "11111111-1111-4111-8111-111111111111";

function unsignedWire() {
  const tx = new Transaction({
    feePayer: owner.publicKey,
    blockhash,
    lastValidBlockHeight: 123,
  }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 5,
    }),
  );
  return Buffer.from(
    new VersionedTransaction(VersionedMessage.deserialize(tx.serializeMessage())).serialize(),
  ).toString("base64");
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Production app did not start");
}

async function runScenario(browser, name, submitReply) {
  const page = await browser.newPage();
  let submitCalls = 0;
  const wire = unsignedWire();
  const messageBase64 = Buffer.from(
    VersionedTransaction.deserialize(Buffer.from(wire, "base64")).message.serialize(),
  ).toString("base64");
  await page.addInitScript(({ mockAddress, signatureBytes }) => {
    const account = {
      publicKey: { toString: () => mockAddress },
      connect: async () => {},
      signMessage: async () => ({ signature: new Uint8Array(64).fill(2) }),
      signTransaction: async (transaction) => {
        transaction.signatures[0] = new Uint8Array(signatureBytes);
        return transaction;
      },
      on: () => {},
      off: () => {},
    };
    Object.defineProperty(window, "phantom", {
      configurable: true,
      value: { solana: account },
    });
  }, { mockAddress: address, signatureBytes: Array.from(mockSignatureBytes) });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api\//, "");
    if (path === "session/challenge") return json(route, { message: "SolGuard Devnet sign-in\nWallet: mock" });
    if (path === "session") return json(route, { wallet: address });
    if (path === "session/logout") return json(route, { ok: true });
    if (path === "parse") return json(route, {
      status: "ready",
      draft: { recipient: recipientAddress, amountBaseUnits: "5" },
      source: "rules",
    });
    if (path === "stage") return json(route, {
      id: cardId,
      network: "devnet",
      wallet: address,
      asset: "SOL",
      recipient: recipientAddress,
      amountBaseUnits: "5",
      expiresAt: Date.now() + 60_000,
    });
    if (path === "confirm") return json(route, {
      intent: {
        id: cardId,
        kind: "transfer",
        asset: { type: "SOL" },
        payer: address,
        recipient: recipientAddress,
        amountBaseUnits: "5",
        confirmedAt: Date.now(),
      },
    });
    if (path === "build") return json(route, {
      transaction: {
        intentId: cardId,
        messageBase64,
        messageHash: "h",
        recentBlockhash: blockhash,
        lastValidBlockHeight: 123,
      },
      report: {
        intentId: cardId,
        messageHash: "h",
        verdict: "PASS",
        findings: [],
        decodedInstructions: [],
        simulation: null,
        feeLamports: "5001",
        checkedAtSlot: 100,
        generatedAt: Date.now(),
        engineVersion: "test",
      },
    });
    if (path === "explain") return json(route, {
      verdict: "PASS",
      headline: "The transfer is ready.",
      points: [],
      balanceChanges: [],
      feeSol: "0.000005",
    });
    if (path === "handoff") return json(route, { wire });
    if (path === "submit") {
      submitCalls += 1;
      return json(route, submitReply);
    }
    return json(route, { error: "Not found" }, 404);
  });

  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("textbox", { name: "Transfer request" }).fill("send 5 lamports to test");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "These details are correct" }).waitFor();
  await page.getByRole("button", { name: "These details are correct" }).click();
  await page.getByRole("button", { name: "Sign with wallet" }).waitFor();
  await page.getByRole("button", { name: "Sign with wallet" }).click();

  if (submitReply && submitReply.signature === mockSignature) {
    await page.getByRole("heading", { name: "Confirmed on Devnet" }).waitFor();
  } else {
    await page.getByRole("heading", { name: /Outcome unknown/ }).waitFor();
    await page.getByText(/Confirmation could not be established|The server's reply|submission/i).first().waitFor();
  }

  const confirmedHeading = await page.getByRole("heading", { name: "Confirmed on Devnet" }).count();
  if (submitReply && submitReply.signature === mockSignature) {
    if (confirmedHeading !== 1) throw new Error(`${name}: matching receipt did not confirm`);
  } else if (confirmedHeading !== 0) {
    throw new Error(`${name}: invalid receipt displayed confirmed`);
  }

  const explorer = page.locator('a[href*="explorer.solana.com/tx/"]');
  await explorer.waitFor();
  const href = await explorer.getAttribute("href");
  if (!href.includes(mockSignature)) throw new Error(`${name}: Explorer link does not retain expected signature`);

  if (submitReply && submitReply.signature === mockSignature) {
    if (submitCalls !== 1) throw new Error(`${name}: expected one submit, got ${submitCalls}`);
  } else {
    const continueButton = page.getByRole("button", { name: "Continue" });
    if (!(await continueButton.isDisabled())) throw new Error(`${name}: Continue was not blocked`);
    if (submitCalls !== 1) throw new Error(`${name}: expected one submit, got ${submitCalls}`);
  }
  await page.close();
  console.log(`${name}: pass (submits=${submitCalls})`);
}

(async () => {
  const server = spawn("./node_modules/.bin/next", ["start", "-p", "3100"], {
    cwd: process.cwd(),
    env: { ...process.env, APP_ORIGIN: origin, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    await runScenario(browser, "empty response", {});
    await runScenario(browser, "mismatched receipt", { signature: bs58.encode(new Uint8Array(64).fill(7)) });
    await runScenario(browser, "matching receipt", { signature: mockSignature });
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
