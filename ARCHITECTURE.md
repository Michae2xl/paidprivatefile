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

CipherPay webhook
  - verifies optional webhook signature
  - maps invoice id to order id
  - marks order paid
```

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
