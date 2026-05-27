# Paid Private File

Send a private file. The recipient pays in ZEC. Then they download and open it locally.

Paid Private File is a Zcash-native private file delivery system. A seller encrypts a file locally, sets a ZEC price and payout address, and shares a private access link. A buyer pays in ZEC, then receives a wrapped file key through the API and decrypts the file locally.

Nym is the private transport layer for the next phase. Zcash handles payment, the app handles encryption and key-release policy, and Nym hides delivery metadata when the key or encrypted file is delivered to the buyer.

## Why It Exists

Most file-transfer tools separate payment, access control, and privacy. Paid Private File combines them into one flow:

- private file upload
- direct ZEC payment gating
- API-based key release after payment
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
6. Receives the wrapped file key through the API.
7. Decrypts and opens the file locally.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md).

High-level flow:

```txt
Seller browser -> encrypted file + order -> API/storage
Buyer browser  -> payment intent -> CipherPay/Zcash
CipherPay      -> webhook -> API marks paid
Buyer browser  -> claim -> wrapped key + ciphertext -> local decrypt
```

Nym transport flow:

```txt
Buyer local client -> Nym address/session -> API
API after payment  -> wrapped key over Nym
Buyer browser      -> ciphertext download -> local decrypt
```

For the MVP, Nym should carry the key-release message first (`nym-claim-v1`). Full ciphertext transfer over Nym (`nym-transfer-v1`) is the stronger privacy mode, but should be added after size limits and reliability are tested.

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
```

If CipherPay credentials are not configured, the app uses the local development payment provider. Use the dev payment endpoint only in local development or explicitly enabled production test environments.

## Validation

```bash
npm run check
npm test
npm run build
```

## Current Status

Prototype. The system supports local encrypted-file order creation, payment intent creation, dev payment confirmation, CipherPay webhook parsing, gated key release, signed encrypted-file download URLs, and browser-side decryption.

Nym is documented as the private delivery layer but is not wired into the current prototype yet. Current claim and file delivery use the HTTP API.

Before production, harden:

- storage backend
- webhook signature policy
- payment confirmation depth / finality semantics
- file retention and deletion
- abuse prevention
- seller payout address validation
- buyer key recovery UX
- operational monitoring

## License

TBD.
