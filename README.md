# Paid Private File

Sell an encrypted file for Zcash. The decryption key **and** the encrypted file are delivered browser-to-browser over the Nym mixnet, and decrypted only on the buyer's device.

## What it is

A non-custodial marketplace for selling a single file. The seller encrypts a file in their own browser, sets a price in ZEC, and shares a link. The buyer pays and receives the file privately — decrypted locally, never on the server. No email, no accounts, no custody. The server only ever holds ciphertext it cannot read.

## What it uses from Zcash

- **Payment in ZEC on mainnet** — shielded, peer-to-peer money.
- **Non-custodial, view-only.** The seller registers a Unified Address + a view-only **Unified Full Viewing Key (UFVK)**. The platform derives a **unique per-order shielded address** from the UFVK; the buyer pays the seller's own account directly. The platform can **detect** payments but can **never spend** — the spending keys never leave the seller's wallet.
- **View-only detection** via librustzcash + lightwalletd (a Rust scanner), including an instant **0-conf mempool** sighting ("payment detected"); the order settles once confirmations reach the minimum.

## What it uses from Nym

- **Private delivery over the Nym mixnet.** The seller's browser and the buyer's browser each run the Nym SDK (WASM) and talk **browser-to-browser through the mixnet** — no server relays anything.
- **Both the wrapped decryption key and the encrypted file** travel over the mixnet (a chunked, paced, retransmitting transfer), so the network sees no metadata about who sends what to whom. An automatic HTTPS fallback covers a failed transfer.

---

Deeper detail (architecture, trust model, reliability, limits, running locally): see [ARCHITECTURE.md](ARCHITECTURE.md).
