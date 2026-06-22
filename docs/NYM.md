# Nym Integration

Nym is the private delivery transport for Paid Private File. **Both the wrapped decryption key and the encrypted file are delivered browser-to-browser over the Nym mixnet** (seller browser → buyer browser), after the ZEC payment is confirmed.

Nym is not a payment rail and not storage. Zcash + the view-only scanner handle payment confirmation; the app handles encryption, order state, and key-release policy; Nym hides the network metadata of the key and file delivery.

This is a change from earlier versions: Nym used to carry only the wrapped key, and the encrypted file was always fetched over HTTPS. Now the file rides the mixnet too, with HTTPS retained only as an automatic fallback.

## Transport modes

- `nym-claim-v1` — the wrapped P-256 ECDH key envelope rides the mixnet (Nym **text** channel).
- `nym-transfer-v1` — the AES-256-GCM encrypted file itself rides the mixnet (the chunked binary transfer below).

In the production path both run together: the seller browser sends the key envelope over the text channel and streams the encrypted file over the binary channel to the same buyer Nym address.

## Browser-to-browser delivery (no server nym-client)

The fully private path runs entirely between the two browsers, each running `@nymproject/sdk-full-fat`. No server-side `nym-client` is involved; the server never relays the key.

Gated by:

```txt
PAID_PRIVATE_FILE_BROWSER_NYM_DELIVERY=1   # server: claim returns deliveryMode "browser-nym", no key over HTTP
NEXT_PUBLIC_PPF_BROWSER_NYM=1              # client: browser-direct key delivery
NEXT_PUBLIC_PPF_BROWSER_NYM_FILE          # client: file-over-Nym (on by default when browser-nym is on; =0 forces HTTPS-only)
```

The browser Nym WASM client needs cross-origin isolation (SharedArrayBuffer / threaded workers), so the app sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (see `next.config.ts`). Without these the receiver cannot start.

### Flow

```txt
Buyer browser
  starts an in-page Nym receiver, polls selfAddress() until the gateway handshake completes
  registers buyerNymAddress via POST /api/transfers/:orderId/nym-session
  pays in ZEC

Payment confirmed (scanner -> signed webhook -> order paid)

Seller browser (tab must stay open)
  releases the key (server POST kept for record + monotonic guard)
  reads release.buyerNymAddress from the release challenge
  KEY:  client.send({ payload: { message: { schema, orderId, keyEnvelope }, mimeType: "application/json" }, recipient })
  FILE: streams the encrypted ciphertext over rawSend (chunked transfer below)

Buyer browser
  receives the key envelope on the text channel
  reassembles + SHA-256-verifies the file on the binary channel
  decrypts locally with the buyer's private key + the key envelope
  POST /api/transfers/:orderId/delivered  (status only, via: nym)
```

`POST /api/transfers/:orderId/claim` in this mode returns `deliveryMode: "browser-nym"` with the signed ciphertext `download` URL **and no `keyEnvelope`** — the key transits the mixnet, and the URL is only the HTTPS fallback source.

## The chunked file transfer (`lib/nym-file-transfer.ts`)

A clean-room reliable-bytes layer over the SDK's binary `rawSend` / `subscribeToRawMessageReceivedEvent`. It does no key agreement (the bytes are already encrypted and the buyer is already authenticated by the key envelope) — purely reliable transport.

- **Framing:** 48-byte header (`magic "NF"`, version, type, 32-byte orderId, `seq`, `total`, `payloadLength`) + payload. Types: `Offer`, `Chunk`, `Ack`, `Retransmit`, `Done`.
- **Chunks:** 32 KiB application chunks.
- **Pacing:** ~48 KiB/s, because the Nym gateway drains ~46 KiB/s (unpaced sends were observed to hang).
- **Reorder buffer:** chunks reassembled order-independently from a `Map<seq, bytes>`.
- **ARQ:** after a 30s silence gap (or immediately on `Done`), the receiver requests its first missing chunk; the sender re-streams it plus a small forward window (4), single-flight.
- **Integrity:** SHA-256 over the whole ciphertext, pinned in the `Offer`, re-verified after reassembly and checked against the order's `encryptedFileSha256`.
- **Completion:** verified reassembly → `Ack` → sender's `done()` resolves. Sender has an ack timeout; receiver has an overall ceiling (~600s).

## HTTPS fallback

The encrypted file is also uploaded to the server, so the buyer can fetch it over HTTPS (a short-lived HMAC-signed URL) and decrypt locally if the Nym transfer stalls. The fallback is a **no-progress stall timer** (~90s) that is re-armed on every receive-progress event — a healthy slow large transfer keeps re-arming and is never yanked off the Nym path; only a genuine stall aborts to HTTPS. Decryption stays local in both paths.

A provenance badge records the actual path: **"received over Nym (mixnet)"** vs **"received over HTTPS (Nym fallback)"**, and the buyer's delivery ack carries `via: "nym" | "https"` so the seller dashboard shows it too.

> Note on the badge: when only the key envelope rode the mixnet but the file bytes were fetched over the signed HTTPS URL, that is classified as an HTTPS delivery. Only the path where the file is reassembled over the mixnet (the binary transfer) is classified "nym".

## Buyer UX

The buyer should not need to understand Nym in the normal path:

```txt
Open the link -> a private receiver is set up automatically -> pay in ZEC -> the file arrives and opens locally
```

Manual Nym address entry exists only as a fallback.

## Legacy adapters

The server-relayed `nym` mode (a standalone `nym-client` WebSocket, `NYM_CLIENT_ENDPOINT`) and the local outbox / `http-dev-fallback` mode remain for environments where the browser-direct flags are off. The production path is browser-to-browser.
