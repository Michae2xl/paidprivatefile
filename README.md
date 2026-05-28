# Paid Private File

Send a private file. The buyer pays in ZEC. Then the file opens locally.

Paid Private File is a private commerce protocol for files: local encryption, ZEC payment, private key delivery, and local decryption. A seller encrypts a file locally, sets a ZEC price and payout address, and shares a private access link. A buyer opens the link, pays in ZEC, receives a wrapped file key through Nym, and decrypts on their own machine.

Zcash is the payment rail. Nym is the private delivery rail. The server can store ciphertext and order state, but the product direction is seller-held keys and buyer-local opening.

## Why It Exists

Most file-transfer tools separate payment, access control, and privacy. Paid Private File combines them into one flow:

- private file upload
- direct ZEC payment gating
- automatic private receiver setup in the buyer flow
- Nym-based wrapped-key release after payment
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
2. The order loads automatically.
3. The app detects the local private receiver automatically.
4. Pays in ZEC.
5. Downloads and opens locally after payment confirmation.

The buyer should not need to understand or paste a Nym address in the normal path. Manual receiver entry is only a fallback when the local receiver helper is not running.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md).

High-level flow:

```txt
Seller browser
  -> encrypt file locally
  -> create paid order
  -> share private link

Buyer browser
  -> auto-detect local private receiver
  -> pay ZEC invoice
  -> download ciphertext
  -> open locally

CipherPay/Zcash
  -> confirm payment
  -> seller receives ZEC

Nym
  -> deliver wrapped key privately
```

Nym transport flow:

```txt
buyer local receiver -> /address -> buyer page
buyer page           -> payment intent -> CipherPay/Zcash
payment confirmed   -> wrapped key envelope -> Nym
buyer local app      -> unwrap key -> decrypt local file
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
NYM_CLIENT_SEND_PATH
NYM_CLIENT_API_KEY
NYM_DELIVERY_REQUIRED
NYM_TRANSPORT_MODE
NEXT_PUBLIC_NYM_LOCAL_BRIDGE_URL
NYM_BRIDGE_HOST
NYM_BRIDGE_PORT
NYM_BRIDGE_WS_URL
NYM_BRIDGE_ADDRESS_AUTH
NYM_BRIDGE_ALLOWED_ORIGINS
```

If CipherPay credentials are not configured, the app uses the local development payment provider. Use the dev payment endpoint only in local development or explicitly enabled production test environments.

## Validation

```bash
npm run check
npm test
npm run build
```

## Current Status

Prototype. The integrated `zkglobalcredit.tech` implementation now uses a lower-friction buyer flow: open link, auto-detect private receiver, pay in ZEC, then open locally. This standalone repo tracks the same product direction and should stay aligned with the integrated site implementation.

Before production, harden:

- real CipherPay account configuration and webhook signatures
- native Nym client / local receiver packaging
- seller-held key release in every deployment path
- payment confirmation depth / finality semantics
- file retention and deletion
- abuse prevention
- seller payout address validation
- buyer key recovery UX
- operational monitoring
- Nym message retry and delivery receipts
- encrypted chunk delivery for `nym-transfer-v1`

## License

TBD.
