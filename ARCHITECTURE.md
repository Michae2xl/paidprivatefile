# Paid Private File — Architecture

## Goal

Paid Private File is a **non-custodial marketplace** for selling a single file:

> Pay in ZEC to an address derived from the seller's own account. The decryption key and the encrypted file are delivered browser-to-browser over the Nym mixnet. The file is decrypted only on the buyer's device.

Two invariants drive the whole design:

1. **Non-custodial payment.** The seller's spending keys never leave their wallet. The platform holds only a view-only Unified Full Viewing Key (UFVK) and can never spend. Each order is paid to a unique address derived from that UFVK, so funds go straight to the seller's own account.
2. **End-to-end encryption.** The file is AES-256-GCM encrypted in the seller's browser before upload. The server only ever holds ciphertext it cannot read — it has neither the AES file key nor the buyer's private key. The key and file reach the buyer over Nym and are decrypted locally.

This is **pure seller-held key custody**. Orders are created with a `release_secret_hash` only (the SHA-256 of a random 32-byte secret). The seller browser keeps the raw `file_key` and `release_secret` locally and is the only party that can produce the buyer-wrapped key envelope. The tradeoff: the seller must keep the tab open after payment to release the key and stream the file.

## The three services and their boundaries

```txt
Next.js app (this repo, Railway, /data volume)
  - no-email seller shops (handle + access key) and public routes /s/<handle>
  - file orders + ciphertext storage (encrypted bytes only, never the file key)
  - per-order deposit-address derivation (calls the scanner)
  - payment-intent creation; records the buyer public key on the intent
  - signed watchlist + signed payment webhook (HMAC)
  - buyer/seller UI (browser crypto, browser Nym client)
  - status-only delivery acknowledgement
  - COOP/COEP headers so the browser Nym WASM client can run (next.config.ts)

Rust scanner (ppf-scanner, its own service + /data volume)
  - SOLE holder of seller UFVKs, AES-256-GCM encrypted at rest
  - HMAC-authed HTTP API: /validate, /sellers/register, /derive, /health
  - confirmed-block scan loop: view-only note detection via lightwalletd gRPC
  - mempool watcher: 0-conf "payment detected" sightings (GetMempoolStream)
  - posts the signed payment webhook back to the app
  - librustzcash stack (zcash_client_backend / zcash_keys / zcash_primitives)

Nym mixnet (browser WASM SDK)
  - browser-to-browser delivery of BOTH the wrapped key and the encrypted file
```

The app never sees a seller's viewing key after registration — it holds only an opaque `scanRef` issued by the scanner, the derived per-order deposit addresses, and a UFVK fingerprint. The scanner never sees plaintext files, order prices beyond the watchlist amount, or buyer keys. Neither service can spend ZEC.

## Where Nym enters — THE KEY CHANGE

In earlier versions Nym carried only the wrapped key (`nym-claim-v1`), and the encrypted file was always fetched over HTTPS. **Now both the wrapped decryption key and the encrypted file are delivered browser-to-browser over the mixnet, seller browser → buyer browser.** Delivery is **100% over the mixnet** — the HTTPS fallback is **disabled by default** (see [HTTPS fallback](#https-fallback-disabled-by-default)).

Transport modes still labelled in the order state:

- `nym-claim-v1` — the wrapped key envelope rides the mixnet.
- `nym-transfer-v1` — the encrypted file itself rides the mixnet (the chunked transfer below).

Browser-direct delivery requires no server-side `nym-client`: the seller browser and buyer browser each run `@nymproject/sdk-full-fat` and talk to each other through the mixnet directly. The server never relays the key in this path.

## Order state machine

```txt
created -> payment_pending -> paid -> claimed
```

- `created` — seller uploaded ciphertext + metadata.
- `payment_pending` — a buyer created a payment intent (and a per-order deposit address was bound).
- `paid` — the payment confirmed on-chain at `>= min confirmations`.
- `claimed` — the buyer claimed (browser-direct Nym mode marks claimed and returns the signed ciphertext URL; the key + file then transit the mixnet).

A claim before `paid`, before a registered Nym session, or before the seller has released the key returns `payment_required`. A 0-conf sighting records `detectedAt` and the onchain txid for the "Payment detected" UI but never flips status to paid — release stays gated on the confirmed transition.

## Non-custodial payment: per-order address derivation

On payment-intent creation, when `PAID_PRIVATE_FILE_ZCASH_ONCHAIN=1` and the order's seller has a registered UFVK (`scanRef`):

1. The app asks the scanner for the next diversifier index for the seller and calls `POST /derive` (`{ scanRef, diversifierIndex }`) on the scanner.
2. The scanner decrypts the UFVK in memory, derives a **diversified Unified Address**, validates it independently, and returns `{ address, actualIndex }` — never the UFVK.
3. The app binds that address to the order (`deposit-bindings`) so the webhook can later map a deposit back to this order, and returns the address to the buyer.

If the seller has no UFVK, the app falls back to the legacy pre-registered global address pool (back-compat single-seller path; not removed).

## View-only payment detection (the scanner)

The scanner runs two loops against hosted lightwalletd over gRPC+TLS:

- **Confirmed-block scan loop** (`scanloop`): pulls the app's signed watchlist (one entry per open `payment_pending` order with a UFVK binding, carrying only the opaque `scanRef`, deposit address, diversifier index, start height, and amount). It groups entries by `scanRef`, resolves each to the stored UFVK, scans compact blocks from `min(startHeight)` to the chain tip, attributes received notes to watched diversified addresses by recipient byte-compare, and — for any note meeting `confirmations >= min` and `value >= order amount` — POSTs the signed webhook.
- **Mempool watcher** (`mempool`): subscribes to `CompactTxStreamer.GetMempoolStream`, parses each full transaction (`Transaction::read`), and trial-decrypts its shielded outputs against the same watched UFVKs (`zcash_client_backend::decrypt_transaction`). On a match it POSTs the **same** signed webhook with `confirmations: 0` so the buyer sees "Payment detected" instantly. Detection only — it never settles, dedups on `(orderId, txid)`, and never inflates the confirmation count.

The scanner is the sole holder of seller UFVKs (AES-256-GCM encrypted at rest under `PPF_SCANNER_UFVK_KEY`). It can detect payments but can never spend.

## Webhook / scanner HMAC contract

Three HMAC-SHA256 crossings, each over the raw request body, compared timing-safe:

- **App → scanner** (`/validate`, `/sellers/register`, `/derive`): header `x-ppf-scanner-sig`, secret `PPF_SCANNER_SECRET`. A missing/invalid signature returns 401.
- **Scanner → app watchlist pull** (`POST /api/transfers/payments/zcash/watchlist`): header `x-zcash-signature`, secret `PAID_PRIVATE_FILE_ZCASH_POOL_SECRET`. Returns the deposit addresses + `scanRef`s for open orders. The watchlist drops orders older than its TTL (24h) so abandoned orders stop being scanned.
- **Scanner → app payment webhook** (`POST /api/webhooks/zcash`): header `x-zcash-signature` (optional `sha256=` prefix accepted), secret `PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET`. If the secret is unset the endpoint rejects (never silently accepts).

Webhook body: `{ receivingAddress, amountZats, txid, confirmations, sellerId? }`.

Settlement rules in the webhook handler:

- Map `receivingAddress` → order; it must match `payment.receivingAddress` (else reject).
- If `sellerId` is present it must match the order's seller, else respond `200 { ok: true, ignored: true, reason: "seller_mismatch" }` (a 200 ignore, not an error, so a diverged/stale binding doesn't spam logs — the order simply never settles).
- `amountZats < order price` → `200 { ok: true, ignored: true, reason: "underpayment" }`.
- `confirmations < min` → record an unconfirmed sighting (`markTransferDetectedOnchain`, stamps `detectedAt`), respond `200 { ok: true, detected: true }`. Does NOT settle.
- `amountZats >= price` AND `confirmations >= min` → `markTransferPaidOnchain` (records `payment.onchain = { txid, amountZats, confirmations, paidAt }`, flips to `paid`, runs the Nym-session readiness transition).
- Replaying the same `txid` after settlement is idempotent; a paid/claimed order never regresses.

`min` = `PAID_PRIVATE_FILE_ZCASH_MIN_CONFIRMATIONS` (default 10).

## Seller-held key custody

```txt
random file_key -> AES-256-GCM -> encrypted file   (in the seller browser)
```

1. The seller browser encrypts the file, derives a random `release_secret`, and uploads the ciphertext + IV + `release_secret_hash`. The raw `file_key` and `release_secret` stay in a local seller vault (localStorage). The create route requires `releaseSecretHash` (64-hex) and rejects any uploaded `fileKey`.
2. The buyer pays; the payment intent records the buyer's P-256 public key (`buyerPublicKeyJwk`) on the order.
3. The seller browser calls `POST /api/transfers/:orderId/key-release`. The release challenge discloses the buyer public key only once payment is confirmed. The seller browser derives an ECDH wrapping key (P-256), wraps `file_key` for the buyer (`p256-ecdh-aes-gcm-v1`), and posts back the envelope.
4. Release is **monotonic** — once an envelope is stored it cannot be replaced (a second release, or release after claim, is rejected), so a leaked `release_secret` cannot swap the file after the sale.

Scheme labels: `aes-256-gcm-v1` (file), `p256-ecdh-aes-gcm-v1` (key envelope).

## Nym browser-to-browser key + file delivery

Gated by `PAID_PRIVATE_FILE_BROWSER_NYM_DELIVERY=1` (server) and `NEXT_PUBLIC_PPF_BROWSER_NYM=1` (client). File-over-Nym is additionally gated by `NEXT_PUBLIC_PPF_BROWSER_NYM_FILE` (on by default when browser-nym is on).

### Key delivery

- The buyer browser runs an in-page Nym receiver and registers its `buyerNymAddress` via `POST /api/transfers/:orderId/nym-session`.
- The seller browser releases the key (server POST kept for the record + monotonic guard), reads `release.buyerNymAddress` from the challenge, and sends `{ schema: "paidprivatefile.nym.claim.v1", orderId, keyEnvelope }` to that address with the SDK's `client.send({ payload: { message, mimeType: "application/json" }, recipient })`.
- `POST /api/transfers/:orderId/claim` returns `deliveryMode: "browser-nym"` with the signed ciphertext `download` URL **and no `keyEnvelope`** (it does not queue server-side Nym delivery). The key transits the mixnet.

### File delivery — the chunked transfer protocol (`lib/nym-file-transfer.ts`)

A clean-room, framework-agnostic reliable-bytes layer over the SDK's binary `rawSend` / `subscribeToRawMessageReceivedEvent`. It does no key agreement (the bytes are already AES-256-GCM ciphertext and the buyer is already authenticated by the ECDH key envelope) — it is purely a reliable transport.

- **Framing.** Every packet is a 48-byte header (`magic "NF"`, version, type, 32-byte orderId, `seq`, `total`, `payloadLength`) plus payload. Types: `Offer`, `Chunk`, `Ack`, `Retransmit`, `Done`.
- **Chunking.** 32 KiB application chunks (`DEFAULT_CHUNK_SIZE`). The `Offer` carries `{ size, sha256, chunkSize, senderAddress }`.
- **Rate pacing.** ~48 KiB/s (`DEFAULT_RATE_BYTES_PER_SEC`) via an inter-chunk sleep, because the Nym gateway drains ~46 KiB/s; unpaced sends were observed to hang.
- **Reorder buffer.** The receiver stores chunks in a `Map<seq, bytes>` and reassembles order-independently.
- **Selective retransmit / ARQ.** After a silence gap (`DEFAULT_GAP_TIMEOUT_MS = 30s`), or immediately on `Done`, the receiver sends a `Retransmit{seq}` for its first missing chunk to the sender's address. The sender re-streams that chunk plus a small forward window (`DEFAULT_RETRANSMIT_WINDOW = 4`), single-flight so overlapping requests are coalesced rather than self-amplifying.
- **Integrity.** A SHA-256 over the whole ciphertext is pinned in the `Offer` and re-verified after reassembly, and also checked against the order's `encryptedFileSha256`. A mismatch rejects.
- **Completion.** On a verified reassembly the receiver sends `Ack`; the sender's `done()` resolves on the Ack (with an ack timeout). With the HTTPS fallback off (the default), the receiver runs with a generous **6 h** overall ceiling (`NYM_RECEIVE_NO_FALLBACK_TIMEOUT_MS`) so even a slow, congested large transfer finishes over Nym rather than aborting.

On the buyer side, the reassembled-and-verified ciphertext is decrypted with the key envelope received over the Nym **text** channel, reusing the exact same crypto path as the HTTPS claim — so the file opens locally either way.

### HTTPS fallback (disabled by default)

The encrypted file is **also** uploaded to the server (it is the source for re-streaming and the `encryptedFileSha256` integrity check), so a buyer _could_ fetch it over HTTPS via a short-lived signed URL (HMAC token, 10-min TTL) and decrypt locally.

**This HTTPS fallback is OFF by default** (`BROWSER_NYM_HTTPS_FALLBACK_ENABLED = false`). Fetching the ciphertext from the server would expose the buyer's IP and download timing to the server/network — metadata the mixnet exists to hide (the file _content_ stays encrypted either way). So delivery is 100% over Nym, and a slow transfer is allowed to finish in its own time under the 6 h receive ceiling instead of bailing to HTTPS. `buyerHttpsFallback`/`armBuyerHttpsFallback` early-return on the flag (a single choke point covering every call site, including the `receiver.done()` catch).

The machinery is kept for a future **last-resort, consent-based** re-enable: if it returns it must be the buyer's explicit choice (a clear notice that their IP becomes visible), never silent — and the size-aware cap (`computeNymReceiveTimeoutMs`) would decide when to offer it. A provenance badge already distinguishes the path: `received over Nym (mixnet)` vs `received over HTTPS (Nym fallback)`.

## Multi-buyer products (one link, many buyers)

A **product** lets one link be sold to many buyers. The seller creates a product (file ciphertext + price + supply, keyed by `productId`); each buyer who opens the link gets their **own order** — a _purchase_ carrying `order.productId` — with its own per-order deposit address and its own Nym delivery. Supply is either **unlimited** or a **fixed quantity** that sells out at the cap. The product's release secret + ciphertext live in the seller's browser; every purchase is delivered from that one browser using the shared product release draft.

Because all deliveries share the seller's single ~46 KiB/s Nym gateway, purchases are delivered **sequentially — one in flight at a time** (`lib/product-delivery-queue.ts`, `selectNextPurchaseToDeliver`; pure + unit-tested). Two rules keep one buyer from blocking the rest:

- **Skip absent buyers.** Each buyer heartbeats its Nym session every ~8s; the server stamps `nymSession.updatedAt`. The queue skips a purchase whose **server-computed** heartbeat age (`nymSessionAgeMs`) exceeds `BUYER_PRESENCE_STALE_MS` (~40s) — a buyer who closed their tab. Server-computed on purpose: comparing the seller's local clock to a server timestamp would skip a present buyer under clock skew. A returning buyer re-enters once it heartbeats again.
- **Demote present-but-stuck buyers.** The buyer also reports its received-byte count in the heartbeat. A present buyer whose bytes keep advancing (slow but progressing) is never demoted; one that is present yet makes **no progress** is rotated to the back so the buyers behind it get served — distinguishing "slow" from "stuck" without penalizing a legitimately slow transfer.

Supply is reserved race-safely under a per-product lock. (A known follow-up: a reservation TTL so an abandoned _unpaid_ limited purchase reclaims its unit — see the audit notes.)

## Reliability mechanisms

- **Seller re-send-until-acked.** While the seller dashboard (or manage screen) is open for a released, undelivered order whose secret this browser holds, the seller browser re-emits the wrapped key and re-streams the file every ~6s, up to a cap (~2 min), stopping the instant the buyer's ack flips the Nym session to `delivered`. The key re-send **pauses while the file is actively streaming** (the two would otherwise compete for the seller's single ~46 KiB/s gateway). Driven by both the manage screen and the dashboard files poll, so delivery completes with the seller just sitting on the dashboard.
- **Buyer self-healing receiver.** A heartbeat (~8s) re-bootstraps the Nym client when the connection drops and re-registers the address the client is **actually listening on** (`selfAddress()`, not stale React state) so the seller's recipient stays in sync. A no-rotate guard prevents the client from rotating gateways (and orphaning in-flight chunks) mid-transfer. The heartbeat also reports the buyer's received-byte count (see the delivery queue below).
- **Claim-on-demand.** The buyer can claim/re-claim at any point after payment; the signed ciphertext URL is refreshed if a stashed one expired.
- **Status-only delivery ack.** `POST /api/transfers/:orderId/delivered` carries only the buyer public key (same auth as claim) plus `via: "nym" | "https"` — never key material. It flips the Nym session to `delivered` and records the delivery path. The buyer retries it until the server confirms.
- **IndexedDB ciphertext persistence** (`lib/seller-ciphertext-store.ts`). Best-effort: the seller's encrypted bytes are persisted by orderId so file-over-Nym survives a reload/new session; any IndexedDB failure transparently degrades to in-memory. Deleted once the buyer acks.
- **`Cache-Control: no-store`** on the `/paid-private-file` document (`next.config.ts`) so the dynamic page never serves stale JS chunks after a deploy. Hashed `/_next/static` chunks stay immutable-cached.
- **Watchlist TTL.** Pending orders older than 24h drop off the scan watchlist.
- **Webhook seller-mismatch → 200 ignored** (above), so a stale binding never spams error logs.
- **Per-order write lock** + atomic JSON writes in the transfer store.

## API surface

```txt
POST  /api/transfers                          create order (requires releaseSecretHash; rejects fileKey)
GET   /api/transfers/:orderId                 public order
POST  /api/transfers/:orderId/payment-intent  bind buyer key; derive/bind deposit address; return payment
POST  /api/transfers/:orderId/nym-session     register buyer Nym address + key
POST  /api/transfers/:orderId/key-release     status / release (seller releaseSecret, monotonic)
POST  /api/transfers/:orderId/claim           claim (paid + Nym session required)
GET   /api/transfers/:orderId/file?token=...  signed ciphertext download (HTTPS fallback)
POST  /api/transfers/:orderId/delivered       status-only delivery ack (via: nym | https)
POST  /api/transfers/:orderId/dev-pay         dev-only payment confirmation
POST  /api/transfers/payments/zcash/addresses register legacy address pool (pool secret)
POST  /api/transfers/payments/zcash/watchlist signed watchlist for the scanner (pool secret)
POST  /api/webhooks/zcash                     signed payment webhook (webhook secret)
POST  /api/sellers                            create shop (handle, displayName, ufvk)
GET   /api/seller-session  POST /api/seller-session  DELETE
GET   /api/sellers/me   PATCH /api/sellers/me
POST  /api/sellers/me/ufvk   GET /api/sellers/me/files
POST  /api/zcash/ufvk-preview                 live UFVK validation + derived address
```

## Storage layout

```txt
$PAID_PRIVATE_FILE_RUNTIME_DIR/paid-transfers/
  orders/<orderId>/order.json        order state (no file key, no plaintext)
  orders/<orderId>/encrypted.bin     AES-256-GCM ciphertext (HTTPS fallback source)
  invoice-index/<hash>.json          invoice -> order mapping
  deposit-pool/...                   legacy pre-registered address pool (zcash-onchain)
  + per-order UFVK deposit bindings
```

The scanner stores the encrypted UFVK store under `PPF_SCANNER_DATA_DIR` (default `/data`). Both are file stores adequate for the current scale; production-scale durability would move to object storage + a transactional database.

## Trust boundaries — who holds what

| Party          | Holds                                                                                                                                            | Cannot                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Seller browser | raw `file_key`, `release_secret`, plaintext file, encrypted bytes for streaming                                                                  | —                                                                                                              |
| Buyer browser  | buyer P-256 private key, decrypted file (local only)                                                                                             | spend; produce the key without the envelope                                                                    |
| App server     | ciphertext, key envelope (server-relayed paths), order metadata, buyer public key, Nym addresses, view-only-derived deposit addresses, `scanRef` | decrypt the file (no file key); read the key envelope (no buyer private key); spend (no spending key, no UFVK) |
| Scanner        | seller UFVKs (encrypted at rest)                                                                                                                 | spend; see plaintext files or buyer keys                                                                       |
| Nym mixnet     | encrypted packets in transit                                                                                                                     | read content; learn the network path                                                                           |

### Threat model and its limit

Seller-held custody protects the key against an **honest-but-curious server**: in normal operation the server only stores `release_secret_hash` and an opaque client-produced ECDH envelope it cannot decrypt (it has no buyer private key) — it never holds the raw `file_key`.

It is **not** unconditionally trustless. The server is the source of the buyer public key the seller wraps to. A **malicious or compromised server (or a MITM on the seller's session)** could substitute its own P-256 key in the release challenge; the seller would then wrap `file_key` to it, letting the attacker recover the plaintext key.

Mitigation — out-of-band buyer-key verification. `fingerprintPaidLinkPublicKey` derives a short, human-comparable code from a P-256 public key. The buyer panel shows the buyer's own code; the seller release panel shows the code of the buyer key in the release challenge.

- **Verified path (strong):** manual release is gated behind a checkbox the seller checks only after comparing the displayed buyer code with the code the buyer shared out-of-band. A substituted key yields a different code and is caught.
- **Unverified path (convenience default):** auto-release on payment trusts the server-provided buyer key without the out-of-band check. It is the default for the seller-online flow.

UI copy is scoped accordingly: the server is _not given the key directly_, rather than an absolute "never receives it."

## Production hardening

- Strong `PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET` and `PAID_PRIVATE_FILE_AUTH_SECRET` (they fall back to public dev defaults).
- Durable storage for orders/ciphertext (mounted volume → object storage + transactional metadata).
- Seller key-vault recovery (a lost `release_secret` means the key can never be released).
- Buyer browser-key recovery UX.
- Payment finality policy; abuse/retention policy for stored ciphertext.
- Operational monitoring of the scanner, the mixnet path, and delivery success rates.
- Stronger seller account security (passkeys / wallet-signed login) beyond the one-time access key.
