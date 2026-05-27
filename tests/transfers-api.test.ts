import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createTransferRoute } from "../app/api/transfers/route";
import { GET as readTransferRoute } from "../app/api/transfers/[orderId]/route";
import { POST as claimTransferRoute } from "../app/api/transfers/[orderId]/claim/route";
import { POST as devPayRoute } from "../app/api/transfers/[orderId]/dev-pay/route";
import { GET as fileRoute } from "../app/api/transfers/[orderId]/file/route";
import { POST as nymSessionRoute } from "../app/api/transfers/[orderId]/nym-session/route";
import { POST as paymentIntentRoute } from "../app/api/transfers/[orderId]/payment-intent/route";
import { POST as cipherPayWebhookRoute } from "../app/api/webhooks/cipherpay/route";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";

interface TransferPublicOrder {
  orderId: string;
  status: string;
  sellerPayoutAddress: string;
  payment: { provider: string; invoiceId: string; status: string } | null;
  delivery: {
    requiredTransport: string;
    nymSession: { status: string; buyerNymAddress: string } | null;
  };
}

interface ErrorEnvelope {
  error: {
    kind: string;
    message: string;
  };
}

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-test-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET =
    "test-transfer-token-secret";
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  delete process.env.CIPHERPAY_API_URL;
  delete process.env.CIPHERPAY_API_KEY;
  resetRateLimitStateForTesting();
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET;
  delete process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS;
  await rm(runtimeDir, { recursive: true, force: true });
});

describe("/api/transfers", () => {
  it("creates a ciphertext-only paid link and exposes public metadata", async () => {
    const createResponse = await createTransferRoute(makeCreateRequest());
    expect(createResponse.status).toBe(200);

    const createBody = (await createResponse.json()) as {
      order: TransferPublicOrder;
      sharePath: string;
    };
    expect(createBody.order.orderId).toMatch(/^pl_[a-f0-9]{24}$/u);
    expect(createBody.order.status).toBe("created");
    expect(createBody.sharePath).toContain("/paid-private-file?order=");
    expect(createBody.sharePath).toContain(createBody.order.orderId);

    const readResponse = await readTransferRoute(
      new Request(
        `http://localhost/api/transfers/${createBody.order.orderId}`,
      ),
      routeContext(createBody.order.orderId),
    );
    expect(readResponse.status).toBe(200);
    const readBody = (await readResponse.json()) as {
      order: TransferPublicOrder & {
        timestamp: { commitment: string } | null;
      };
    };
    expect(readBody.order.orderId).toBe(createBody.order.orderId);
    expect(readBody.order.sellerPayoutAddress).toBe(testSellerPayoutAddress());
    expect(readBody.order.timestamp?.commitment).toBe("aa".repeat(32));
    expect(readBody.order.delivery.requiredTransport).toBe("nym-claim-v1");
    expect(readBody.order.delivery.nymSession).toBeNull();
    expect(JSON.stringify(readBody)).not.toContain("fileKey");
    expect(JSON.stringify(readBody)).not.toContain("doc_hash");
  });

  it("requires confirmed payment before releasing a key envelope", async () => {
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();

    const paymentResponse = await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    expect(paymentResponse.status).toBe(200);
    const paymentBody = (await paymentResponse.json()) as {
      order: TransferPublicOrder;
      payment: { provider: string; invoiceId: string; paymentAddress: string };
    };
    expect(paymentBody.payment.provider).toBe("dev");
    expect(paymentBody.payment.paymentAddress).toBe(testSellerPayoutAddress());
    expect(paymentBody.order.status).toBe("payment_pending");

    const nymSessionResponse = await nymSessionRoute(
      jsonRequest(`http://localhost/api/transfers/${order.orderId}/nym-session`, {
        buyerNymAddress: testBuyerNymAddress(),
        buyerPublicKeyJwk: keyPair.publicJwk,
        transport: "nym-claim-v1",
      }),
      routeContext(order.orderId),
    );
    expect(nymSessionResponse.status).toBe(200);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const blockedClaim = await claimTransferRoute(
        jsonRequest(`http://localhost/api/transfers/${order.orderId}/claim`, {
          buyerPublicKeyJwk: keyPair.publicJwk,
        }),
        routeContext(order.orderId),
      );
      expect(blockedClaim.status).toBe(402);
      const blockedBody = (await blockedClaim.json()) as ErrorEnvelope;
      expect(blockedBody.error.kind).toBe("payment_required");
    } finally {
      consoleSpy.mockRestore();
    }

    const paidResponse = await devPayRoute(
      new Request(
        `http://localhost/api/transfers/${order.orderId}/dev-pay`,
        { method: "POST" },
      ),
      routeContext(order.orderId),
    );
    expect(paidResponse.status).toBe(200);

    const claimResponse = await claimTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${order.orderId}/claim`, {
        buyerPublicKeyJwk: keyPair.publicJwk,
      }),
      routeContext(order.orderId),
    );
    expect(claimResponse.status).toBe(200);
    const claimBody = (await claimResponse.json()) as {
      order: TransferPublicOrder;
      manifest: { timestampReceipt: { doc_hash_sha256: string } | null };
      keyEnvelope: { scheme: string; ciphertext: string };
      download: { url: string };
      nymDelivery: { transport: string; status: string };
    };
    expect(claimBody.order.status).toBe("claimed");
    expect(claimBody.order.sellerPayoutAddress).toBe(testSellerPayoutAddress());
    expect(claimBody.manifest.timestampReceipt?.doc_hash_sha256).toBe(
      "ee".repeat(32),
    );
    expect(claimBody.keyEnvelope.scheme).toBe("p256-ecdh-aes-gcm-v1");
    expect(claimBody.nymDelivery.transport).toBe("nym-claim-v1");
    expect(claimBody.nymDelivery.status).toBe("queued_local_outbox");

    const fileResponse = await fileRoute(
      new Request(`http://localhost${claimBody.download.url}`),
      routeContext(order.orderId),
    );
    expect(fileResponse.status).toBe(200);
    expect(new Uint8Array(await fileResponse.arrayBuffer())).toEqual(
      encryptedFixture(),
    );
  });

  it("accepts a paid CipherPay webhook using the invoice id index", async () => {
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();
    const paymentResponse = await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    const paymentBody = (await paymentResponse.json()) as {
      payment: { invoiceId: string };
    };

    const webhookResponse = await cipherPayWebhookRoute(
      jsonRequest("http://localhost/api/webhooks/cipherpay", {
        invoice_id: paymentBody.payment.invoiceId,
        status: "confirmed",
      }),
    );
    expect(webhookResponse.status).toBe(200);
    const webhookBody = (await webhookResponse.json()) as {
      order: TransferPublicOrder;
    };
    expect(webhookBody.order.status).toBe("paid");
  });

  it("requires a Nym session before releasing a paid file key", async () => {
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();
    await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    await devPayRoute(
      new Request(
        `http://localhost/api/transfers/${order.orderId}/dev-pay`,
        { method: "POST" },
      ),
      routeContext(order.orderId),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const claimResponse = await claimTransferRoute(
        jsonRequest(`http://localhost/api/transfers/${order.orderId}/claim`, {
          buyerPublicKeyJwk: keyPair.publicJwk,
        }),
        routeContext(order.orderId),
      );
      expect(claimResponse.status).toBe(402);
      const body = (await claimResponse.json()) as ErrorEnvelope;
      expect(body.error.message).toContain("Nym delivery session");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

async function createOrder(): Promise<TransferPublicOrder> {
  const response = await createTransferRoute(makeCreateRequest());
  const body = (await response.json()) as { order: TransferPublicOrder };
  return body.order;
}

function makeCreateRequest(): Request {
  const encrypted = encryptedFixture();
  const form = new FormData();
  form.set(
    "encryptedFile",
    new Blob([copyToArrayBuffer(encrypted)], {
      type: "application/octet-stream",
    }),
    "secret.pdf.enc",
  );
  form.set("fileName", "secret.pdf");
  form.set("mimeType", "application/pdf");
  form.set("originalSizeBytes", "123");
  form.set("encryptedFileSha256", sha256Hex(encrypted));
  form.set("encryptionIv", randomBytes(12).toString("base64"));
  form.set("fileKey", randomBytes(32).toString("base64"));
  form.set("amountZats", "5000000");
  form.set("sellerPayoutAddress", testSellerPayoutAddress());
  form.set("sellerNote", "private delivery");
  form.set(
    "timestampReceiptJson",
    JSON.stringify({
      commitment_scheme: "zectime-poseidon-pallas-v2",
      commitment: "aa".repeat(32),
      block_height: 0,
      nonce: "bb".repeat(16),
      doc_hash_lo: "cc".repeat(16),
      doc_hash_hi: "dd".repeat(16),
      doc_hash_sha256: "ee".repeat(32),
    }),
  );

  return new Request("http://localhost/api/transfers", {
    method: "POST",
    body: form,
  });
}

async function createBuyerKeyPair(): Promise<{
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}> {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  return {
    publicJwk: await webcrypto.subtle.exportKey("jwk", pair.publicKey),
    privateJwk: await webcrypto.subtle.exportKey("jwk", pair.privateKey),
  };
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

function encryptedFixture(): Uint8Array {
  return new Uint8Array([10, 20, 30, 40, 50, 60]);
}

function testSellerPayoutAddress(): string {
  return "u1sellerpayoutaddress000000000000000000000000000000000";
}

function testBuyerNymAddress(): string {
  return "nym1buyerprivateaddress000000000000000000000000000000";
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
