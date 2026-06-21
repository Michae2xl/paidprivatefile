# Paid Private File Architecture

## Goal

Paid Private File is a paid private file-delivery system:

> ZEC payment unlocks private Nym delivery. The file opens only locally.

The core invariant is simple: payment unlocks a private Nym delivery session, and the AES file key is held only by the seller's browser. The server stores ciphertext and payment metadata, but it never holds, wraps, or sees the file key. After payment, the seller's browser wraps the key for the buyer and releases only that buyer-bound envelope, which the API then delivers inside a Nym session.

This is **pure seller-held custody**: there is no server-held key path. Orders are created with a `release_secret_hash` only (the SHA-256 of a random release secret). The seller browser keeps the raw `file_key` and `release_secret` in a local vault and is the only party that can produce the wrapped key envelope. The tradeoff is that the seller must be online (the tab open) to release the key after payment; the panel auto-releases on payment confirmation and also offers a manual "Release key" button.

## Components

```txt
Browser client
  - creates or logs into a no-email seller workspace
  - encrypts seller file before upload
  - generates buyer key pair
  - auto-detects buyer Nym/local receiver when available
  - decrypts file locally after Nym delivery

Transfer API
  - creates seller workspaces
  - authenticates seller sessions with handle + access key
  - creates file orders
  - stores ciphertext
  - exposes public order metadata
  - creates payment intents
  - records buyer public key on the payment intent
  - discloses the buyer public key to the seller only after payment
  - stores the seller-released buyer-wrapped key envelope (never the file key)
  - requires Nym delivery session before claim
  - queues the seller-released wrapped key envelope after payment

Transfer store
  - persists order JSON
  - persists encrypted file bytes
  - indexes invoice ids
  - signs short-lived download tokens

Payment adapter
  - creates CipherPay invoices when configured
  - falls back to local dev invoices otherwise
  - parses payment webhook payloads

Nym transport adapter
  - core component
  - receives or detects buyer Nym address/session
  - sends wrapped key over standalone nym-client WebSocket after payment
  - keeps a local outbox fallback for tests and development
  - optionally transfers encrypted file chunks over Nym

CipherPay webhook
  - verifies optional webhook signature
  - maps invoice id to order id
  - marks order paid
```

## Where Nym Enters

Nym is not a payment rail and not a storage layer. It is the private delivery transport after the ZEC payment is confirmed.

The architecture has three layers:

```txt
Zcash / CipherPay
  payment confirmation

Paid Private File API
  order state, ciphertext metadata, key-release policy

Nym
  private delivery of the wrapped key or encrypted file chunks
```

### Core MVP: Nym Claim Mode

In the core MVP, the encrypted file can still be stored in object storage, but the sensitive claim payload is delivered through Nym:

```txt
buyer local receiver
  -> browser reads receiver address automatically when helper is available
  -> API stores claim session
  -> payment confirmed
  -> API wraps file key to buyer public key
  -> API sends wrapped key envelope over Nym
  -> buyer decrypts file locally
```

This mode hides the key-release delivery metadata while keeping the MVP practical. Signed HTTP file URLs are treated as development fallback, not the product privacy model.

Transport label:

```txt
nym-claim-v1
```

### Stronger Mode: Nym Transfer Mode

In a later phase, Nym can carry the encrypted file itself:

```txt
payment confirmed
  -> encrypted file split into chunks
  -> chunks sent over Nym service-provider session
  -> buyer reassembles ciphertext
  -> buyer unwraps key
  -> local decrypt
```

Transport label:

```txt
nym-transfer-v1
```

This gives stronger network metadata privacy but needs file-size limits, retries, chunk integrity checks, and reliability testing.

## Order State Machine

```txt
created
  -> payment_pending
  -> paid
  -> claimed
```

State definitions:

- `created`: seller uploaded ciphertext and metadata.
- `payment_pending`: buyer created a payment intent.
- `paid`: payment provider confirmed payment.
- `claimed`: buyer successfully received a wrapped file key.

The API must reject key claims before `paid`, and also before the seller has released the key (claim returns `payment_required` while `release.status` is `seller_pending`).

## Seller-Side Flow

```txt
File
  -> AES-256-GCM encryption in browser
  -> ciphertext SHA-256
  -> local timestamp commitment
  -> POST /api/transfers
  -> order id + private access link
```

The seller submits:

- encrypted file bytes
- original filename
- MIME type
- original size
- ciphertext hash
- encryption IV
- file key for server-side wrapping in older prototype deployments
- release_secret_hash in seller-held deployments
- ZEC amount in zatoshis
- seller payout Unified Address
- optional seller id and public handle from the no-email seller session
- optional seller note
- optional timestamp receipt

## Buyer-Side Flow

```txt
Private link
  -> GET /api/transfers/:orderId
  -> generate buyer P-256 key pair
  -> auto-detect or register buyer Nym address/session
  -> POST /api/transfers/:orderId/payment-intent
  -> pay invoice
  -> POST /api/transfers/:orderId/claim
  -> receive wrapped file key over Nym
  -> retrieve ciphertext
  -> decrypt locally
```

The browser stores the buyer private key locally for that order so the API can wrap the file key to the buyer public key.

## Key Handling

File encryption:

```txt
random file key -> AES-256-GCM -> encrypted file
```

Key release:

```txt
buyer public key
  -> seller or server derives wrapping key through ECDH
  -> seller or server wraps file key
  -> buyer unwraps locally
```

Current scheme labels:

```txt
aes-256-gcm-v1
p256-ecdh-aes-gcm-v1
```

## Payment Model

The seller payout address is part of the transfer order. A payment intent uses that address as the intended ZEC recipient.

The app should present this as a ZEC payment flow. CipherPay is an internal payment rail for invoice creation and webhook confirmation, not user-facing product language.

### Real on-chain ZEC mode (`zcash-onchain`)

`PAID_PRIVATE_FILE_ZCASH_ONCHAIN=1` swaps the payment rail for real on-chain deposits. The flag-off path is byte-for-byte the existing dev/CipherPay behavior.

Trust model and topology (same shape as the CipherPay webhook — an HMAC-authenticated local reporter):

```txt
local side (next to Zallet wallet, keys never leave)
  - pool filler: generates unique Unified Addresses, registers them in prod
  - payment watcher: detects an incoming deposit, signs a "paid" report

prod (no wallet, no keys)
  - holds an available pool of deposit addresses
  - assigns one per order on payment-intent (payment.receivingAddress)
  - on a signed, verified report -> marks the order paid
```

Two signed crossings, both HMAC-SHA256 over the raw request body in `x-zcash-signature` (optional `sha256=` prefix), timing-safe:

- `POST /api/transfers/payments/zcash/addresses` — body `{ addresses: string[] }`, signed with `PAID_PRIVATE_FILE_ZCASH_POOL_SECRET`. Addresses are validated as Unified Addresses (`u1.../utest.../uregtest...`), deduped, and stored as available. Secret unset -> rejected.
- `POST /api/webhooks/zcash` — body `{ receivingAddress, amountZats, txid, confirmations }`, signed with `PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET`. Secret unset -> rejected.

Each payment intent pops one free address, binds it to the order as `payment.receivingAddress`, and returns it to the buyer with provider label `zcash-onchain`. Empty pool -> a clear error ("No deposit address available; try again shortly").

Webhook settlement rules:

- map `receivingAddress` -> order, confirm it matches `payment.receivingAddress` (else reject).
- `amountZats >= order amountZats` AND `confirmations >= PAID_PRIVATE_FILE_ZCASH_MIN_CONFIRMATIONS` (default 10) -> mark paid, record `payment.onchain = { txid, amountZats, confirmations, paidAt }`, run the same nym-session readiness transition as the other paid paths.
- under-payment or under-confirmation -> `200 { ok: true, ignored: true, reason }` without settling, so the watcher retries as confirmations grow (never an error).
- replaying the same `txid` after paid is idempotent; a paid/claimed order never regresses.

Watcher detail (Zallet `0.1.0-alpha.3`): `z_listunspent` does **not** return a per-note receiving address, so the watcher cannot read the address off a note. Instead it pulls the live deposit addresses from a third signed endpoint — `POST /api/transfers/payments/zcash/watchlist` (signed with `PAID_PRIVATE_FILE_ZCASH_POOL_SECRET`; returns the addresses assigned to pending orders) — and queries `z_listunspent(0, 9999999, true, [address])` once per watched address; any unspent notes are aggregated (sum value, min confirmations) and reported to the webhook above. Deposit addresses are diversified Unified Addresses of a single Zallet account (`z_getaddressforaccount`), so no per-order account is required. The local bridge scripts are `scripts/zallet-pool-filler.mjs` and `scripts/zallet-payment-watcher.mjs` (see `scripts/README-zallet.md`).

## Seller Workspaces

Seller accounts are intentionally no-email in the prototype:

```txt
handle + one-time access key -> signed seller session cookie
```

The public seller route is:

```txt
/s/:handle
/s/:handle/files/:orderId
```

The access key is shown once and only its SHA-256 hash is stored. This keeps onboarding simple and close to a wallet-style flow, but production should add passkeys, wallet-signed login, key rotation, and recovery.

Production source of truth:

```txt
CipherPay invoice/webhook -> paid order -> key claim allowed
```

Development source of truth:

```txt
POST /api/transfers/:orderId/dev-pay -> paid order
```

The dev payment endpoint is blocked in production unless explicitly enabled.

## API Surface

```txt
POST /api/transfers
GET  /api/transfers/:orderId
POST /api/transfers/:orderId/payment-intent
POST /api/transfers/:orderId/nym-session
POST /api/transfers/:orderId/key-release
POST /api/transfers/:orderId/claim
GET  /api/transfers/:orderId/file?token=...
POST /api/transfers/:orderId/dev-pay
POST /api/transfers/payments/zcash/addresses
POST /api/webhooks/cipherpay
POST /api/webhooks/zcash
POST /api/sellers
GET  /api/seller-session
POST /api/seller-session
GET  /api/sellers/me
PATCH /api/sellers/me
```

`POST /api/transfers` requires `releaseSecretHash` (64-char hex) and rejects any `fileKey` field.

Nym session request:

```json
{
  "buyerNymAddress": "nym...",
  "transport": "nym-claim-v1",
  "buyerPublicKeyJwk": {}
}
```

### Seller key release: `POST /api/transfers/:orderId/key-release`

Two actions on one endpoint, both authenticated with the seller `releaseSecret` (the base64 32-byte secret whose SHA-256 is the stored `release_secret_hash`; compared timing-safely).

Status (no `action`, or `action: "status"`):

```json
{ "releaseSecret": "<base64-32>" }
```

returns the release challenge:

```json
{
  "order": { "...": "public order" },
  "release": {
    "status": "waiting_for_buyer | waiting_for_payment | ready_to_release | released",
    "buyerPublicKeyHash": "<hex|null>",
    "buyerPublicKeyJwk": { "...": "P-256 JWK, only when paid" },
    "buyerNymAddress": "<nym address|null, only when paid + Nym session registered>",
    "releasedAt": "<iso|null>"
  }
}
```

`buyerPublicKeyJwk` is disclosed only once the order is `paid`. `buyerNymAddress` is disclosed only when the order is `paid` **and** the buyer has registered a Nym session; it tells the seller browser where to send the wrapped key envelope in browser-direct Nym mode (see below). Release (`action: "release"`):

```json
{
  "action": "release",
  "releaseSecret": "<base64-32>",
  "keyEnvelope": { "scheme": "p256-ecdh-aes-gcm-v1", "...": "..." }
}
```

stores the buyer-wrapped envelope and returns the challenge with `status: "released"`. Release requires `payment.status === "paid"`; otherwise it returns `payment_required`.

## Storage Layout

Default local runtime root:

```txt
$PAID_PRIVATE_FILE_RUNTIME_DIR
```

Order storage:

```txt
paid-transfers/
  orders/
    <orderId>/
      order.json
      encrypted-file.bin
  invoice-index/
    <invoiceId>.json
  deposit-pool/
    pool.json
```

`deposit-pool/pool.json` (zcash-onchain mode only) holds the available/assigned Unified Address pool, written atomically under an in-process lock like the order store. It maps each deposit address to the order it was assigned to, which is how the webhook resolves an incoming deposit back to an order.

This local file store is enough for prototype and testnet flows. Production should move this to durable object storage plus transactional metadata storage.

## Privacy Boundaries

Server may see:

- ciphertext
- encrypted file digest
- original filename
- original file size
- seller payout address
- order id
- payment status
- timestamp commitment

Server never sees:

- plaintext file bytes
- the AES file key (`file_key`)
- the seller release secret (`release_secret`)
- buyer decrypted output
- buyer private key

Key custody is **pure seller-held**. There is no `wrapFileKey` path on the server and no `encryption.fileKey` field in `order.json`. Order creation requires `release_secret_hash` and explicitly rejects any uploaded `fileKey`. The flow is:

1. Seller browser encrypts the file, derives a random `release_secret`, and uploads only `release_secret_hash` plus the ciphertext and IV. The raw `file_key` and `release_secret` are saved in a local seller vault (localStorage key `zectime_paid_link_seller_release_<orderId>`).
2. Buyer pays. The payment intent records the buyer P-256 public key (`buyerPublicKeyJwk`) on the order.
3. Seller browser calls the key-release endpoint, which discloses the buyer public key only once payment is confirmed, wraps `file_key` for that buyer with ECDH-ES, and posts the envelope back.
4. On claim, the API returns the seller-released envelope (server-relayed / dev modes) or, in browser-direct Nym mode, only the signed ciphertext URL while the key envelope arrives over the mixnet (see below). If the seller has not released yet, claim fails with `payment_required` ("Seller key release is pending for this paid private file").

Key release is **monotonic**: once an envelope is released it cannot be replaced (`releaseTransferKey` rejects a second release or release after claim), so a leaked `release_secret` cannot swap the file for a buyer after the sale.

Nym is used to deliver the seller-wrapped key envelope privately after payment.

### Browser-direct Nym key delivery (`PAID_PRIVATE_FILE_BROWSER_NYM_DELIVERY=1`)

The fully private transport runs **browser-to-browser over the mixnet with no server `nym-client`**. Gated behind `PAID_PRIVATE_FILE_BROWSER_NYM_DELIVERY=1` (server) and `NEXT_PUBLIC_PPF_BROWSER_NYM=1` (client); when off, behavior is unchanged.

- The buyer browser already runs an in-page Nym receiver (`@nymproject/sdk-full-fat`) and registers its `buyerNymAddress` via `POST /api/transfers/:orderId/nym-session`.
- The seller browser releases the key as usual, reads `release.buyerNymAddress` from the release challenge, and sends `{ schema: "paidprivatefile.nym.claim.v1", orderId, keyEnvelope }` to that address with the SDK `client.send({ payload: { message, mimeType: "application/json" }, recipient })`. The server-side `key-release` POST is still made (record + monotonic guard), but the key transits the mixnet directly — the server never relays it.
- `POST /api/transfers/:orderId/claim` returns `deliveryMode: "browser-nym"` with the signed `download` URL **and no `keyEnvelope`**. The server does **not** call `queueNymDelivery`. The claim still requires `paid` + a buyer-key binding + a registered Nym session.
- The buyer stashes the `download` URL, shows an "awaiting key over Nym" state, and on the inbound Nym message reconstructs the manifest from its loaded order, fetches the ciphertext, unwraps the key with its private key, and decrypts locally.

This is the only path where the key envelope actually transits the mixnet without a server-side Nym client. The legacy `nym` mode (server WebSocket `nym-client`) and `http-dev-fallback` mode remain for environments where the flags are off.

### Threat model and its limit (important)

Seller-held custody removes the server's access to the key **against an honest-but-curious server**: in normal operation the server only ever stores `release_secret_hash` and an opaque, client-produced ECDH envelope it cannot decrypt (it has no buyer private key). It does NOT hold the raw `file_key` at rest, in memory, or in logs.

It is **not** unconditionally trustless. The server is the source of the buyer public key that the seller wraps to. A **malicious or compromised server (or a MITM on the seller's session)** can substitute its own P-256 public key in the release challenge; the seller browser would then wrap `file_key` to it, letting the server decrypt and recover the plaintext key (then re-wrap to the real buyer).

**Buyer-key authentication is now available** via an out-of-band verification code. `fingerprintPaidLinkPublicKey` derives a short, human-comparable fingerprint (e.g. `A1B2-C3D4-E5F6-7890-1234`) deterministically from a P-256 public key. The buyer panel shows the buyer's OWN public-key fingerprint as a "Verification code"; the seller release panel shows the fingerprint of the buyer key returned in the release challenge ("Buyer code"). Compared out-of-band, a mismatch detects a substituted key because a different key yields a different code.

- **Verified path (strong):** the seller uses **manual release** — the release button is gated behind a confirmation checkbox ("I verified this code with the buyer") that the seller can only honestly check after comparing the displayed buyer code with the code the buyer shared out-of-band. This defeats server key substitution.
- **Unverified path (convenience default):** **auto-release** on payment confirmation still trusts the server-provided buyer key without out-of-band verification. It is the default for the seller-online flow and is not blocked; the panel notes that strong verification requires the manual path.

UI copy is scoped accordingly: the server is _not given the key directly_, rather than an absolute "never receives it" claim.

## Production Hardening

Required before real production:

- durable encrypted object storage
- authenticated seller sessions
- seller payout address validation
- strict webhook verification
- payment confirmation/finality policy
- object retention and deletion policy
- max file size enforcement at edge/proxy
- malware/abuse response policy for ciphertext storage
- audit logs without leaking file metadata
- key escrow redesign or short-lived key handling
- buyer recovery UX for lost local browser key
- Nym client/service-provider deployment
- Nym message retry and delivery receipts
- Nym transfer size limits and chunk integrity

## Extraction Boundary

This repository owns only:

- paid file UI
- file encryption/decryption client code
- transfer APIs
- transfer storage
- CipherPay adapter
- webhook handling
- architecture and product docs

It does not own the broader ZK Global Credit ecosystem, voting, identity, credit passport, or timestamp product surfaces.
