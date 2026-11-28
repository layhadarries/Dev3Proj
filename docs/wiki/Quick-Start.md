# Quick start

1. Start the Next.js app using the [installation guide](Installation).
2. Open `http://localhost:3000` or the configured HTTPS origin.
3. Connect a funded Devnet wallet.
4. Sign the server-issued authentication challenge.
5. Enter a natural-language transfer for a test recipient. The integrated app can submit on Devnet, so use only disposable test funds.
6. Review the server card: network, wallet, asset, recipient and integer lamports.
7. Confirm the card only from the explicit confirmation action.
8. Review the built transaction and security verdict:
   - **PASS**: required checks passed.
   - **WARN**: a warning requires explicit separate acknowledgement.
   - **BLOCK**: signing remains disabled.
9. Handoff the unsigned verified transaction to the wallet.
10. Approve signing in the wallet; do not use sign-and-send.
11. The server verifies the exact signed bytes and broadcasts at most once.
12. Wait for confirmed/finalized status or treat 504 as uncertain. The local HTTP request is aborted at its deadline, but the RPC provider may already have accepted the transaction.

If the outcome is uncertain, do not press submit again. Reconcile the displayed
signature on the Devnet explorer or RPC, then restart only after the in-flight
approval has been rejected or consumed.
