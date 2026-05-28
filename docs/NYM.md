# Nym Integration

Nym is the core private transport layer for Paid Private File.

It should not handle payment and it should not be treated as permanent storage. Zcash/CipherPay handles payment confirmation. Paid Private File handles encryption, order state, and key-release policy. Nym hides network metadata when the claim payload or encrypted file is delivered.

## Core Target

The first required transport mode is `nym-claim-v1`.

```txt
Buyer
  runs local receiver helper
  page detects Nym address automatically
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

This keeps bandwidth low and makes the product usable before full file transport over Nym is mature. HTTP delivery is only a development fallback; the product privacy model is Nym delivery.

## Buyer UX

The buyer should not need to understand Nym during the normal path:

```txt
Open private link
  -> local receiver detected
  -> Pay in ZEC
  -> Download and open locally
```

Manual Nym address entry is a fallback only. In the integrated site
implementation, the page calls the local bridge `/address` endpoint to fill the
receiver before creating the ZEC payment.

## Maximum-Privacy Target

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

The user-facing product should be stronger than a paid download:

> ZEC payment unlocks a private Nym delivery session. The file opens only on the buyer's machine.

Nym is part of the core promise. Advanced details can explain claim mode, transfer mode, chunking, and reliability.
