import { createHash, createHmac, randomBytes, webcrypto } from "node:crypto";
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
import { POST as paymentIntentRoute } from "../app/api/transfers/[orderId]/payment-intent/route";
import { POST as poolRoute } from "../app/api/transfers/payments/zcash/addresses/route";
import { POST as watchlistRoute } from "../app/api/transfers/payments/zcash/watchlist/route";
import { POST as zcashWebhookRoute } from "../app/api/webhooks/zcash/route";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";
import { createPaidLinkSellerReleaseDraft } from "../lib/paid-link-client-crypto";

interface TransferPublicOrder {
  orderId: string;
  status: string;
  payment: {
    provider: string;
    paymentAddress: string | null;
    receivingAddress?: string | null;
    status: string;
  } | null;
}

interface ErrorEnvelope {
  error: { kind: string; message: string };
}

const POOL_SECRET = "test-zcash-pool-secret";
const WEBHOOK_SECRET = "test-zcash-webhook-secret";

const DEPOSIT_ADDRESSES = [
  "u1depositaddr0000000000000000000000000000000000000000",
  "u1depositaddr1111111111111111111111111111111111111111",
  "u1depositaddr2222222222222222222222222222222222222222",
];

let runtimeDir: string;
let releaseDraft: {
  releaseSecret: string;
  releaseSecretHash: string;
  fileKey: string;
};

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
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-onchain-"));
  releaseDraft = await createPaidLinkSellerReleaseDraft(
    randomBytes(32).toString("base64"),
  );
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET =
    "test-transfer-token-secret";
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN = "1";
  process.env.PAID_PRIVATE_FILE_ZCASH_POOL_SECRET = POOL_SECRET;
  process.env.PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.PAID_PRIVATE_FILE_ZCASH_MIN_CONFIRMATIONS = "10";
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
  delete process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN;
  delete process.env.PAID_PRIVATE_FILE_ZCASH_POOL_SECRET;
  delete process.env.PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET;
  delete process.env.PAID_PRIVATE_FILE_ZCASH_MIN_CONFIRMATIONS;
  await rm(runtimeDir, { recursive: true, force: true });
});

describe("zcash deposit-address pool route", () => {
  it("rejects a missing signature", async () => {
    const body = JSON.stringify({ addresses: DEPOSIT_ADDRESSES });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await poolRoute(
        new Request("http://localhost/api/transfers/payments/zcash/addresses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      );
      expect(response.status).toBe(400);
      const parsed = (await response.json()) as ErrorEnvelope;
      expect(parsed.error.kind).toBe("validation");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects an invalid signature", async () => {
    const body = JSON.stringify({ addresses: DEPOSIT_ADDRESSES });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await poolRoute(signedPoolRequest(body, "deadbeef"));
      expect(response.status).toBe(400);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("registers addresses with a valid signature", async () => {
    const body = JSON.stringify({ addresses: DEPOSIT_ADDRESSES });
    const response = await poolRoute(signedPoolRequest(body));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as { added: number; total: number };
    expect(parsed.added).toBe(DEPOSIT_ADDRESSES.length);
    expect(parsed.total).toBe(DEPOSIT_ADDRESSES.length);
  });

  it("rejects when the pool secret is unset", async () => {
    delete process.env.PAID_PRIVATE_FILE_ZCASH_POOL_SECRET;
    const body = JSON.stringify({ addresses: DEPOSIT_ADDRESSES });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await poolRoute(signedPoolRequest(body, "deadbeef"));
      expect(response.status).toBe(400);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("zcash deposit-address watchlist route", () => {
  it("rejects a missing signature", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await watchlistRoute(
        new Request("http://localhost/api/transfers/payments/zcash/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(400);
      const parsed = (await response.json()) as ErrorEnvelope;
      expect(parsed.error.kind).toBe("validation");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects an invalid signature", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await watchlistRoute(
        signedWatchlistRequest("{}", "deadbeef"),
      );
      expect(response.status).toBe(400);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects when the pool secret is unset", async () => {
    delete process.env.PAID_PRIVATE_FILE_ZCASH_POOL_SECRET;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await watchlistRoute(
        signedWatchlistRequest("{}", "deadbeef"),
      );
      expect(response.status).toBe(400);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("returns the deposit addresses assigned to orders", async () => {
    await seedPool();
    const { receivingAddress } = await orderWithDeposit();

    const response = await watchlistRoute(signedWatchlistRequest("{}"));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as { addresses: string[] };
    expect(Array.isArray(parsed.addresses)).toBe(true);
    expect(parsed.addresses).toContain(receivingAddress);
  });

  it("returns an empty list when no orders are assigned", async () => {
    await seedPool();
    const response = await watchlistRoute(signedWatchlistRequest("{}"));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as { addresses: string[] };
    expect(parsed.addresses).toEqual([]);
  });
});

describe("payment intent with zcash-onchain flag", () => {
  it("assigns a deposit address and persists it as the receiving address", async () => {
    await seedPool();
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();

    const response = await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      order: TransferPublicOrder;
      payment: { provider: string; paymentAddress: string };
    };
    expect(parsed.payment.provider).toBe("zcash-onchain");
    expect(DEPOSIT_ADDRESSES).toContain(parsed.payment.paymentAddress);
    expect(parsed.order.status).toBe("payment_pending");
    expect(parsed.order.payment?.receivingAddress).toBe(
      parsed.payment.paymentAddress,
    );

    const raw = await readOrderJson(order.orderId);
    expect(raw).toContain(parsed.payment.paymentAddress);
  });

  it("gives two different orders different deposit addresses", async () => {
    await seedPool();
    const first = await paymentAddressFor(await createOrder());
    const second = await paymentAddressFor(await createOrder());
    expect(first).not.toBe(second);
  });

  it("returns a clear error when the pool is empty", async () => {
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await paymentIntentRoute(
        jsonRequest(
          `http://localhost/api/transfers/${order.orderId}/payment-intent`,
          { buyerPublicKeyJwk: keyPair.publicJwk },
        ),
        routeContext(order.orderId),
      );
      expect(response.status).not.toBe(200);
      const parsed = (await response.json()) as ErrorEnvelope;
      expect(parsed.error.message).toMatch(/deposit address/iu);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("keeps the dev provider when the flag is off (regression)", async () => {
    delete process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN;
    const order = await createOrder();
    const keyPair = await createBuyerKeyPair();
    const response = await paymentIntentRoute(
      jsonRequest(
        `http://localhost/api/transfers/${order.orderId}/payment-intent`,
        { buyerPublicKeyJwk: keyPair.publicJwk },
      ),
      routeContext(order.orderId),
    );
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      payment: { provider: string };
    };
    expect(parsed.payment.provider).toBe("dev");
  });
});

describe("zcash payment webhook", () => {
  it("marks the order paid for a confirmed, fully-paid deposit", async () => {
    await seedPool();
    const { orderId, receivingAddress } = await orderWithDeposit();

    const body = JSON.stringify({
      receivingAddress,
      amountZats: 5_000_000,
      txid: "a".repeat(64),
      confirmations: 12,
    });
    const response = await zcashWebhookRoute(signedWebhookRequest(body));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      ok: boolean;
      order?: TransferPublicOrder;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.order?.status).toBe("paid");

    const raw = await readOrderJson(orderId);
    const stored = JSON.parse(raw) as {
      status: string;
      payment: { status: string; onchain: { txid: string } | null };
    };
    expect(stored.status).toBe("paid");
    expect(stored.payment.onchain?.txid).toBe("a".repeat(64));
  });

  it("rejects a bad signature", async () => {
    await seedPool();
    const { receivingAddress } = await orderWithDeposit();
    const body = JSON.stringify({
      receivingAddress,
      amountZats: 5_000_000,
      txid: "a".repeat(64),
      confirmations: 12,
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await zcashWebhookRoute(
        signedWebhookRequest(body, "deadbeef"),
      );
      expect(response.status).toBe(400);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects an unknown receiving address", async () => {
    const body = JSON.stringify({
      receivingAddress:
        "u1unknownaddress00000000000000000000000000000000000000",
      amountZats: 5_000_000,
      txid: "a".repeat(64),
      confirmations: 12,
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await zcashWebhookRoute(signedWebhookRequest(body));
      expect(response.status).not.toBe(200);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("does not mark paid on underpayment", async () => {
    await seedPool();
    const { orderId, receivingAddress } = await orderWithDeposit();
    const body = JSON.stringify({
      receivingAddress,
      amountZats: 100,
      txid: "a".repeat(64),
      confirmations: 12,
    });
    const response = await zcashWebhookRoute(signedWebhookRequest(body));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      ok: boolean;
      ignored?: boolean;
    };
    expect(parsed.ignored).toBe(true);

    const stored = JSON.parse(await readOrderJson(orderId)) as {
      status: string;
    };
    expect(stored.status).toBe("payment_pending");
  });

  it("does not mark paid when confirmations are below the minimum (retryable)", async () => {
    await seedPool();
    const { orderId, receivingAddress } = await orderWithDeposit();
    const body = JSON.stringify({
      receivingAddress,
      amountZats: 5_000_000,
      txid: "a".repeat(64),
      confirmations: 2,
    });
    const response = await zcashWebhookRoute(signedWebhookRequest(body));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      ok: boolean;
      ignored?: boolean;
    };
    expect(parsed.ignored).toBe(true);

    const stored = JSON.parse(await readOrderJson(orderId)) as {
      status: string;
    };
    expect(stored.status).toBe("payment_pending");

    // Once confirmations climb above the minimum, the same report marks it paid.
    const confirmed = JSON.stringify({
      receivingAddress,
      amountZats: 5_000_000,
      txid: "a".repeat(64),
      confirmations: 12,
    });
    const confirmedResponse = await zcashWebhookRoute(
      signedWebhookRequest(confirmed),
    );
    expect(confirmedResponse.status).toBe(200);
    const confirmedStored = JSON.parse(await readOrderJson(orderId)) as {
      status: string;
    };
    expect(confirmedStored.status).toBe("paid");
  });

  it("is idempotent when the same txid is replayed after paid", async () => {
    await seedPool();
    const { orderId, receivingAddress } = await orderWithDeposit();
    const body = JSON.stringify({
      receivingAddress,
      amountZats: 5_000_000,
      txid: "a".repeat(64),
      confirmations: 12,
    });
    const first = await zcashWebhookRoute(signedWebhookRequest(body));
    expect(first.status).toBe(200);

    const replay = await zcashWebhookRoute(signedWebhookRequest(body));
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      ok: boolean;
      order?: TransferPublicOrder;
    };
    expect(replayBody.ok).toBe(true);

    const stored = JSON.parse(await readOrderJson(orderId)) as {
      status: string;
      payment: { onchain: { txid: string } };
    };
    expect(stored.status).toBe("paid");
    expect(stored.payment.onchain.txid).toBe("a".repeat(64));
  });

  it("rejects when the webhook secret is unset", async () => {
    delete process.env.PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET;
    const body = JSON.stringify({
      receivingAddress: DEPOSIT_ADDRESSES[0],
      amountZats: 5_000_000,
      txid: "a".repeat(64),
      confirmations: 12,
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await zcashWebhookRoute(
        signedWebhookRequest(body, "deadbeef"),
      );
      expect(response.status).toBe(400);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

async function seedPool(): Promise<void> {
  const body = JSON.stringify({ addresses: DEPOSIT_ADDRESSES });
  const response = await poolRoute(signedPoolRequest(body));
  if (response.status !== 200) {
    throw new Error(`pool seed failed: ${response.status}`);
  }
}

async function orderWithDeposit(): Promise<{
  orderId: string;
  receivingAddress: string;
}> {
  const order = await createOrder();
  const keyPair = await createBuyerKeyPair();
  const response = await paymentIntentRoute(
    jsonRequest(
      `http://localhost/api/transfers/${order.orderId}/payment-intent`,
      { buyerPublicKeyJwk: keyPair.publicJwk },
    ),
    routeContext(order.orderId),
  );
  const parsed = (await response.json()) as {
    payment: { paymentAddress: string };
  };
  return {
    orderId: order.orderId,
    receivingAddress: parsed.payment.paymentAddress,
  };
}

async function paymentAddressFor(order: TransferPublicOrder): Promise<string> {
  const keyPair = await createBuyerKeyPair();
  const response = await paymentIntentRoute(
    jsonRequest(
      `http://localhost/api/transfers/${order.orderId}/payment-intent`,
      { buyerPublicKeyJwk: keyPair.publicJwk },
    ),
    routeContext(order.orderId),
  );
  const parsed = (await response.json()) as {
    payment: { paymentAddress: string };
  };
  return parsed.payment.paymentAddress;
}

function signedPoolRequest(body: string, signature?: string): Request {
  const sig = signature ?? hmacHex(POOL_SECRET, body);
  return new Request(
    "http://localhost/api/transfers/payments/zcash/addresses",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-zcash-signature": `sha256=${sig}`,
      },
      body,
    },
  );
}

function signedWatchlistRequest(body: string, signature?: string): Request {
  const sig = signature ?? hmacHex(POOL_SECRET, body);
  return new Request(
    "http://localhost/api/transfers/payments/zcash/watchlist",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-zcash-signature": `sha256=${sig}`,
      },
      body,
    },
  );
}

function signedWebhookRequest(body: string, signature?: string): Request {
  const sig = signature ?? hmacHex(WEBHOOK_SECRET, body);
  return new Request("http://localhost/api/webhooks/zcash", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-zcash-signature": sig,
    },
    body,
  });
}

function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

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
  form.set("releaseSecretHash", releaseDraft.releaseSecretHash);
  form.set("amountZats", "5000000");
  form.set("sellerPayoutAddress", testSellerPayoutAddress());
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

function encryptedFixture(): Uint8Array {
  return new Uint8Array([10, 20, 30, 40, 50, 60]);
}

function testSellerPayoutAddress(): string {
  return "u1sellerpayoutaddress000000000000000000000000000000000";
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
