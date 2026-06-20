export interface PaidLinkEncryptionDraft {
  encryptedFile: Blob;
  encryptedFileSha256: string;
  fileKey: string;
  encryptionIv: string;
}

export interface PaidLinkBuyerKeyPair {
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

export interface PaidLinkKeyEnvelope {
  scheme: "p256-ecdh-aes-gcm-v1";
  ephemeralPublicKeyJwk: JsonWebKey;
  iv: string;
  ciphertext: string;
}

export interface PaidLinkSellerReleaseDraft {
  releaseSecret: string;
  releaseSecretHash: string;
  fileKey: string;
}

const AES_GCM_IV_BYTES = 12;

export async function encryptPaidLinkFile(
  file: File,
): Promise<PaidLinkEncryptionDraft> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const plaintext = await file.arrayBuffer();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  const rawKey = await crypto.subtle.exportKey("raw", key);
  const ciphertextBytes = new Uint8Array(ciphertext);
  const digest = await crypto.subtle.digest("SHA-256", ciphertextBytes);

  return {
    encryptedFile: new Blob([ciphertextBytes], {
      type: "application/octet-stream",
    }),
    encryptedFileSha256: bytesToHex(new Uint8Array(digest)),
    fileKey: bytesToBase64(new Uint8Array(rawKey)),
    encryptionIv: bytesToBase64(iv),
  };
}

export async function createPaidLinkBuyerKeyPair(): Promise<PaidLinkBuyerKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );

  return {
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

export async function createPaidLinkSellerReleaseDraft(
  fileKey: string,
): Promise<PaidLinkSellerReleaseDraft> {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const digest = await crypto.subtle.digest("SHA-256", secret);

  return {
    releaseSecret: bytesToBase64(secret),
    releaseSecretHash: bytesToHex(new Uint8Array(digest)),
    fileKey,
  };
}

export async function wrapPaidLinkFileKeyForBuyer(
  fileKey: string,
  buyerPublicJwk: JsonWebKey,
): Promise<PaidLinkKeyEnvelope> {
  const buyerPublicKey = await crypto.subtle.importKey(
    "jwk",
    buyerPublicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: buyerPublicKey },
    ephemeral.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    wrappingKey,
    base64ToBytes(fileKey),
  );

  return {
    scheme: "p256-ecdh-aes-gcm-v1",
    ephemeralPublicKeyJwk: await crypto.subtle.exportKey(
      "jwk",
      ephemeral.publicKey,
    ),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptPaidLinkFileKey(
  envelope: PaidLinkKeyEnvelope,
  privateJwk: JsonWebKey,
): Promise<CryptoKey> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"],
  );
  const ephemeralPublicKey = await crypto.subtle.importKey(
    "jwk",
    envelope.ephemeralPublicKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: ephemeralPublicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const rawFileKey = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
    wrappingKey,
    base64ToBytes(envelope.ciphertext),
  );

  return crypto.subtle.importKey(
    "raw",
    rawFileKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

export async function decryptPaidLinkFile(
  encryptedBytes: ArrayBuffer,
  fileKey: CryptoKey,
  encryptionIv: string,
  mimeType: string,
): Promise<Blob> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encryptionIv) },
    fileKey,
    encryptedBytes,
  );
  return new Blob([plaintext], {
    type: mimeType || "application/octet-stream",
  });
}

export function saveBuyerKeyPair(
  orderId: string,
  keyPair: PaidLinkBuyerKeyPair,
): void {
  window.localStorage.setItem(storageKey(orderId), JSON.stringify(keyPair));
}

export function loadBuyerKeyPair(orderId: string): PaidLinkBuyerKeyPair | null {
  const raw = window.localStorage.getItem(storageKey(orderId));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PaidLinkBuyerKeyPair;
    if (
      parsed.publicJwk?.kty === "EC" &&
      parsed.privateJwk?.kty === "EC" &&
      parsed.publicJwk.crv === "P-256" &&
      parsed.privateJwk.crv === "P-256"
    ) {
      return parsed;
    }
  } catch {
    window.localStorage.removeItem(storageKey(orderId));
  }
  return null;
}

export function saveSellerReleaseDraft(
  orderId: string,
  draft: PaidLinkSellerReleaseDraft,
): void {
  window.localStorage.setItem(sellerStorageKey(orderId), JSON.stringify(draft));
}

export function loadSellerReleaseDraft(
  orderId: string,
): PaidLinkSellerReleaseDraft | null {
  const raw = window.localStorage.getItem(sellerStorageKey(orderId));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PaidLinkSellerReleaseDraft;
    if (
      typeof parsed.releaseSecret === "string" &&
      typeof parsed.releaseSecretHash === "string" &&
      typeof parsed.fileKey === "string"
    ) {
      return parsed;
    }
  } catch {
    window.localStorage.removeItem(sellerStorageKey(orderId));
  }
  return null;
}

/**
 * Human-comparable fingerprint of a P-256 public key. Buyer and seller compute
 * the same code from the same public key; if a malicious server substitutes the
 * buyer key the seller wraps to, the seller's code will NOT match the code the
 * buyer reads, exposing the substitution when compared out-of-band.
 */
export async function fingerprintPaidLinkPublicKey(
  publicJwk: JsonWebKey,
): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const code = bytesToHex(digest.slice(0, 10)).toUpperCase();
  return (code.match(/.{1,4}/gu) ?? []).join("-");
}

function storageKey(orderId: string): string {
  return `zectime_paid_link_buyer_key_${orderId}`;
}

function sellerStorageKey(orderId: string): string {
  return `zectime_paid_link_seller_release_${orderId}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return window.btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = window.atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
