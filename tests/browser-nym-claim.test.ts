// Frente B: browser-direct Nym key delivery.
// When PAID_PRIVATE_FILE_BROWSER_NYM_DELIVERY=1 the server stops sending the
// key envelope over Nym (no server nym-client). The claim marks the order
// claimed, returns deliveryMode "browser-nym" plus the signed ciphertext
// download URL, and DOES NOT include the keyEnvelope (the seller browser
// delivers it over the mixnet). The release challenge surfaces the buyer Nym
// address so the seller knows where to send.

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
import { POST as keyReleaseRoute } from "../app/api/transfers/[orderId]/key-release/route";
import { POST as nymSessionRoute } from "../app/api/transfers/[orderId]/nym-session/route";
import { POST as paymentIntentRoute } from "../app/api/transfers/[orderId]/payment-intent/route";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";
import {
  createPaidLinkBuyerKeyPair,
  createPaidLinkSellerReleaseDraft,
  encryptPaidLinkFile,
  wrapPaidLinkFileKeyForBuyer,
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
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-browsernym-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET =
    "test-transfer-token-secret";
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  process.env.PAID_PRIVATE_FILE_BROWSER_NYM_DELIVERY = "1";
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
  delete process.env.PAID_PRIVATE_FILE_BROWSER_NYM_DELIVERY;
  await rm(runtimeDir, { recursive: true, force: true });
});

interface ClaimBody {
  order: { status: string };
  deliveryMode: string;
  keyEnvelope?: unknown;
  download?: { url: string };
}

interface ErrorEnvelope {
  error: { kind: string; message: string };
}

describe("browser-direct Nym claim", () => {
  it("returns deliveryMode browser-nym with a download URL and no keyEnvelope", async () => {
    const { orderId } = await createReleasedOrder();
    const buyer = orderId.buyer;

    const claimResponse = await claimTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId.id}/claim`, {
        buyerPublicKeyJwk: buyer.publicJwk,
      }),
      routeContext(orderId.id),
    );
    expect(claimResponse.status).toBe(200);
    const claimBody = (await claimResponse.json()) as ClaimBody;

    // The key transits the mixnet browser-to-browser; the server never relays it.
    expect(claimBody.deliveryMode).toBe("browser-nym");
    expect(claimBody.keyEnvelope).toBeUndefined();
    // The buyer still needs the signed ciphertext URL to fetch the file.
    expect(typeof claimBody.download?.url).toBe("string");
    expect(claimBody.download?.url).toContain(
      `/api/transfers/${orderId.id}/file?token=`,
    );
    expect(claimBody.order.status).toBe("claimed");
  });

  it("still requires confirmed payment and a registered Nym session", async () => {
    // Order created but no nym-session: claim must be blocked even in browser mode.
    const draft = await makeReleaseDraft();
    const orderId = await createOrder(draft);
    const buyer = await createPaidLinkBuyerKeyPair();

    await paymentIntentRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId}/payment-intent`, {
        buyerPublicKeyJwk: buyer.publicJwk,
      }),
      routeContext(orderId),
    );
    await devPayRoute(
      new Request(`http://localhost/api/transfers/${orderId}/dev-pay`, {
        method: "POST",
      }),
      routeContext(orderId),
    );
    await releaseKey(orderId, draft, buyer.publicJwk);

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
      expect(body.error.message).toContain("Nym delivery session");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("does not attempt a server-side Nym send even when mandatory delivery is configured", async () => {
    // Browser-nym mode must not call queueNymDelivery at all. Turning on the
    // mandatory-delivery guard (which throws without a NYM_CLIENT_ENDPOINT)
    // proves the server send path is fully bypassed.
    process.env.PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY = "1";

    const { orderId } = await createReleasedOrder();
    const buyer = orderId.buyer;
    const claimResponse = await claimTransferRoute(
      jsonRequest(`http://localhost/api/transfers/${orderId.id}/claim`, {
        buyerPublicKeyJwk: buyer.publicJwk,
      }),
      routeContext(orderId.id),
    );
    expect(claimResponse.status).toBe(200);
    const claimBody = (await claimResponse.json()) as ClaimBody;
    expect(claimBody.deliveryMode).toBe("browser-nym");
    expect(claimBody.keyEnvelope).toBeUndefined();
    expect(typeof claimBody.download?.url).toBe("string");
  });
});

type ReleaseDraft = Awaited<
  ReturnType<typeof createPaidLinkSellerReleaseDraft>
> & { encryptedFile: Blob; encryptedFileSha256: string; encryptionIv: string };

async function makeReleaseDraft(): Promise<ReleaseDraft> {
  const plaintext = new TextEncoder().encode("browser nym secret payload");
  const encryption = await encryptPaidLinkFile(
    new File([plaintext], "secret.pdf", { type: "application/pdf" }),
  );
  const release = await createPaidLinkSellerReleaseDraft(encryption.fileKey);
  return {
    ...release,
    encryptedFile: encryption.encryptedFile,
    encryptedFileSha256: encryption.encryptedFileSha256,
    encryptionIv: encryption.encryptionIv,
  };
}

async function createOrder(draft: ReleaseDraft): Promise<string> {
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

  const response = await createTransferRoute(
    new Request("http://localhost/api/transfers", {
      method: "POST",
      body: form,
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { order: { orderId: string } };
  return body.order.orderId;
}

async function releaseKey(
  orderId: string,
  draft: ReleaseDraft,
  buyerPublicKeyJwk: JsonWebKey,
): Promise<void> {
  const keyEnvelope = await wrapPaidLinkFileKeyForBuyer(
    draft.fileKey,
    buyerPublicKeyJwk,
  );
  const response = await keyReleaseRoute(
    jsonRequest(`http://localhost/api/transfers/${orderId}/key-release`, {
      action: "release",
      releaseSecret: draft.releaseSecret,
      keyEnvelope,
    }),
    routeContext(orderId),
  );
  expect(response.status).toBe(200);
}

async function createReleasedOrder(): Promise<{
  orderId: {
    id: string;
    buyer: Awaited<ReturnType<typeof createPaidLinkBuyerKeyPair>>;
  };
}> {
  const draft = await makeReleaseDraft();
  const id = await createOrder(draft);
  const buyer = await createPaidLinkBuyerKeyPair();

  await paymentIntentRoute(
    jsonRequest(`http://localhost/api/transfers/${id}/payment-intent`, {
      buyerPublicKeyJwk: buyer.publicJwk,
    }),
    routeContext(id),
  );
  await nymSessionRoute(
    jsonRequest(`http://localhost/api/transfers/${id}/nym-session`, {
      buyerNymAddress: testBuyerNymAddress(),
      buyerPublicKeyJwk: buyer.publicJwk,
      transport: "nym-claim-v1",
    }),
    routeContext(id),
  );
  await devPayRoute(
    new Request(`http://localhost/api/transfers/${id}/dev-pay`, {
      method: "POST",
    }),
    routeContext(id),
  );
  await releaseKey(id, draft, buyer.publicJwk);

  return { orderId: { id, buyer } };
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
