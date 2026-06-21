import { createHash, createHmac, randomBytes, webcrypto } from "node:crypto";
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

import { createPaidLinkSellerReleaseDraft } from "../lib/paid-link-client-crypto";
import { POST as scanWatchlistRoute } from "../app/api/transfers/payments/zcash/scan-watchlist/route";
import { POST as zcashWebhookRoute } from "../app/api/webhooks/zcash/route";
import {
  setScannerClientForTesting,
  type ScannerClient,
} from "../lib/server/scanner-client";
import {
  createSellerProfile,
  registerSellerUfvk,
} from "../lib/server/seller-store";
import {
  createPaymentIntentForOrder,
  createTransferOrder,
  type TransferSeller,
} from "../lib/server/transfer-store";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";

const POOL_SECRET = "test-scan-pool-secret";
const WEBHOOK_SECRET = "test-scan-webhook-secret";
const SELLER_ADDRESS = "u1selleraddr0000000000000000000000000000000000";
const UFVK = "uview1watchlistkeyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FINGERPRINT = "c".repeat(64);
const SCAN_REF = `scan_${"d".repeat(24)}`;

let runtimeDir: string;
let releaseDraft: { releaseSecretHash: string };

interface ErrorEnvelope {
  error: { kind: string; message: string };
}

interface WatchlistEntry {
  orderId: string;
  sellerId: string;
  scanRef: string;
  address: string;
  diversifierIndex: number;
  startHeight: number;
  amountZats: number;
}

function fakeScanner(): ScannerClient {
  return {
    async validateUfvk() {
      return {
        valid: true,
        network: "main",
        fingerprint: FINGERPRINT,
        defaultAddress: SELLER_ADDRESS,
        receivers: ["orchard"],
        uaMatches: true,
      };
    },
    async registerUfvk() {
      return {
        scanRef: SCAN_REF,
        network: "main",
        fingerprint: FINGERPRINT,
        defaultAddress: SELLER_ADDRESS,
        receivers: ["orchard"],
        uaMatches: true,
      };
    },
    async deriveAddress(input) {
      return {
        address: `u1derived${input.diversifierIndex}00000000000000000000000`,
        actualIndex: input.diversifierIndex,
      };
    },
  };
}

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
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-watchlist-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_SELLER_UFVK_KEY =
    randomBytes(32).toString("hex");
  process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN = "1";
  process.env.PAID_PRIVATE_FILE_ZCASH_POOL_SECRET = POOL_SECRET;
  process.env.PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.PAID_PRIVATE_FILE_ZCASH_MIN_CONFIRMATIONS = "10";
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  releaseDraft = await createPaidLinkSellerReleaseDraft(
    randomBytes(32).toString("base64"),
  );
  setScannerClientForTesting(fakeScanner());
  resetRateLimitStateForTesting();
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_SELLER_UFVK_KEY;
  delete process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN;
  delete process.env.PAID_PRIVATE_FILE_ZCASH_POOL_SECRET;
  delete process.env.PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET;
  delete process.env.PAID_PRIVATE_FILE_ZCASH_MIN_CONFIRMATIONS;
  delete process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS;
  setScannerClientForTesting(null);
  await rm(runtimeDir, { recursive: true, force: true });
});

async function makeSeller(handle: string): Promise<TransferSeller> {
  const created = await createSellerProfile({
    handle,
    displayName: handle,
    defaultPayoutAddress: SELLER_ADDRESS,
  });
  await registerSellerUfvk(created.seller.sellerId, { ufvk: UFVK });
  return {
    sellerId: created.seller.sellerId,
    handle: created.seller.handle,
    displayName: created.seller.displayName,
  };
}

async function pendingUfvkOrder(handle: string): Promise<{
  orderId: string;
  sellerId: string;
  receivingAddress: string;
}> {
  const seller = await makeSeller(handle);
  const encrypted = new Uint8Array([1, 2, 3, 4]);
  const created = await createTransferOrder({
    encryptedFile: encrypted,
    fileName: "secret.pdf",
    mimeType: "application/pdf",
    originalSizeBytes: 100,
    encryptedFileSha256: createHash("sha256").update(encrypted).digest("hex"),
    encryptionIv: randomBytes(12).toString("base64"),
    releaseSecretHash: releaseDraft.releaseSecretHash,
    amountZats: 5_000_000,
    sellerPayoutAddress: SELLER_ADDRESS,
    seller,
  });
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  const intent = await createPaymentIntentForOrder(
    created.orderId,
    await webcrypto.subtle.exportKey("jwk", pair.publicKey),
  );
  return {
    orderId: created.orderId,
    sellerId: seller.sellerId,
    receivingAddress: intent.payment.receivingAddress as string,
  };
}

function signedWatchlistRequest(signature?: string): Request {
  const body = "{}";
  const sig =
    signature ?? createHmac("sha256", POOL_SECRET).update(body).digest("hex");
  return new Request(
    "http://localhost/api/transfers/payments/zcash/scan-watchlist",
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
  const sig =
    signature ??
    createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  return new Request("http://localhost/api/webhooks/zcash", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-zcash-signature": sig },
    body,
  });
}

describe("scan-watchlist route auth", () => {
  it("rejects a missing signature", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await scanWatchlistRoute(
        new Request(
          "http://localhost/api/transfers/payments/zcash/scan-watchlist",
          { method: "POST", body: "{}" },
        ),
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
      const response = await scanWatchlistRoute(
        signedWatchlistRequest("deadbeef"),
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
      const response = await scanWatchlistRoute(
        signedWatchlistRequest("deadbeef"),
      );
      expect(response.status).toBe(400);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("scan-watchlist payload", () => {
  it("returns a UFVK entry per pending order", async () => {
    const { orderId, sellerId, receivingAddress } =
      await pendingUfvkOrder("watch-a");

    const response = await scanWatchlistRoute(signedWatchlistRequest());
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as { entries: WatchlistEntry[] };
    expect(parsed.entries).toHaveLength(1);
    const entry = parsed.entries[0];
    expect(entry.orderId).toBe(orderId);
    expect(entry.sellerId).toBe(sellerId);
    expect(entry.scanRef).toBe(SCAN_REF);
    expect(entry.address).toBe(receivingAddress);
    expect(entry.diversifierIndex).toBe(1);
    expect(entry.startHeight).toBe(0);
    expect(entry.amountZats).toBe(5_000_000);
  });

  it("returns an empty list when there are no pending UFVK orders", async () => {
    const response = await scanWatchlistRoute(signedWatchlistRequest());
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as { entries: WatchlistEntry[] };
    expect(parsed.entries).toEqual([]);
  });

  it("omits orders once they are paid", async () => {
    const { orderId, receivingAddress } = await pendingUfvkOrder("watch-b");
    const body = JSON.stringify({
      receivingAddress,
      amountZats: 5_000_000,
      txid: "a".repeat(64),
      confirmations: 12,
    });
    const settled = await zcashWebhookRoute(signedWebhookRequest(body));
    expect(settled.status).toBe(200);

    const response = await scanWatchlistRoute(signedWatchlistRequest());
    const parsed = (await response.json()) as { entries: WatchlistEntry[] };
    expect(parsed.entries.find((e) => e.orderId === orderId)).toBeUndefined();
  });
});

describe("webhook sellerId cross-check", () => {
  it("settles when the sellerId matches the order seller", async () => {
    const { orderId, sellerId, receivingAddress } =
      await pendingUfvkOrder("hook-a");
    const body = JSON.stringify({
      receivingAddress,
      amountZats: 5_000_000,
      txid: "b".repeat(64),
      confirmations: 12,
      sellerId,
    });
    const response = await zcashWebhookRoute(signedWebhookRequest(body));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      ok: boolean;
      order?: { orderId: string; status: string };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.order?.orderId).toBe(orderId);
    expect(parsed.order?.status).toBe("paid");
  });

  it("rejects when the sellerId does not match the order seller", async () => {
    const { receivingAddress } = await pendingUfvkOrder("hook-b");
    const body = JSON.stringify({
      receivingAddress,
      amountZats: 5_000_000,
      txid: "c".repeat(64),
      confirmations: 12,
      sellerId: "sel_000000000000000000000000",
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await zcashWebhookRoute(signedWebhookRequest(body));
      expect(response.status).not.toBe(200);
      const parsed = (await response.json()) as ErrorEnvelope;
      expect(parsed.error.message).toMatch(/seller/iu);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("still settles when no sellerId is provided (back-compat)", async () => {
    const { receivingAddress } = await pendingUfvkOrder("hook-c");
    const body = JSON.stringify({
      receivingAddress,
      amountZats: 5_000_000,
      txid: "d".repeat(64),
      confirmations: 12,
    });
    const response = await zcashWebhookRoute(signedWebhookRequest(body));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});
