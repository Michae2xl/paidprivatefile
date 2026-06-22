# Paid Private File

**Live:** https://paidprivatefile.zkglobalcredit.tech/

Sell an encrypted file for Zcash. The decryption key **and** the encrypted file are delivered browser-to-browser over the Nym mixnet, and decrypted only on the buyer's device.

## What it is

A non-custodial marketplace for selling a single file. The seller encrypts a file in their own browser, sets a price in ZEC, and shares a link. The buyer pays and receives the file privately — decrypted locally, never on the server. No email, no accounts, no custody. The server only ever holds ciphertext it cannot read.

## What it uses from Zcash

- **Payment in ZEC on mainnet** — shielded, peer-to-peer money.
- **Non-custodial, view-only.** The seller registers a Unified Address + a view-only **Unified Full Viewing Key (UFVK)**. The platform can **detect** payments but can **never spend** — spending keys never leave the seller's wallet.
- **Per-order address derivation.** A **unique per-order diversified Unified Address** is derived from the UFVK — offline, pure crypto with no spend authority — in the Rust scanner via **`zcash_keys`** (exposed as `POST /derive`). The buyer pays the seller's own account directly; no address is ever pasted.
- **View-only scanning** uses **`zcash_client_backend`** over **`tonic`** gRPC against **lightwalletd** (default `zec.rocks:443`): compact blocks for confirmed payments, plus `GetMempoolStream` + `decrypt_transaction` for instant **0-conf** ("payment detected"). The order settles once confirmations reach the minimum.
- **Zcash stack:** [librustzcash](https://github.com/zcash/librustzcash) — `zcash_client_backend`, `zcash_keys`, `zcash_primitives`, `zcash_protocol`, `zcash_address`, `orchard`, `sapling-crypto`; lightwalletd over `tonic` gRPC.

## What it uses from Nym

- **Private delivery over the Nym mixnet.** The seller's browser and the buyer's browser each run the Nym SDK (WASM) and talk **browser-to-browser through the mixnet** — no server relays anything.
- **Both the wrapped decryption key and the encrypted file** travel over the mixnet (a chunked, paced, retransmitting transfer), so the network sees no metadata about who sends what to whom. An automatic HTTPS fallback covers a failed transfer.

---

Deeper detail (architecture, trust model, reliability, limits, running locally): see [ARCHITECTURE.md](ARCHITECTURE.md).
