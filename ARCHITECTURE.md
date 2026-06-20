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
POST /api/webhooks/cipherpay
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
    "releasedAt": "<iso|null>"
  }
}
```

`buyerPublicKeyJwk` is disclosed only once the order is `paid`. Release (`action: "release"`):

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
```

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
4. On claim, the API returns the seller-released envelope. If the seller has not released yet, claim fails with `payment_required` ("Seller key release is pending for this paid private file").

Key release is **monotonic**: once an envelope is released it cannot be replaced (`releaseTransferKey` rejects a second release or release after claim), so a leaked `release_secret` cannot swap the file for a buyer after the sale.

Nym is used to deliver the seller-wrapped key envelope privately after payment.

### Threat model and its limit (important)

Seller-held custody removes the server's access to the key **against an honest-but-curious server**: in normal operation the server only ever stores `release_secret_hash` and an opaque, client-produced ECDH envelope it cannot decrypt (it has no buyer private key). It does NOT hold the raw `file_key` at rest, in memory, or in logs.

It is **not** unconditionally trustless. The server is the source of the buyer public key that the seller wraps to, and the seller does not authenticate that key out-of-band. A **malicious or compromised server (or a MITM on the seller's session)** can substitute its own P-256 public key in the release challenge; the seller browser would wrap `file_key` to it, letting the server decrypt and recover the plaintext key (then re-wrap to the real buyer). Fully defending against this requires authenticating the buyer key to the seller (e.g. a buyer-confirmed key fingerprint or a buyer signature) — a deliberate future hardening. UI copy is scoped accordingly: the server is _not given the key directly_, rather than an absolute "never receives it" claim.

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
