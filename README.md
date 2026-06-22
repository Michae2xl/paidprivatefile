# Paid Private File

Pay in ZEC. The decryption key **and** the encrypted file are delivered browser-to-browser over the Nym mixnet. The file is decrypted only on the buyer's device.

Paid Private File is a non-custodial marketplace for selling a single file. A seller creates a shop (a public route plus a Zcash Unified Address and a view-only Unified Full Viewing Key), encrypts a file in their own browser, uploads the ciphertext, and shares a link. A buyer opens the link, pays real ZEC on mainnet to an address derived from the seller's own account, and receives the file privately over the Nym mixnet — decrypted locally, never on the server.

The platform is non-custodial end to end: the seller's spending keys never leave their wallet (the platform only ever holds a view-only viewing key and can never spend), and the server only ever holds ciphertext it cannot read.

## How it works

### Seller

1. **Create a shop.** Pick a public route (`/s/<handle>`), a public display name, and paste a dedicated account's **view-only viewing key (UFVK)**. The platform derives a receiving address from it server-side — you never paste a payment address. Login is by a one-time **access key** (`ppf_...`); there is no email. Save the access key — it is shown once and only its hash is stored.
2. **Upload a file.** The file is **AES-256-GCM encrypted in your browser** before upload. The AES file key (the "release secret") never leaves the browser. Set a price in ZEC.
3. **Copy the link** and send it to the buyer.
4. **Keep the tab open during delivery.** Your browser is the source of the encrypted file over Nym. After the buyer pays, your browser wraps the file key for the buyer and streams the key and the encrypted file over the mixnet, automatically re-sending until the buyer confirms receipt.

The seller dashboard has two tabs: **Files** (your orders and their live status) and **Settings** (the receiving account, viewing key, and network).

### Buyer

1. **Open the link.** The order loads automatically, the payment address and QR appear with no button, and a private Nym receiver is set up in your browser in the background.
2. **Pay in ZEC.** Scan the QR and pay. The instant the scanner sees your payment in the mempool, the page shows "Payment detected" (the file stays locked until the payment confirms).
3. **Receive over Nym.** Once the payment confirms, the seller's browser delivers the wrapped decryption key and the encrypted file to your browser over the Nym mixnet. A progress bar tracks the file as it streams in.
4. **The file opens on your device.** The encrypted file is decrypted locally and auto-downloads. A badge shows whether it arrived "over Nym (mixnet)" or "over HTTPS (Nym fallback)".

In the normal path the buyer never sees or pastes a Nym address — manual entry is a fallback only.

## Privacy & trust model

The strong, accurate claims:

- **Non-custodial.** The seller's spending keys never leave their wallet. The platform holds only a view-only UFVK and can never spend or move funds. The buyer pays an address derived from the seller's own account, so funds go straight to the seller.
- **End-to-end encrypted.** The file is encrypted in the seller's browser. The server only ever holds ciphertext it cannot read — it has neither the AES file key nor the buyer's private key.
- **Private delivery.** The decryption key and the encrypted file are delivered browser-to-browser over the Nym mixnet (with an automatic HTTPS fallback). They are decrypted only on the buyer's device.

### What the server can and cannot see

The server is **zero-knowledge of content**, but it is not absent — it coordinates orders and payment detection. Do not read this as "no server" or "nothing touches the server."

The server **does** hold:

- The AES-encrypted file (ciphertext) — kept so the HTTPS fallback can serve it.
- A key envelope encrypted for the buyer's P-256 public key (in the server-relayed paths); in the browser-direct Nym path the key transits the mixnet and is not relayed by the server.
- Order metadata: price, filename, MIME type, original/encrypted size, the ciphertext SHA-256, the buyer's public key (after payment), the seller's payout address, and Nym session addresses.

The server **cannot**:

- Decrypt the file (no AES file key).
- Read the key envelope (no buyer private key).
- Spend or move ZEC (it holds only a view-only viewing key).

Threat-model limit (honest): seller-held custody protects against an honest-but-curious server. It is not unconditionally trustless — the server is the source of the buyer public key the seller wraps to, so a malicious/compromised server could substitute its own key. The app mitigates this with an out-of-band buyer verification code (a short fingerprint of the buyer's public key) and a manual, verified release path. Auto-release on payment is the convenience default and does not perform that out-of-band check. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full threat model.

## Architecture

Three services plus the public networks:

- **Next.js app** (this repo) — order/shop state, payment-intent creation, the buyer/seller UI, ciphertext storage, the signed webhook + watchlist endpoints. Deployed on Railway with a mounted volume at `/data`. Sets COOP/COEP cross-origin-isolation headers (`next.config.ts`) so the in-browser Nym WASM client can run.
- **Rust scanner** (`ppf-scanner`) — the sole holder of seller UFVKs (encrypted at rest). View-only payment detection over hosted lightwalletd gRPC (librustzcash stack), including an instant 0-conf mempool sighting. Exposes an HMAC-authed HTTP API (`/validate`, `/sellers/register`, `/derive`, `/health`).
- **Nym mixnet** — the private browser-to-browser delivery transport (Nym browser WASM SDK).
- **Zcash mainnet** via lightwalletd — the payment rail.

Data flow:

```txt
SELLER BROWSER                         SERVER (Next.js, /data volume)         RUST SCANNER (holds UFVKs)        ZCASH / NYM
─────────────                          ─────────────────────────────         ─────────────────────────        ───────────
encrypt file (AES-256-GCM)
AES key stays local  ───── ciphertext + metadata ─────►  store order + ciphertext
                                                          (no file key, no plaintext)

                              BUYER opens link
                                       │
                       buyer P-256 key + Nym addr ─────►  payment-intent
                                                          derive per-order address ──── /derive ────►  diversified UA
                                                          from seller UFVK         ◄─────────────────  (from seller UFVK)
                              show QR / address ◄────────
                                       │
                              pay ZEC ──────────────────────────────────────────────────────────────►  on-chain deposit
                                                                              scanner sees mempool tx ◄──  (0-conf)
                                                          webhook confirmations:0 ◄── signed (HMAC) ───
                              "Payment detected" ◄────────
                                                                              confirmations >= min  ◄───
                                                          webhook → order paid ◄── signed (HMAC) ─────
SELLER tab (must stay open):
 wrap AES key for buyer
 stream key + encrypted file ════════════════ over the Nym mixnet (browser → browser) ═══════════════►  BUYER BROWSER
                                                                                                         reassemble (chunked + ARQ)
                                                                                                         SHA-256 verify
                                                          status-only delivery ack ◄── POST /delivered  decrypt locally → file opens
                                                          (via: nym | https)
```

If the Nym transfer stalls, the buyer automatically falls back to fetching the encrypted file over HTTPS (the ciphertext is uploaded precisely so this fallback exists). The decryption stays local in both paths.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the deep version and [docs/NYM.md](docs/NYM.md) for the mixnet transport.

## Limits

- **File size:** up to 50 MB (`MAX_TRANSFER_BYTES = 50 * 1024 * 1024`; the create route caps the request body at ~54 MB).
- **File type:** any file type (no allowlist). Images preview inline; other types download.
- **Mixnet throughput:** ~46 KiB/s (the Nym gateway drain rate). Large files are slow over Nym — a 50 MB file is roughly ~17 minutes. The transfer pacing targets ~48 KiB/s in 32 KiB chunks.
- **Seller must stay online.** The seller's browser is the source of the encrypted file during the Nym transfer; it must keep the tab open until delivery completes.
- **One buyer per order.** An order binds the first buyer key that opens it; the release secret is browser-local to the creating browser.

## Running locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

Validation:

```bash
npm run check
npm test
npm run build
```

The Rust scanner lives in a separate repo (`ppf-scanner`); it is only needed for real on-chain payment detection.

## Configuration

Read from the code; set the ones you need.

**App — Zcash on-chain gate & payments**

- `PAID_PRIVATE_FILE_ZCASH_ONCHAIN=1` — switch the payment rail to real on-chain ZEC (off = dev/CipherPay path).
- `PAID_PRIVATE_FILE_ZCASH_MIN_CONFIRMATIONS` — confirmations required before an order settles paid (default 10).
- `PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET` — HMAC-SHA256 secret for the payment webhook (`POST /api/webhooks/zcash`, header `x-zcash-signature`). Required for the endpoint.
- `PAID_PRIVATE_FILE_ZCASH_POOL_SECRET` — HMAC secret for the address-pool and watchlist endpoints. Required for those endpoints.

**App — scanner integration**

- `PPF_SCANNER_URL` — base URL of the Rust scanner.
- `PPF_SCANNER_SECRET` — HMAC secret for the scanner API (`x-ppf-scanner-sig`).
- `PPF_SCAN_DEFAULT_START_HEIGHT` — optional scan start height (default 0 = full rescan).

**App — browser-to-browser Nym delivery**

- `PAID_PRIVATE_FILE_BROWSER_NYM_DELIVERY=1` — server: claim returns `deliveryMode: "browser-nym"` (no key envelope over HTTP).
- `NEXT_PUBLIC_PPF_BROWSER_NYM=1` — client: enable browser-direct key delivery over the mixnet.
- `NEXT_PUBLIC_PPF_BROWSER_NYM_FILE` — client: browser-to-browser file transfer over Nym. Defaults on when browser-nym is on; set `=0` to force HTTPS-only file delivery, `=1` to force on.

**App — secrets & runtime**

- `PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET` — HMAC secret for short-lived signed ciphertext download tokens (falls back to a public dev default — set it in production).
- `PAID_PRIVATE_FILE_AUTH_SECRET` — seller session signing secret (set it in production).
- `PAID_PRIVATE_FILE_RUNTIME_DIR` — order/ciphertext storage root (defaults to the OS temp dir; mount a volume in production).
- `PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY=1` — require Nym delivery on claim (no key/URL in the HTTP claim response).

**Scanner (`ppf-scanner`)**

- `PPF_SCANNER_SECRET`, `PPF_APP_URL`, `PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET`, `PAID_PRIVATE_FILE_ZCASH_POOL_SECRET` — required.
- `PPF_LIGHTWALLETD_URL` (default `https://zec.rocks:443`), `PPF_SCAN_INTERVAL_MS` (default 30000), `PPF_MIN_CONFIRMATIONS` (default 3), `PPF_SCANNER_DATA_DIR` (default `/data`), `PPF_SCANNER_UFVK_KEY` (required 32-byte hex for at-rest UFVK encryption).

## Deployment

Deployed on Railway as the standalone `paidprivatefile` service (`paidprivatefile-production.up.railway.app`), Node 20 pinned (Next requires Node >= 20.9). Mount a Railway volume and point `PAID_PRIVATE_FILE_RUNTIME_DIR` at it for durable order/ciphertext storage — the default OS temp dir is ephemeral and wiped on redeploy. The Rust scanner deploys as its own service with a persistent volume at `/data` for the encrypted UFVK store.

## Status

**Full real E2E proven in production:** a real ZEC mainnet payment → view-only detection (including instant 0-conf mempool sighting) → seller-held key release → browser-to-browser delivery of the decryption key **and** the encrypted file over the Nym mixnet → local decrypt and download. The file-over-Nym transfer was proven live with a 3 MB file (progress climbed 22% → 80% → 100%); HTTPS is retained only as an automatic fallback.

## License

TBD.
