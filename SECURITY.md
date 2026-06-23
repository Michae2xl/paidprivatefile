# Security Policy

Paid Private File handles **real money (mainnet ZEC)**, decryption keys, and
buyer/seller privacy. Please treat security reports responsibly.

## Reporting a vulnerability

Use **GitHub Private Vulnerability Reporting** for this repository:
**Security → Report a vulnerability** (the "Report a vulnerability" button on the
repo's Security tab). This opens a private advisory only the maintainers can see.

Please do **not** open a public issue for a security problem. Include repro steps,
affected files/endpoints, and impact. We aim to acknowledge within a few days.

## Scope

In scope: anything that could lose a buyer's funds, lose or expose a sold file,
leak or substitute a decryption key, bypass payment, or break access control
(reading/claiming/releasing another party's order or another seller's data).

## Security model (summary)

The full trust model lives in [ARCHITECTURE.md](ARCHITECTURE.md#trust-boundaries--who-holds-what).
Key properties:

- **Non-custodial.** The platform holds only a view-only Unified Full Viewing Key
  (UFVK). It can detect payments but **can never spend** — spending keys never
  leave the seller's wallet.
- **Zero-knowledge server (content).** The file is AES-256-GCM encrypted in the
  seller's browser. The server only ever holds ciphertext it cannot read — it has
  neither the AES file key nor the buyer's private key.
- **Private delivery.** The decryption key and the encrypted file are delivered
  browser-to-browser over the Nym mixnet and decrypted only on the buyer's device.

## Known limitation (be aware)

The non-custodial guarantee against an **honest-but-curious** server is strong, but
the system is **not unconditionally trustless**. The buyer's public key reaches the
seller via the server, so a **malicious/compromised server (or a MITM on the
seller's session)** could substitute its own key in the release challenge and
recover the file key. Mitigation: the seller can use the **verified release** path
(out-of-band buyer-key fingerprint comparison) for a strong guarantee; the
convenience default (auto-release) trusts the server-provided buyer key. See
[ARCHITECTURE.md](ARCHITECTURE.md#threat-model-and-its-limit).

## Supported versions

This is an evolving project; only the latest `main` (and the deployed production
build) is supported. There are no long-term maintenance branches yet.
