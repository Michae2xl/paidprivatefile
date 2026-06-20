# Paid Private File

Send a private file. The buyer pays in ZEC. Then the file opens locally.

Paid Private File is a private commerce protocol for files: local encryption, ZEC payment, private key delivery, and local decryption. A seller encrypts a file locally, sets a ZEC price and payout address, and shares a private access link. A buyer opens the link, pays in ZEC, receives a wrapped file key through Nym, and decrypts on their own machine.

Zcash is the payment rail. Nym is the private delivery rail. The server stores ciphertext and order state but never holds the AES file key: custody is pure seller-held. The seller browser keeps the key in a local vault and, after payment, wraps it for the buyer and releases only that envelope. The buyer opens the file locally.

## Why It Exists

Most file-transfer tools separate payment, access control, and privacy. Paid Private File combines them into one flow:

- private file upload
- direct ZEC payment gating
- automatic private receiver setup in the buyer flow
- pure seller-held key custody (the server never holds or wraps the file key)
- seller-side key wrapping and release after payment, delivered over Nym
- local decryption by the buyer
- no plaintext file storage and no file key on the server

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
CIPHERPAY_CREATE_INVOICE_PATH
CIPHERPAY_WEBHOOK_SECRET
PAID_PRIVATE_FILE_RUNTIME_DIR
PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET
PAID_PRIVATE_FILE_AUTH_SECRET
PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY
PAID_PRIVATE_FILE_ALLOW_LOCAL_NYM_OUTBOX
PAID_PRIVATE_FILE_ALLOW_HTTP_CLAIM_RESPONSE
PAID_PRIVATE_FILE_ENABLE_DEV_PAY
PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS
NYM_CLIENT_ENDPOINT
NYM_CLIENT_SEND_PATH
NYM_CLIENT_API_KEY
NYM_DELIVERY_REQUIRED
NYM_CLIENT_TIMEOUT_MS
NYM_SERVICE_PROVIDER_ADDRESS
NYM_TRANSPORT_MODE
NEXT_PUBLIC_NYM_LOCAL_BRIDGE_URL
NYM_BRIDGE_HOST
NYM_BRIDGE_PORT
NYM_BRIDGE_WS_URL
NYM_BRIDGE_ADDRESS_AUTH
NYM_BRIDGE_ALLOWED_ORIGINS
NEXT_PUBLIC_NYM_API_URL
NEXT_PUBLIC_NYM_FORCE_TLS
```

If CipherPay credentials are not configured, the app uses the local development payment provider. Use the dev payment endpoint only in local development or explicitly enabled production test environments.

The user-facing payment flow is intentionally provider-neutral: sellers set a ZEC price and payout Unified Address, buyers see a ZEC checkout, and CipherPay remains a backend payment rail.

## Seller Workspaces

Sellers can create a no-email workspace:

- public route: `/s/<handle>`
- login: `<handle>` plus a one-time displayed `ppf_...` access key
- default ZEC payout wallet
- public paid files under `/s/<handle>/files/<orderId>`

The access key is shown once and only its hash is stored. This is enough for the local prototype and a simple hosted MVP. Production should add passkeys or hardware-wallet signing for recovery and stronger account protection.

## Real `nym-claim-v1` E2E

Run a backend Nym client:

```bash
nym-client init --id paidprivatefile-backend
nym-client run --id paidprivatefile-backend
```

Then configure:

```txt
NYM_CLIENT_ENDPOINT=ws://127.0.0.1:1977
PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY=1
NEXT_PUBLIC_NYM_API_URL=https://validator.nymtech.net/api
```

With `PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY=1`, `/api/transfers/:orderId/claim` sends the wrapped key envelope through Nym and does not include the key envelope or download URL in the HTTP response. The buyer browser starts its own Nym receiver, registers its Nym address on the order, receives the claim payload through Nym, downloads the ciphertext with the signed URL included inside that Nym payload, and decrypts locally.

## Validation

```bash
npm run check
npm test
npm run build
```

## Current Status

Prototype moving toward real `nym-claim-v1`. The system supports no-email seller workspaces, public seller routes, local encrypted-file order creation, seller wallet/price configuration, browser-side Nym receiver startup, Nym session registration, payment intent creation, dev payment confirmation, CipherPay webhook parsing, standalone `nym-client` WebSocket delivery, local Nym outbox fallback, signed ciphertext URLs inside the Nym claim payload, and browser-side decryption. The integrated `zkglobalcredit.tech` implementation now uses the same lower-friction buyer direction: open link, auto-detect a private receiver when available, pay in ZEC, then open locally.

Key custody is pure seller-held in every path: the server has no file key and no way to wrap it. The seller browser keeps `file_key` and `release_secret` in localStorage (`zectime_paid_link_seller_release_<orderId>`) and releases a buyer-wrapped key envelope via `POST /api/transfers/:orderId/key-release` after payment. The tradeoff is that the seller must keep the tab open to release the key; the seller panel auto-releases on payment confirmation and also exposes a manual "Release key" button. Until the seller releases, the buyer's claim is blocked with a clear "awaiting seller release" state.

Before production, harden:

- real CipherPay account configuration and webhook signatures
- native Nym client / local receiver packaging
- seller key vault durability / recovery (release secret loss means the key cannot be released)
- payment confirmation depth / finality semantics
- file retention and deletion
- abuse prevention
- seller payout address validation
- buyer key recovery UX
- operational monitoring
- Nym client/service-provider deployment and live reliability testing
- Nym message retry and delivery receipts
- encrypted chunk delivery for `nym-transfer-v1`

## License

TBD.
