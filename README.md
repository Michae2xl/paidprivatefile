# Paid Private File

ZEC payment unlocks private Nym delivery. The file opens only locally.

Paid Private File is a private commerce protocol for files: local encryption, ZEC payment, and Nym delivery. A seller encrypts a file locally, sets a ZEC price and payout address, and shares a private access link. A buyer pays in ZEC, opens a Nym delivery session, receives a wrapped file key, and decrypts locally.

Nym is core, not an add-on. Zcash handles payment, the app handles encryption and key-release policy, and Nym is the required private delivery layer for the key and, in the stronger mode, the encrypted file chunks.

## Why It Exists

Most file-transfer tools separate payment, access control, and privacy. Paid Private File combines them into one flow:

- private file upload
- direct ZEC payment gating
- Nym-based key release after payment
- local decryption by the buyer
- no plaintext file storage on the server

## Product Flow

### Seller

1. Opens the app.
2. Selects a private file.
3. Sets the price in ZEC.
4. Adds the Zcash Unified Address that should receive payment.
5. Creates a private file link.
6. Sends the link to the buyer.

### Buyer

1. Opens the private file link.
2. Creates a payment intent.
3. Pays in ZEC.
4. Waits for confirmation.
5. Downloads the encrypted file.
6. Receives the wrapped file key through a Nym delivery session.
7. Decrypts and opens the file locally.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md).

High-level flow:

```txt
Seller browser    -> encrypted file + order -> API/storage
Buyer local client -> Nym session + payment intent -> CipherPay/Zcash
CipherPay         -> webhook -> API marks paid
Nym               -> wrapped key delivery -> local decrypt
```

Nym transport flow:

```txt
Buyer local client -> Nym address/session -> API
API after payment  -> wrapped key over Nym
Buyer local client -> ciphertext retrieval -> local decrypt
```

The core transport is `nym-claim-v1`: payment unlocks private Nym delivery of the wrapped file key. `nym-transfer-v1` extends this to encrypted file chunks after size limits and reliability are tested.

## Local Development

```bash
npm install
npm run dev -- --port 3000
```

Open:

```txt
http://localhost:3000
```

## Environment

Copy `.env.example` to `.env.local` for local configuration.

Important variables:

```txt
CIPHERPAY_API_URL
CIPHERPAY_API_KEY
CIPHERPAY_WEBHOOK_SECRET
PAID_PRIVATE_FILE_RUNTIME_DIR
PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET
PAID_PRIVATE_FILE_ENABLE_DEV_PAY
PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS
NYM_CLIENT_ENDPOINT
NYM_SERVICE_PROVIDER_ADDRESS
NYM_TRANSPORT_MODE
```

If CipherPay credentials are not configured, the app uses the local development payment provider. Use the dev payment endpoint only in local development or explicitly enabled production test environments.

## Validation

```bash
npm run check
npm test
npm run build
```

## Current Status

Prototype. The system supports local encrypted-file order creation, Nym session registration, payment intent creation, dev payment confirmation, CipherPay webhook parsing, Nym delivery outbox creation, signed development download URLs, and browser-side decryption.

Before production, harden:

- storage backend
- webhook signature policy
- payment confirmation depth / finality semantics
- file retention and deletion
- abuse prevention
- seller payout address validation
- buyer key recovery UX
- operational monitoring
- Nym client/service-provider deployment
- Nym message retry and delivery receipts
- encrypted chunk delivery for `nym-transfer-v1`

## License

TBD.
