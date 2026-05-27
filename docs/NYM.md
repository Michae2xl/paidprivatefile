# Nym Integration

Nym is the private transport layer for Paid Private File.

It should not handle payment and it should not be treated as permanent storage. Zcash/CipherPay handles payment confirmation. Paid Private File handles encryption, order state, and key-release policy. Nym hides network metadata when the claim payload or encrypted file is delivered.

## Phase B Target

The first integration should be `nym-claim-v1`.

```txt
Buyer
  creates or provides Nym address
  creates buyer public key
  sends both to /api/transfers/:orderId/nym-session

API
  stores Nym claim session
  waits for payment confirmation
  wraps file key to buyer public key
  sends wrapped key envelope through Nym

Buyer
  receives key envelope locally
  downloads ciphertext
  decrypts file locally
```

This keeps bandwidth low and makes the product usable before full file transport over Nym is mature.

## Later Target

`nym-transfer-v1` sends encrypted file chunks through Nym:

```txt
encrypted file -> chunks -> Nym service provider -> buyer -> reassemble -> decrypt
```

This mode gives better metadata privacy but needs:

- chunk hashes
- retry policy
- max file size
- transfer progress
- Nym delivery receipts
- local buyer daemon or browser-compatible bridge

## Product Copy Boundary

The user-facing product should stay simple:

> Send a private file. The recipient pays in ZEC. Then they download and open it locally.

Nym belongs in advanced details and architecture docs unless the user explicitly asks how private delivery works.
