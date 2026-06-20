// Pure seller-held key custody guarantees.
// The server NEVER holds the AES file key: orders are created with a
// releaseSecretHash only, and the wrapped key envelope is produced by the
// seller browser via the key-release endpoint after payment is confirmed.

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { POST as createTransferRoute } from "../app/api/transfers/route";
import { POST as claimTransferRoute } from "../app/api/transfers/[orderId]/claim/route";
import { POST as devPayRoute } from "../app/api/transfers/[orderId]/dev-pay/route";
import { POST as keyReleaseRoute } from "../app/api/transfers/[orderId]/key-release/route";
import { POST as nymSessionRoute } from "../app/api/transfers/[orderId]/nym-session/route";
import { POST as paymentIntentRoute } from "../app/api/transfers/[orderId]/payment-intent/route";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";
import {
  createPaidLinkBuyerKeyPair,
  createPaidLinkSellerReleaseDraft,
  decryptPaidLinkFile,
  decryptPaidLinkFileKey,
  encryptPaidLinkFile,
  fingerprintPaidLinkPublicKey,
  wrapPaidLinkFileKeyForBuyer,
  type PaidLinkKeyEnvelope,
} from "../lib/paid-link-client-crypto";

let runtimeDir: string;

beforeAll(() => {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  if (typeof globalScope.window === "undefined") {
    globalScope.window = {
      btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    };
  }
});

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-release-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET =
    "test-transfer-token-secret";
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  delete process.env.CIPHERPAY_API_URL;
  delete process.env.CIPHERPAY_API_KEY;
  delete process.env.NYM_CLIENT_ENDPOINT;
  delete process.env.PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY;
  resetRateLimitStateForTesting();
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET;
  delete process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS;
  await rm(runtimeDir, { recursive: true, force: true });
});

interface PublicOrder {
  orderId: string;
  status: string;
  release: {
    mode: string;
    status: string;
    releasedAt: string | null;
  };
}

interface ReleaseChallenge {
  order: PublicOrder;
  release: {
    status: string;
    buyerPublicKeyHash: string | null;
    buyerPublicKeyJwk: JsonWebKey | null;
    releasedAt: string | null;
  };
}

interface ErrorEnvelope {
  error: { kind: string; message: string };
}

describe("pure seller-held key custody", () => {
  it("creates an order with releaseSecretHash and never persists a file key", async () => {
    const { draft } = await encryptSecret("alpha");
    const createResponse = await createTransferRoute(
      makeSellerHeldCreateRequest(draft),
    );
    expect(createResponse.status).toBe(200);
    const createBody = (await createResponse.json()) as { order: PublicOrder };
    expect(createBody.order.release.mode).toBe("seller-held");
    expect(createBody.order.release.status).toBe("seller_pending");

    const raw = await readOrderJson(createBody.order.orderId);
    const parsed = JSON.parse(raw) as {
      encryption: { scheme: string; iv: string; fileKey?: string };
      release: {
        mode: string;
        releaseSecretHash: string | null;
        keyEnvelope: unknown;
      };
    };
    expect(parsed.encryption.fileKey).toBeUndefined();
    expect("fileKey" in parsed.encryption).toBe(false);
    expect(parsed.release.mode).toBe("seller-held");
    expect(parsed.release.releaseSecretHash).toBe(draft.releaseSecretHash);
    expect(parsed.release.keyEnvelope).toBeNull();
    expect(raw).not.toContain("fileKey");
  });

  it("rejects create requests that still carry a raw fileKey", async () => {
    const { draft } = await encryptSecret("beta");
    const form = sellerHeldForm(draft);
    form.set("fileKey", randomBytes(32).toString("base64"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createTransferRoute(
        new Request("http://localhost/api/transfers", {
          method: "POST",
          body: form,
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("validation");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("never writes a 32-byte file key after payment is confirmed", async () => {
    const { draft, fileKeyBytes } = await encryptSecret("gamma");
    const orderId = await createSellerHeldOrder(draft);
    const buyer = await createPaidLinkBuyerKeyPair();

    await paymentIntent(orderId, buyer.publicJwk);
    await registerNym(orderId, buyer.publicJwk);
    await devPay(orderId);

    const raw = await readOrderJson(orderId);
    expect(raw).not.toContain("fileKey");
    const fileKeyBase64 = Buffer.from(fileKeyBytes).toString("base64");
    expect(raw).not.toContain(fileKeyBase64);
    const fileKeyHex = Buffer.from(fileKeyBytes).toString("hex");
    expect(raw).not.toContain(fileKeyHex);
  });

  it("blocks claim before the seller releases the key", async () => {
    const { draft } = await encryptSecret("delta");
    const orderId = await createSellerHeldOrder(draft);
    const buyer = await createPaidLinkBuyerKeyPair();

    await paymentIntent(orderId, buyer.publicJwk);
    await registerNym(orderId, buyer.publicJwk);
    await devPay(orderId);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const claimResponse = await claimTransferRoute(
        jsonRequest(`http://localhost/api/transfers/${orderId}/claim`, {
          buyerPublicKeyJwk: buyer.publicJwk,
        }),
        routeContext(orderId),
      );
      expect(claimResponse.status).toBe(402);
      const body = (await claimResponse.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("payment_required");
      expect(body.error.message).toContain("release");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects a wrong release secret with a timing-safe comparison", async () => {
    const { draft } = await encryptSecret("epsilon");
    const orderId = await createSellerHeldOrder(draft);
    const buyer = await createPaidLinkBuyerKeyPair();
    await paymentIntent(orderId, buyer.publicJwk);
    await registerNym(orderId, buyer.publicJwk);
    await devPay(orderId);

    const wrongSecret = Buffer.from(randomBytes(32)).toString("base64");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await keyReleaseRoute(
        jsonRequest(`http://localhost/api/transfers/${orderId}/key-release`, {
          releaseSecret: wrongSecret,
        }),
        routeContext(orderId),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.message).toMatch(/release secret/iu);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects release before payment is confirmed", async () => {
    const { draft } = await encryptSecret("zeta");
    const orderId = await createSellerHeldOrder(draft);
    const buyer = await createPaidLinkBuyerKeyPair();
    await paymentIntent(orderId, buyer.publicJwk);
    await registerNym(orderId, buyer.publicJwk);

    const keyEnvelope = await wrapPaidLinkFileKeyForBuyer(
      draft.fileKey,
      buyer.publicJwk,
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await keyReleaseRoute(
        jsonRequest(`http://localhost/api/transfers/${orderId}/key-release`, {
          action: "release",
          releaseSecret: draft.releaseSecret,
          keyEnvelope,
        }),
        routeContext(orderId),
      );
      expect(response.status).toBe(402);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("payment_required");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("exposes buyer public key only after payment and transitions release status", async () => {
    const { draft } = await encryptSecret("eta");
    const orderId = await createSellerHeldOrder(draft);
    const buyer = await createPaidLinkBuyerKeyPair();

    // waiting_for_buyer: no payment session yet.
    const beforeBuyer = await keyReleaseStatus(orderId, draft.releaseSecret);
    expect(beforeBuyer.release.status).toBe("waiting_for_buyer");
    expect(beforeBuyer.release.buyerPublicKeyJwk).toBeNull();

    await paymentIntent(orderId, buyer.publicJwk);
    await registerNym(orderId, buyer.publicJwk);

    // waiting_for_payment: buyer bound but unpaid.
    const beforePay = await keyReleaseStatus(orderId, draft.releaseSecret);
    expect(beforePay.release.status).toBe("waiting_for_payment");
    expect(beforePay.release.buyerPublicKeyJwk).toBeNull();

    await devPay(orderId);

    // ready_to_release: buyer public key disclosed to the seller.
    const ready = await keyReleaseStatus(orderId, draft.releaseSecret);
    expect(ready.release.status).toBe("ready_to_release");
    expect(ready.release.buyerPublicKeyJwk?.kty).toBe("EC");
    expect(ready.release.buyerPublicKeyJwk?.crv).toBe("P-256");

    // released after the seller posts the envelope.
    const keyEnvelope = await wrapPaidLinkFileKeyForBuyer(
      draft.fileKey,
      ready.release.buyerPublicKeyJwk as JsonWebKey,
    );
    const released = await keyReleaseAction(
      orderId,
      draft.releaseSecret,
      keyEnvelope,
    );
    expect(released.release.status).toBe("released");
    expect(released.release.releasedAt).toBeTruthy();
    expect(released.order.release.status).toBe("ready");
  });

  it("persists buyer public key JWK on the payment record", async () => {
    const { draft } = await encryptSecret("theta");
    const orderId = await createSellerHeldOrder(draft);
    const buyer = await createPaidLinkBuyerKeyPair();
    await paymentIntent(orderId, buyer.publicJwk);

    const raw = await readOrderJson(orderId);
    const parsed = JSON.parse(raw) as {
      payment: { buyerPublicKeyJwk?: { x?: string; y?: string } };
    };
    expect(parsed.payment.buyerPublicKeyJwk?.x).toBe(buyer.publicJwk.x);
    expect(parsed.payment.buyerPublicKeyJwk?.y).toBe(buyer.publicJwk.y);
  });

  it("round-trips a seller-wrapped envelope through the buyer private key", async () => {
    const buyer = await createPaidLinkBuyerKeyPair();
    const draft = await createPaidLinkSellerReleaseDraft(
      Buffer.from(randomBytes(32)).toString("base64"),
    );

    const envelope = await wrapPaidLinkFileKeyForBuyer(
      draft.fileKey,
      buyer.publicJwk,
    );
    const fileKey = await decryptPaidLinkFileKey(envelope, buyer.privateJwk);

    // Prove the recovered AES-GCM key actually decrypts data wrapped with the
    // same raw key bytes.
    const iv = randomBytes(12);
    const rawKey = Buffer.from(draft.fileKey, "base64");
    const importedKey = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const plaintext = new TextEncoder().encode("seller-held round trip");
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      importedKey,
      plaintext,
    );
    const opened = await decryptPaidLinkFile(
      ciphertext,
      fileKey,
      Buffer.from(iv).toString("base64"),
      "text/plain",
    );
    const recovered = new Uint8Array(await opened.arrayBuffer());
    expect(new TextDecoder().decode(recovered)).toBe("seller-held round trip");
  });

  it("derives a stable buyer-key fingerprint that differs for a substituted key", async () => {
    const buyer = await createPaidLinkBuyerKeyPair();
    const attacker = await createPaidLinkBuyerKeyPair();

    const code = await fingerprintPaidLinkPublicKey(buyer.publicJwk);
    // Deterministic: same key -> same code (buyer and seller agree).
    expect(await fingerprintPaidLinkPublicKey(buyer.publicJwk)).toBe(code);
    // Human-comparable format: 5 groups of 4 uppercase hex.
    expect(code).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/u);
    // Substitution detection: a different (attacker) key yields a different code,
    // so a malicious server swapping the buyer key is caught out-of-band.
    expect(await fingerprintPaidLinkPublicKey(attacker.publicJwk)).not.toBe(
      code,
    );
  });

  it("makes key release monotonic: a second release cannot swap the envelope", async () => {
    const { draft } = await encryptSecret("iota");
    const orderId = await createSellerHeldOrder(draft);
    const buyer = await createPaidLinkBuyerKeyPair();
    await paymentIntent(orderId, buyer.publicJwk);
    await registerNym(orderId, buyer.publicJwk);
    await devPay(orderId);

    const first = await wrapPaidLinkFileKeyForBuyer(
      draft.fileKey,
      buyer.publicJwk,
    );
    const released = await keyReleaseAction(
      orderId,
      draft.releaseSecret,
      first,
    );
    expect(released.release.status).toBe("released");

    // A second release attempt (e.g. to swap in attacker content) is rejected.
    const second = await wrapPaidLinkFileKeyForBuyer(
      draft.fileKey,
      buyer.publicJwk,
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await keyReleaseRoute(
        jsonRequest(`http://localhost/api/transfers/${orderId}/key-release`, {
          action: "release",
          releaseSecret: draft.releaseSecret,
          keyEnvelope: second,
        }),
        routeContext(orderId),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.message).toMatch(/already released/iu);
    } finally {
      consoleSpy.mockRestore();
    }

    // The buyer still receives the ORIGINAL (first) envelope, not a swap.
    const claimResponse = await claimTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId}/claim`, {
        buyerPublicKeyJwk: buyer.publicJwk,
      }),
      routeContext(orderId),
    );
    expect(claimResponse.status).toBe(200);
    const claimBody = (await claimResponse.json()) as {
      keyEnvelope: PaidLinkKeyEnvelope;
    };
    expect(claimBody.keyEnvelope.ciphertext).toBe(first.ciphertext);
  });
});

async function encryptSecret(label: string): Promise<{
  draft: Awaited<ReturnType<typeof encryptPaidLinkFile>> & {
    releaseSecret: string;
    releaseSecretHash: string;
  };
  fileKeyBytes: Uint8Array;
}> {
  const plaintext = new TextEncoder().encode(
    `secret ${label} ${"y".repeat(64)}`,
  );
  const encryption = await encryptPaidLinkFile(
    new File([plaintext], "secret.pdf", { type: "application/pdf" }),
  );
  const release = await createPaidLinkSellerReleaseDraft(encryption.fileKey);
  return {
    draft: {
      ...encryption,
      releaseSecret: release.releaseSecret,
      releaseSecretHash: release.releaseSecretHash,
    },
    fileKeyBytes: new Uint8Array(Buffer.from(encryption.fileKey, "base64")),
  };
}

type SellerHeldDraft = Awaited<ReturnType<typeof encryptPaidLinkFile>> & {
  releaseSecretHash: string;
};

function sellerHeldForm(draft: SellerHeldDraft): FormData {
  const form = new FormData();
  form.set("encryptedFile", draft.encryptedFile, "secret.pdf.enc");
  form.set("fileName", "secret.pdf");
  form.set("mimeType", "application/pdf");
  form.set("originalSizeBytes", "321");
  form.set("encryptedFileSha256", draft.encryptedFileSha256);
  form.set("encryptionIv", draft.encryptionIv);
  form.set("releaseSecretHash", draft.releaseSecretHash);
  form.set("amountZats", "5000000");
  form.set("sellerPayoutAddress", testSellerPayoutAddress());
  return form;
}

function makeSellerHeldCreateRequest(draft: SellerHeldDraft): Request {
  return new Request("http://localhost/api/transfers", {
    method: "POST",
    body: sellerHeldForm(draft),
  });
}

async function createSellerHeldOrder(draft: SellerHeldDraft): Promise<string> {
  const response = await createTransferRoute(
    makeSellerHeldCreateRequest(draft),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { order: PublicOrder };
  return body.order.orderId;
}

async function paymentIntent(
  orderId: string,
  publicJwk: JsonWebKey,
): Promise<void> {
  const response = await paymentIntentRoute(
    jsonRequest(`http://localhost/api/transfers/${orderId}/payment-intent`, {
      buyerPublicKeyJwk: publicJwk,
    }),
    routeContext(orderId),
  );
  expect(response.status).toBe(200);
}

async function registerNym(
  orderId: string,
  publicJwk: JsonWebKey,
): Promise<void> {
  const response = await nymSessionRoute(
    jsonRequest(`http://localhost/api/transfers/${orderId}/nym-session`, {
      buyerNymAddress: testBuyerNymAddress(),
      buyerPublicKeyJwk: publicJwk,
      transport: "nym-claim-v1",
    }),
    routeContext(orderId),
  );
  expect(response.status).toBe(200);
}

async function devPay(orderId: string): Promise<void> {
  const response = await devPayRoute(
    new Request(`http://localhost/api/transfers/${orderId}/dev-pay`, {
      method: "POST",
    }),
    routeContext(orderId),
  );
  expect(response.status).toBe(200);
}

async function keyReleaseStatus(
  orderId: string,
  releaseSecret: string,
): Promise<ReleaseChallenge> {
  const response = await keyReleaseRoute(
    jsonRequest(`http://localhost/api/transfers/${orderId}/key-release`, {
      releaseSecret,
    }),
    routeContext(orderId),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as ReleaseChallenge;
}

async function keyReleaseAction(
  orderId: string,
  releaseSecret: string,
  keyEnvelope: PaidLinkKeyEnvelope,
): Promise<ReleaseChallenge> {
  const response = await keyReleaseRoute(
    jsonRequest(`http://localhost/api/transfers/${orderId}/key-release`, {
      action: "release",
      releaseSecret,
      keyEnvelope,
    }),
    routeContext(orderId),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as ReleaseChallenge;
}

async function readOrderJson(orderId: string): Promise<string> {
  return readFile(
    join(runtimeDir, "paid-transfers", "orders", orderId, "order.json"),
    "utf8",
  );
}

function routeContext(orderId: string) {
  return { params: Promise.resolve({ orderId }) };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function testSellerPayoutAddress(): string {
  return "u1sellerpayoutaddress000000000000000000000000000000000";
}

function testBuyerNymAddress(): string {
  return "nym1buyerprivateaddress000000000000000000000000000000";
}
