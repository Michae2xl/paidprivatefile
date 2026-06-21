# Marketplace Phase 1 — App ↔ Scanner Contract

Non-custodial multi-seller: sellers register a **UA + UFVK** (dedicated account). The platform
derives a unique diversified address per order from the seller's UFVK and detects the direct
payment view-only via a Rust scanner that reads compact blocks from a hosted lightwalletd
(`https://zec.rocks:443`). Reuses the existing order lifecycle, signed webhook, and Nym key release.

Proven by the spike at `/Users/maiconguimaraes/ppf-ufvk-spike` (crate stack pinned there).

## Components

- **Scanner service (Rust, new)** — productionized from the spike. Long-running HTTP service +
  background scan loop. Holds nothing persistent itself for MVP; the app supplies UFVKs via the
  watchlist. Runs anywhere with outbound network to `zec.rocks` (Phase 1: same host as the app or
  a small box; Phase 2: the Pi next to Zebra/Zaino).
- **Next app (extend)** — seller registration stores the UFVK encrypted; payment-intent derives a
  per-order address by calling the scanner; a watchlist endpoint feeds the scanner; the existing
  webhook settles the order.

## Scanner HTTP API (called by the app; HMAC auth header `x-ppf-scanner-sig` = HMAC-SHA256(body, PPF_SCANNER_SECRET))

### POST /validate

Request: `{ "ufvk": "uview1...", "ua"?: "u1..." }`
Response: `{ "valid": true, "network": "main", "fingerprint": "<sha256 hex of ufvk>",
  "defaultAddress": "u1...", "receivers": ["orchard","sapling","transparent"],
  "uaMatches"?: true }`

- Decodes the UFVK on MAIN_NETWORK (rejects testnet/invalid). If `ua` is given, verifies it is
  reproducible from the UFVK (byte-compare receivers over a bounded diversifier scan) → `uaMatches`.

### POST /derive

Request: `{ "ufvk": "uview1...", "diversifierIndex": 1234 }`
Response: `{ "address": "u1...", "actualIndex": 1234 }`

- `find_address(diversifierIndex)` → next valid diversified UA at/after the index. Return the
  ACTUAL index used (low indices can be invalid). Address encoded for mainnet.

## App HTTP API

### POST /api/webhooks/zcash (scanner → app; EXISTING, unchanged contract)

`{ "receivingAddress": "u1...", "amountZats": 10000, "txid": "<64hex>", "confirmations": 3, "sellerId"?: "..." }`
HMAC `x-zcash-signature` = HMAC-SHA256(body, PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET).
App maps address→order (binding store), checks amount ≥ price, confs ≥ min, idempotent on txid,
and (new) cross-checks `sellerId` against `order.seller.sellerId` when present.

### POST /api/transfers/payments/zcash/scan-watchlist (scanner ← app pull; NEW)

HMAC `x-zcash-signature` = HMAC-SHA256(body, PAID*PRIVATE_FILE_ZCASH_POOL_SECRET). Body `{}`.
Response: `{ "entries": [ {
"orderId": "pl*...", "sellerId": "...", "ufvk": "uview1...", "address": "u1...",
"diversifierIndex": 1234, "startHeight": 3385000, "amountZats": 10000 } ] }`

- One entry per OPEN order awaiting payment (status payment_pending). The scanner groups by
  `ufvk`, scans from `min(startHeight)` per UFVK, trial-decrypts, and for each detected note maps
  it back to the watched `address`/`diversifierIndex` → `orderId`, then POSTs the webhook.

## App data-model changes

- `lib/server/seller-store.ts`: SellerProfile v2 adds `ufvkEncrypted` (AES-256-GCM via NEW env
  `PAID_PRIVATE_FILE_SELLER_UFVK_KEY`), `ufvkFingerprint` (sha256, safe to expose), `network`.
  NEVER return the UFVK in `publicSeller()` or logs (mirror `accessKeyHash` stripping). Registration
  calls scanner `/validate`; rejects testnet / non-matching UA.
- `lib/server/deposit-pool.ts`: repurpose to a per-order BINDING store:
  `orderId → { address, sellerId, diversifierIndex, startHeight }` + a per-seller diversifier
  high-water mark (monotonic, crash-safe, collision-free across concurrent orders).
- `lib/server/transfer-store.ts`: `deriveSellerDepositAddress(order)` → pick next diversifier index
  for the seller, call scanner `/derive`, persist the binding, set `payment.receivingAddress`.
  `createPaymentIntentForOrder` uses this instead of `assignDepositAddress`. `startHeight` = current
  chain tip at order creation (scanner exposes tip, or app stores creation time → tip lookup).
- `findOrderIdForDeposit(address)` reads the binding store (unchanged callers).

## Env (new)

- `PPF_SCANNER_URL` (app → scanner base URL), `PPF_SCANNER_SECRET` (HMAC app↔scanner).
- `PAID_PRIVATE_FILE_SELLER_UFVK_KEY` (32-byte hex; encrypt UFVKs at rest).
- Scanner: `PPF_APP_URL`, `PPF_SCANNER_SECRET`, `PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET`,
  `PAID_PRIVATE_FILE_ZCASH_POOL_SECRET`, `PPF_LIGHTWALLETD_URL` (default https://zec.rocks:443),
  `PPF_SCAN_INTERVAL_MS`, `PPF_MIN_CONFIRMATIONS`.

## Reused unchanged

Order lifecycle, `markTransferPaidOnchain` (idempotent), claim, seller-held key release over Nym,
`withOrderLock`, atomic-write persistence, HMAC pattern, checkout/Nym UI plumbing.

## Out of scope for Phase 1 (later)

Self-hosted Zaino on the Pi (Phase 2), UFVK-only-on-scanner custody + scan-by-account (Phase 3),
diversifier→index reverse mapping optimization (MVP keeps an explicit address→order binding).

---

# Phase 3 — UFVK custody hardening (key only on the scanner host)

Goal: the app NEVER stores a UFVK. The scanner is the sole holder; the app keeps
only an opaque `scanRef` + fingerprint + derived address. An app DB compromise
leaks zero viewing keys.

## Scanner (gains persistent, encrypted state)
- Encrypted UFVK store on the scanner host, under `PPF_SCANNER_DATA_DIR` (default
  `/data`, a Railway volume), AES-256-GCM with `PPF_SCANNER_UFVK_KEY` (32-byte
  hex). Maps `scanRef -> { ufvkEncrypted, fingerprint, network, defaultAddress }`.
  `scanRef` = `scan_<hex>`. Atomic writes; in-process lock.
- `POST /sellers/register {ufvk, ua?}` (HMAC x-ppf-scanner-sig): validate (same
  rules as /validate — mainnet, uaMatches), store encrypted, return
  `{ scanRef, fingerprint, network, defaultAddress, receivers, uaMatches? }`.
- `POST /derive { scanRef, diversifierIndex }` (HMAC): look up the UFVK by scanRef
  (404 if unknown), `find_address` -> `{ address, actualIndex }`. (No UFVK in the
  request anymore.)
- `POST /validate { ufvk, ua? }`: UNCHANGED, stateless, stores nothing (used by
  the live create-shop preview).
- Scan loop: watchlist entries now carry `scanRef` (NOT `ufvk`); the scanner
  resolves scanRef -> stored UFVK and scans. Entry:
  `{ orderId, sellerId, scanRef, address, diversifierIndex, startHeight, amountZats }`.

## App (drops all UFVK storage)
- `seller-store`: SellerProfile gains `sellerScanRef`; REMOVE `ufvkEncrypted` and
  the `PAID_PRIVATE_FILE_SELLER_UFVK_KEY` usage. Keep `ufvkFingerprint`,
  `network`, `defaultPayoutAddress`. `getSellerUfvk()` removed.
- registration (createSellerProfile w/ ufvk + registerSellerUfvk): call scanner
  `registerUfvk` -> store `sellerScanRef` + fingerprint + derive payout from the
  returned defaultAddress. The app never persists the UFVK.
- `scanner-client`: add `registerUfvk({ufvk, ua})`; change `deriveAddress` to
  `({ scanRef, diversifierIndex })`.
- `deriveSellerDepositAddress`: use the seller's `sellerScanRef`.
- `scan-watchlist`: return `scanRef` (not the UFVK).
- The `/api/zcash/ufvk-preview` route keeps calling scanner `/validate` (stateless).

## Infra
- Add a Railway volume `/data` to `ppf-scanner-prod` (and `ppf-scanner` staging);
  set `PPF_SCANNER_DATA_DIR=/data` + `PPF_SCANNER_UFVK_KEY` on both scanners.
- `PAID_PRIVATE_FILE_SELLER_UFVK_KEY` can be removed from the apps (unused).

## Migration
Phase-1 sellers have `ufvkEncrypted` app-side (test shops on staging/prod): they
re-register to get a `sellerScanRef`. No production seller data to migrate yet.
