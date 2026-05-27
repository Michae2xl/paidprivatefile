# Paid Private File Architecture

## Goal

Paid Private File is a paid private file-delivery system:

> Send a private file. The recipient pays in ZEC. Then they download and open it locally.

The core invariant is simple: the server may store ciphertext and payment metadata, but it must not serve a decryption key until the payment is confirmed.

## Components

```txt
Browser client
  - encrypts seller file before upload
  - generates buyer key pair
  - decrypts file locally after claim

Transfer API
  - creates file orders
  - stores ciphertext
  - exposes public order metadata
  - creates payment intents
  - releases wrapped file keys after payment

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
  - phase B component
  - receives buyer Nym address/session
  - sends wrapped key over Nym after payment
  - optionally transfers encrypted file chunks over Nym

CipherPay webhook
  - verifies optional webhook signature
  - maps invoice id to order id
  - marks order paid
```

## Where Nym Enters

Nym is not a payment rail and not a storage layer. It enters as the private delivery transport after the ZEC payment is confirmed.

The architecture has three layers:

```txt
Zcash / CipherPay
  payment confirmation

Paid Private File API
  order state, ciphertext metadata, key-release policy

Nym
  private delivery of the wrapped key or encrypted file chunks
```

### MVP: Nym Claim Mode

In the first Nym integration, the encrypted file can still be stored and downloaded through normal object storage or the existing signed file URL. Nym carries the sensitive claim payload:

```txt
buyer Nym address
  -> API stores claim session
  -> payment confirmed
  -> API wraps file key to buyer public key
  -> API sends wrapped key envelope over Nym
  -> buyer decrypts file locally
```

This mode hides the key-release delivery metadata while keeping the MVP practical.

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

The API must reject key claims before `paid`.

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
- file key for server-side wrapping after payment
- ZEC amount in zatoshis
- seller payout Unified Address
- optional seller note
- optional timestamp receipt

## Buyer-Side Flow

```txt
Private link
  -> GET /api/transfers/:orderId
  -> generate buyer P-256 key pair
  -> POST /api/transfers/:orderId/payment-intent
  -> pay invoice
  -> POST /api/transfers/:orderId/claim
  -> receive wrapped file key + signed file URL
  -> download ciphertext
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
  -> server derives wrapping key through ECDH
  -> server wraps file key
  -> buyer unwraps locally
```

Current scheme labels:

```txt
aes-256-gcm-v1
p256-ecdh-aes-gcm-v1
```

## Payment Model

The seller payout address is part of the transfer order. A payment intent uses that address as the intended ZEC recipient.

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
POST /api/transfers/:orderId/claim
GET  /api/transfers/:orderId/file?token=...
POST /api/transfers/:orderId/dev-pay
POST /api/webhooks/cipherpay
```

Planned Nym API:

```txt
POST /api/transfers/:orderId/nym-session
```

Request:

```json
{
  "buyerNymAddress": "nym...",
  "transport": "nym-claim-v1",
  "buyerPublicKeyJwk": {}
}
```

Response:

```json
{
  "orderId": "pl_...",
  "transport": "nym-claim-v1",
  "status": "waiting_for_payment"
}
```

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

Server should not see:

- plaintext file bytes
- buyer decrypted output
- buyer private key

Important caveat: the prototype stores the raw file key server-side until claim so it can wrap the key after payment. A hardened design should move toward seller-side key escrow, threshold encryption, or buyer pre-key negotiation that avoids long-lived server access to unwrapped file keys.

Nym improves transport privacy, but it does not remove the need to harden key custody. The clean long-term design is buyer pre-key negotiation plus seller-side wrapping before upload, with Nym used to deliver the encrypted key material privately.

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
