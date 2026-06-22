import { createHash, randomBytes, webcrypto } from "node:crypto";
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
import { WebSocketServer } from "ws";

import { POST as createTransferRoute } from "../app/api/transfers/route";
import { POST as createSellerRoute } from "../app/api/sellers/route";
import {
  GET as readSellerSessionRoute,
  POST as loginSellerRoute,
} from "../app/api/seller-session/route";
import { GET as readTransferRoute } from "../app/api/transfers/[orderId]/route";
import { POST as claimTransferRoute } from "../app/api/transfers/[orderId]/claim/route";
import { POST as deliveredTransferRoute } from "../app/api/transfers/[orderId]/delivered/route";
import { POST as devPayRoute } from "../app/api/transfers/[orderId]/dev-pay/route";
import { GET as fileRoute } from "../app/api/transfers/[orderId]/file/route";
import { POST as nymSessionRoute } from "../app/api/transfers/[orderId]/nym-session/route";
import { POST as paymentIntentRoute } from "../app/api/transfers/[orderId]/payment-intent/route";
import { POST as cipherPayWebhookRoute } from "../app/api/webhooks/cipherpay/route";
import { POST as keyReleaseRoute } from "../app/api/transfers/[orderId]/key-release/route";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";
import {
  createPaidLinkSellerReleaseDraft,
  wrapPaidLinkFileKeyForBuyer,
  type PaidLinkKeyEnvelope,
} from "../lib/paid-link-client-crypto";

interface TransferPublicOrder {
  orderId: string;
  status: string;
  sellerPayoutAddress: string;
  seller: { handle: string; displayName: string } | null;
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
let releaseDraft: {
  releaseSecret: string;
  releaseSecretHash: string;
  fileKey: string;
};

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
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-test-"));
  releaseDraft = await createPaidLinkSellerReleaseDraft(
    randomBytes(32).toString("base64"),
  );
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET =
    "test-transfer-token-secret";
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  delete process.env.CIPHERPAY_API_URL;
  delete process.env.CIPHERPAY_API_KEY;
  delete process.env.NYM_CLIENT_ENDPOINT;
  delete process.env.NYM_CLIENT_TIMEOUT_MS;
  delete process.env.PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY;
  resetRateLimitStateForTesting();
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET;
  delete process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS;
  delete process.env.NYM_CLIENT_ENDPOINT;
  delete process.env.NYM_CLIENT_TIMEOUT_MS;
  delete process.env.PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY;
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
      new Request(`http://localhost/api/transfers/${createBody.order.orderId}`),
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
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/nym-session`,
        {
          buyerNymAddress: testBuyerNymAddress(),
          buyerPublicKeyJwk: keyPair.publicJwk,
          transport: "nym-claim-v1",
        },
      ),
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
      new Request(`http://localhost/api/transfers/${order.orderId}/dev-pay`, {
        method: "POST",
      }),
      routeContext(order.orderId),
    );
    expect(paidResponse.status).toBe(200);

    await releaseKeyForOrder(order.orderId);

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

  it("marks the Nym session delivered via the status-only delivery ack", async () => {
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();

    await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    await nymSessionRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/nym-session`,
        {
          buyerNymAddress: testBuyerNymAddress(),
          buyerPublicKeyJwk: keyPair.publicJwk,
          transport: "nym-claim-v1",
        },
      ),
      routeContext(order.orderId),
    );
    await devPayRoute(
      new Request(`http://localhost/api/transfers/${order.orderId}/dev-pay`, {
        method: "POST",
      }),
      routeContext(order.orderId),
    );
    await releaseKeyForOrder(order.orderId);
    await claimTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${order.orderId}/claim`, {
        buyerPublicKeyJwk: keyPair.publicJwk,
      }),
      routeContext(order.orderId),
    );

    const deliveredResponse = await deliveredTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${order.orderId}/delivered`, {
        buyerPublicKeyJwk: keyPair.publicJwk,
      }),
      routeContext(order.orderId),
    );
    expect(deliveredResponse.status).toBe(200);
    const deliveredBody = (await deliveredResponse.json()) as {
      order: TransferPublicOrder & {
        delivery: {
          nymSession: {
            status: string;
            lastDelivery?: { status?: string } | null;
          } | null;
        };
      };
    };
    expect(deliveredBody.order.delivery.nymSession?.status).toBe("delivered");
    expect(deliveredBody.order.delivery.nymSession?.lastDelivery?.status).toBe(
      "delivered",
    );
    // Pure-Nym invariant: the ack carries no key material in or out.
    expect(JSON.stringify(deliveredBody)).not.toContain("keyEnvelope");
    expect(JSON.stringify(deliveredBody)).not.toContain("ciphertext");
  });

  it("rejects a delivery ack from a buyer key not bound to the payment", async () => {
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();
    const otherKeyPair = await createBuyerKeyPair();

    await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    await nymSessionRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/nym-session`,
        {
          buyerNymAddress: testBuyerNymAddress(),
          buyerPublicKeyJwk: keyPair.publicJwk,
          transport: "nym-claim-v1",
        },
      ),
      routeContext(order.orderId),
    );
    await devPayRoute(
      new Request(`http://localhost/api/transfers/${order.orderId}/dev-pay`, {
        method: "POST",
      }),
      routeContext(order.orderId),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rejected = await deliveredTransferRoute(
        jsonRequest(
          `http://localhost/api/transfers/${order.orderId}/delivered`,
          {
            buyerPublicKeyJwk: otherKeyPair.publicJwk,
          },
        ),
        routeContext(order.orderId),
      );
      expect(rejected.status).toBe(402);
      const body = (await rejected.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("payment_required");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("records the delivery path (via) on the delivery ack", async () => {
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();

    await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    await nymSessionRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/nym-session`,
        {
          buyerNymAddress: testBuyerNymAddress(),
          buyerPublicKeyJwk: keyPair.publicJwk,
          transport: "nym-claim-v1",
        },
      ),
      routeContext(order.orderId),
    );
    await devPayRoute(
      new Request(`http://localhost/api/transfers/${order.orderId}/dev-pay`, {
        method: "POST",
      }),
      routeContext(order.orderId),
    );
    await releaseKeyForOrder(order.orderId);
    await claimTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${order.orderId}/claim`, {
        buyerPublicKeyJwk: keyPair.publicJwk,
      }),
      routeContext(order.orderId),
    );

    const deliveredResponse = await deliveredTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${order.orderId}/delivered`, {
        buyerPublicKeyJwk: keyPair.publicJwk,
        via: "https",
      }),
      routeContext(order.orderId),
    );
    expect(deliveredResponse.status).toBe(200);
    const deliveredBody = (await deliveredResponse.json()) as {
      order: TransferPublicOrder & {
        delivery: {
          nymSession: {
            status: string;
            deliveredVia?: string | null;
          } | null;
        };
      };
    };
    expect(deliveredBody.order.delivery.nymSession?.status).toBe("delivered");
    expect(deliveredBody.order.delivery.nymSession?.deliveredVia).toBe("https");
  });

  it("defaults the delivery path to null when via is omitted", async () => {
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();

    await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    await nymSessionRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/nym-session`,
        {
          buyerNymAddress: testBuyerNymAddress(),
          buyerPublicKeyJwk: keyPair.publicJwk,
          transport: "nym-claim-v1",
        },
      ),
      routeContext(order.orderId),
    );
    await devPayRoute(
      new Request(`http://localhost/api/transfers/${order.orderId}/dev-pay`, {
        method: "POST",
      }),
      routeContext(order.orderId),
    );
    await releaseKeyForOrder(order.orderId);
    await claimTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${order.orderId}/claim`, {
        buyerPublicKeyJwk: keyPair.publicJwk,
      }),
      routeContext(order.orderId),
    );

    const deliveredResponse = await deliveredTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${order.orderId}/delivered`, {
        buyerPublicKeyJwk: keyPair.publicJwk,
      }),
      routeContext(order.orderId),
    );
    expect(deliveredResponse.status).toBe(200);
    const deliveredBody = (await deliveredResponse.json()) as {
      order: {
        delivery: { nymSession: { deliveredVia?: string | null } | null };
      };
    };
    expect(deliveredBody.order.delivery.nymSession?.deliveredVia).toBeNull();
  });

  it("rejects an invalid delivery path (via)", async () => {
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();

    await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    await nymSessionRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/nym-session`,
        {
          buyerNymAddress: testBuyerNymAddress(),
          buyerPublicKeyJwk: keyPair.publicJwk,
          transport: "nym-claim-v1",
        },
      ),
      routeContext(order.orderId),
    );
    await devPayRoute(
      new Request(`http://localhost/api/transfers/${order.orderId}/dev-pay`, {
        method: "POST",
      }),
      routeContext(order.orderId),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rejected = await deliveredTransferRoute(
        jsonRequest(
          `http://localhost/api/transfers/${order.orderId}/delivered`,
          {
            buyerPublicKeyJwk: keyPair.publicJwk,
            via: "carrier-pigeon",
          },
        ),
        routeContext(order.orderId),
      );
      expect(rejected.status).toBe(400);
      const body = (await rejected.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("validation");
    } finally {
      consoleSpy.mockRestore();
    }
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
      new Request(`http://localhost/api/transfers/${order.orderId}/dev-pay`, {
        method: "POST",
      }),
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

  it("sends a strict claim payload through the standalone Nym websocket client", async () => {
    const nymClient = new WebSocketServer({ port: 0 });
    await once(nymClient, "listening");
    const address = nymClient.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Test websocket server did not bind to a TCP port");
    }

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      nymClient.once("connection", (socket) => {
        socket.once("message", (data) => {
          try {
            resolve(JSON.parse(data.toString()) as Record<string, unknown>);
          } catch (error) {
            reject(error);
          }
        });
      });
      nymClient.once("error", reject);
    });

    process.env.NYM_CLIENT_ENDPOINT = `ws://127.0.0.1:${address.port}`;
    process.env.NYM_CLIENT_TIMEOUT_MS = "2000";
    process.env.PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY = "1";

    try {
      const order = await createOrder();
      const keyPair = await createBuyerKeyPair();
      await paymentIntentRoute(
        jsonRequest(
          `http://localhost/api/transfers/${order.orderId}/payment-intent`,
          { buyerPublicKeyJwk: keyPair.publicJwk },
        ),
        routeContext(order.orderId),
      );
      await nymSessionRoute(
        jsonRequest(
          `http://localhost/api/transfers/${order.orderId}/nym-session`,
          {
            buyerNymAddress: testBuyerNymAddress(),
            buyerPublicKeyJwk: keyPair.publicJwk,
            transport: "nym-claim-v1",
          },
        ),
        routeContext(order.orderId),
      );
      await devPayRoute(
        new Request(`http://localhost/api/transfers/${order.orderId}/dev-pay`, {
          method: "POST",
        }),
        routeContext(order.orderId),
      );

      await releaseKeyForOrder(order.orderId);

      const claimResponse = await claimTransferRoute(
        jsonRequest(`http://localhost/api/transfers/${order.orderId}/claim`, {
          buyerPublicKeyJwk: keyPair.publicJwk,
        }),
        routeContext(order.orderId),
      );
      expect(claimResponse.status).toBe(200);
      const claimBody = (await claimResponse.json()) as {
        deliveryMode: string;
        keyEnvelope?: unknown;
        download?: unknown;
        nymDelivery: { status: string };
      };
      expect(claimBody.deliveryMode).toBe("nym");
      expect(claimBody.keyEnvelope).toBeUndefined();
      expect(claimBody.download).toBeUndefined();
      expect(claimBody.nymDelivery.status).toBe("sent_nym_client");

      const wireMessage = await received;
      expect(wireMessage.type).toBe("send");
      expect(wireMessage.recipient).toBe(testBuyerNymAddress());
      expect(typeof wireMessage.message).toBe("string");
      const payload = JSON.parse(wireMessage.message as string) as {
        schema: string;
        orderId: string;
        keyEnvelope: { scheme: string };
        encryptedFileDownload: { url: string };
      };
      expect(payload.schema).toBe("paidprivatefile.nym.claim.v1");
      expect(payload.orderId).toBe(order.orderId);
      expect(payload.keyEnvelope.scheme).toBe("p256-ecdh-aes-gcm-v1");
      expect(payload.encryptedFileDownload.url).toContain(
        `/api/transfers/${order.orderId}/file?token=`,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        nymClient.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("fails mandatory Nym delivery when no real Nym client endpoint is configured", async () => {
    process.env.PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY = "1";
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();
    await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    await nymSessionRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/nym-session`,
        {
          buyerNymAddress: testBuyerNymAddress(),
          buyerPublicKeyJwk: keyPair.publicJwk,
          transport: "nym-claim-v1",
        },
      ),
      routeContext(order.orderId),
    );
    await devPayRoute(
      new Request(`http://localhost/api/transfers/${order.orderId}/dev-pay`, {
        method: "POST",
      }),
      routeContext(order.orderId),
    );

    await releaseKeyForOrder(order.orderId);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const claimResponse = await claimTransferRoute(
        jsonRequest(`http://localhost/api/transfers/${order.orderId}/claim`, {
          buyerPublicKeyJwk: keyPair.publicJwk,
        }),
        routeContext(order.orderId),
      );
      expect(claimResponse.status).toBe(503);
      const body = (await claimResponse.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("cli_unavailable");
      expect(body.error.message).toContain("NYM_CLIENT_ENDPOINT");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("creates a no-email seller login and publishes paid files under the seller route", async () => {
    const sellerResponse = await createSellerRoute(
      jsonRequest("http://localhost/api/sellers", {
        handle: "alice-files",
        displayName: "Alice Files",
        defaultPayoutAddress: testSellerPayoutAddress(),
      }),
    );
    expect(sellerResponse.status).toBe(201);
    const sellerCookie = sellerResponse.headers.get("set-cookie");
    expect(sellerCookie).toContain("paidprivatefile_seller=");
    const sellerBody = (await sellerResponse.json()) as {
      seller: {
        handle: string;
        displayName: string;
        defaultPayoutAddress: string;
        publicPath: string;
      };
      accessKey: string;
    };
    expect(sellerBody.seller.handle).toBe("alice-files");
    expect(sellerBody.seller.publicPath).toBe("/s/alice-files");
    expect(sellerBody.accessKey).toMatch(/^ppf_/u);

    const sessionResponse = await readSellerSessionRoute(
      new Request("http://localhost/api/seller-session", {
        headers: { Cookie: sellerCookie ?? "" },
      }),
    );
    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      seller: { handle: string } | null;
    };
    expect(sessionBody.seller?.handle).toBe("alice-files");

    const loginResponse = await loginSellerRoute(
      jsonRequest("http://localhost/api/seller-session", {
        handle: "alice-files",
        accessKey: sellerBody.accessKey,
      }),
    );
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.get("set-cookie")).toContain(
      "paidprivatefile_seller=",
    );

    const createResponse = await createTransferRoute(
      makeCreateRequest({ Cookie: sellerCookie ?? "" }),
    );
    expect(createResponse.status).toBe(200);
    const createBody = (await createResponse.json()) as {
      order: TransferPublicOrder;
      sharePath: string;
    };
    expect(createBody.order.seller?.handle).toBe("alice-files");
    expect(createBody.order.sellerPayoutAddress).toBe(
      testSellerPayoutAddress(),
    );
    expect(createBody.sharePath).toBe(
      `/s/alice-files/files/${createBody.order.orderId}`,
    );
  });
});

function once(target: WebSocketServer, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.once(event, () => resolve());
    target.once("error", reject);
  });
}

async function createOrder(): Promise<TransferPublicOrder> {
  const response = await createTransferRoute(makeCreateRequest());
  const body = (await response.json()) as { order: TransferPublicOrder };
  return body.order;
}

function makeCreateRequest(headers?: HeadersInit): Request {
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
  form.set("releaseSecretHash", releaseDraft.releaseSecretHash);
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
    headers,
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

async function releaseKeyForOrder(orderId: string): Promise<void> {
  const statusResponse = await keyReleaseRoute(
    jsonRequest(`http://localhost/api/transfers/${orderId}/key-release`, {
      releaseSecret: releaseDraft.releaseSecret,
    }),
    routeContext(orderId),
  );
  if (statusResponse.status !== 200) {
    throw new Error(`key-release status failed: ${statusResponse.status}`);
  }
  const challenge = (await statusResponse.json()) as {
    release: { status: string; buyerPublicKeyJwk: JsonWebKey | null };
  };
  if (challenge.release.status !== "ready_to_release") {
    throw new Error(`order not ready to release: ${challenge.release.status}`);
  }
  const keyEnvelope: PaidLinkKeyEnvelope = await wrapPaidLinkFileKeyForBuyer(
    releaseDraft.fileKey,
    challenge.release.buyerPublicKeyJwk as JsonWebKey,
  );
  const releaseResponse = await keyReleaseRoute(
    jsonRequest(`http://localhost/api/transfers/${orderId}/key-release`, {
      action: "release",
      releaseSecret: releaseDraft.releaseSecret,
      keyEnvelope,
    }),
    routeContext(orderId),
  );
  if (releaseResponse.status !== 200) {
    throw new Error(`key-release action failed: ${releaseResponse.status}`);
  }
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
