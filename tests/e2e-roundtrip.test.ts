// Full real-crypto end-to-end round-trip (dev-pay path):
// encrypt (real client crypto) -> create order -> payment intent -> nym session
// -> dev-pay -> claim -> unwrap key envelope -> decrypt ciphertext -> assert it
// equals the original plaintext. This exercises the actual browser client crypto
// (encryptPaidLinkFile / decryptPaidLinkFileKey / decryptPaidLinkFile) against the
// real server-side ECDH-ES wrap, which the existing suite never did.

import { mkdtemp, rm } from "node:fs/promises";
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
import { GET as fileRoute } from "../app/api/transfers/[orderId]/file/route";
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
  wrapPaidLinkFileKeyForBuyer,
  type PaidLinkKeyEnvelope,
} from "../lib/paid-link-client-crypto";

let runtimeDir: string;

beforeAll(() => {
  // The client crypto lib uses window.btoa/window.atob; provide them in node.
  const globalScope = globalThis as unknown as Record<string, unknown>;
  if (typeof globalScope.window === "undefined") {
    globalScope.window = {
      btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    };
  }
});

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-e2e-"));
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

describe("paid private file — real crypto end-to-end", () => {
  it("encrypt -> pay (dev) -> claim -> unwrap -> decrypt recovers the original file", async () => {
    const originalText =
      "Top secret contract — paid private file real E2E ✅\n" + "x".repeat(200);
    const plaintext = new TextEncoder().encode(originalText);

    // 1) Seller encrypts the file locally with the real client crypto and
    //    keeps the AES key in a local seller-held release draft. The server
    //    never receives the file key — only the SHA-256 of the release secret.
    const draft = await encryptPaidLinkFile(
      new File([plaintext], "secret.pdf", { type: "application/pdf" }),
    );
    const releaseDraft = await createPaidLinkSellerReleaseDraft(draft.fileKey);

    // 2) Create the order with the REAL ciphertext and IV but NO file key.
    const form = new FormData();
    form.set("encryptedFile", draft.encryptedFile, "secret.pdf.enc");
    form.set("fileName", "secret.pdf");
    form.set("mimeType", "application/pdf");
    form.set("originalSizeBytes", String(plaintext.byteLength));
    form.set("encryptedFileSha256", draft.encryptedFileSha256);
    form.set("encryptionIv", draft.encryptionIv);
    form.set("releaseSecretHash", releaseDraft.releaseSecretHash);
    form.set("amountZats", "5000000");
    form.set("sellerPayoutAddress", testSellerPayoutAddress());

    const createResponse = await createTransferRoute(
      new Request("http://localhost/api/transfers", {
        method: "POST",
        body: form,
      }),
    );
    expect(createResponse.status).toBe(200);
    const { order } = (await createResponse.json()) as {
      order: { orderId: string };
    };
    const orderId = order.orderId;

    // 3) Buyer generates its key pair (real client crypto).
    const buyer = await createPaidLinkBuyerKeyPair();

    // 4) Payment intent, Nym session, dev-pay, claim.
    const paymentResponse = await paymentIntentRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId}/payment-intent`, {
        buyerPublicKeyJwk: buyer.publicJwk,
      }),
      routeContext(orderId),
    );
    expect(paymentResponse.status).toBe(200);

    const nymResponse = await nymSessionRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId}/nym-session`, {
        buyerNymAddress: testBuyerNymAddress(),
        buyerPublicKeyJwk: buyer.publicJwk,
        transport: "nym-claim-v1",
      }),
      routeContext(orderId),
    );
    expect(nymResponse.status).toBe(200);

    const paidResponse = await devPayRoute(
      new Request(`http://localhost/api/transfers/${orderId}/dev-pay`, {
        method: "POST",
      }),
      routeContext(orderId),
    );
    expect(paidResponse.status).toBe(200);

    // 4b) The seller browser releases the key: it asks the server for the
    //     paid buyer public key, wraps the file key locally, and posts the
    //     envelope. The server still never sees the raw file key.
    const statusResponse = await keyReleaseRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId}/key-release`, {
        releaseSecret: releaseDraft.releaseSecret,
      }),
      routeContext(orderId),
    );
    expect(statusResponse.status).toBe(200);
    const challenge = (await statusResponse.json()) as {
      release: { status: string; buyerPublicKeyJwk: JsonWebKey | null };
    };
    expect(challenge.release.status).toBe("ready_to_release");
    const sellerEnvelope = await wrapPaidLinkFileKeyForBuyer(
      releaseDraft.fileKey,
      challenge.release.buyerPublicKeyJwk as JsonWebKey,
    );
    const releaseResponse = await keyReleaseRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId}/key-release`, {
        action: "release",
        releaseSecret: releaseDraft.releaseSecret,
        keyEnvelope: sellerEnvelope,
      }),
      routeContext(orderId),
    );
    expect(releaseResponse.status).toBe(200);

    const claimResponse = await claimTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId}/claim`, {
        buyerPublicKeyJwk: buyer.publicJwk,
      }),
      routeContext(orderId),
    );
    expect(claimResponse.status).toBe(200);
    const claimBody = (await claimResponse.json()) as {
      order: { status: string };
      keyEnvelope: PaidLinkKeyEnvelope;
      download: { url: string };
    };
    expect(claimBody.order.status).toBe("claimed");
    expect(claimBody.keyEnvelope.scheme).toBe("p256-ecdh-aes-gcm-v1");
    expect(typeof claimBody.keyEnvelope.ephemeralPublicKeyJwk).toBe("object");
    expect(typeof claimBody.download.url).toBe("string");

    // 5) Buyer downloads the ciphertext via the signed URL.
    const fileResponse = await fileRoute(
      new Request(`http://localhost${claimBody.download.url}`),
      routeContext(orderId),
    );
    expect(fileResponse.status).toBe(200);
    const ciphertext = await fileResponse.arrayBuffer();

    // 6) Buyer unwraps the file key and decrypts locally (real client crypto).
    const fileKey = await decryptPaidLinkFileKey(
      claimBody.keyEnvelope,
      buyer.privateJwk,
    );
    const decryptedBlob = await decryptPaidLinkFile(
      ciphertext,
      fileKey,
      draft.encryptionIv,
      "application/pdf",
    );
    const recovered = new Uint8Array(await decryptedBlob.arrayBuffer());

    // 7) The recovered plaintext must equal the original, byte for byte.
    expect(recovered).toEqual(plaintext);
    expect(new TextDecoder().decode(recovered)).toBe(originalText);
  });

  it("fails the claim when the seller never releases the key", async () => {
    const plaintext = new TextEncoder().encode("no release means no key");
    const draft = await encryptPaidLinkFile(
      new File([plaintext], "secret.pdf", { type: "application/pdf" }),
    );
    const releaseDraft = await createPaidLinkSellerReleaseDraft(draft.fileKey);

    const form = new FormData();
    form.set("encryptedFile", draft.encryptedFile, "secret.pdf.enc");
    form.set("fileName", "secret.pdf");
    form.set("mimeType", "application/pdf");
    form.set("originalSizeBytes", String(plaintext.byteLength));
    form.set("encryptedFileSha256", draft.encryptedFileSha256);
    form.set("encryptionIv", draft.encryptionIv);
    form.set("releaseSecretHash", releaseDraft.releaseSecretHash);
    form.set("amountZats", "5000000");
    form.set("sellerPayoutAddress", testSellerPayoutAddress());

    const createResponse = await createTransferRoute(
      new Request("http://localhost/api/transfers", {
        method: "POST",
        body: form,
      }),
    );
    expect(createResponse.status).toBe(200);
    const { order } = (await createResponse.json()) as {
      order: { orderId: string };
    };
    const orderId = order.orderId;
    const buyer = await createPaidLinkBuyerKeyPair();

    await paymentIntentRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId}/payment-intent`, {
        buyerPublicKeyJwk: buyer.publicJwk,
      }),
      routeContext(orderId),
    );
    await nymSessionRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId}/nym-session`, {
        buyerNymAddress: testBuyerNymAddress(),
        buyerPublicKeyJwk: buyer.publicJwk,
        transport: "nym-claim-v1",
      }),
      routeContext(orderId),
    );
    await devPayRoute(
      new Request(`http://localhost/api/transfers/${orderId}/dev-pay`, {
        method: "POST",
      }),
      routeContext(orderId),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const claimResponse = await claimTransferRoute(
        jsonRequest(`http://localhost/api/transfers/${orderId}/claim`, {
          buyerPublicKeyJwk: buyer.publicJwk,
        }),
        routeContext(orderId),
      );
      expect(claimResponse.status).toBe(402);
      const body = (await claimResponse.json()) as {
        error: { kind: string; message: string };
      };
      expect(body.error.kind).toBe("payment_required");
      expect(body.error.message).toContain("release");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

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
