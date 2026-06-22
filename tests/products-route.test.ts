import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createProductRoute } from "../app/api/products/route";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";
import {
  createSellerProfile,
  createSellerSessionToken,
  SELLER_SESSION_COOKIE,
} from "../lib/server/seller-store";

const PAYOUT_ADDRESS = "u1sellerpayoutaddress000000000000000000000000000000000";
const RELEASE_SECRET_HASH = "a".repeat(64);

let runtimeDir: string;

interface PublicProduct {
  productId: string;
  sellerId: string;
  status: string;
  supply: { mode: string; max?: number };
  salesCount: number;
  soldOut: boolean;
  sellerPayoutAddress: string;
}

interface ErrorEnvelope {
  error: { kind: string; message: string };
}

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-products-route-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  resetRateLimitStateForTesting();
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS;
  await rm(runtimeDir, { recursive: true, force: true });
});

function encryptedFixture(): Uint8Array {
  return new Uint8Array([10, 20, 30, 40, 50, 60]);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function authedSellerId(handle = "product-shop"): Promise<string> {
  const created = await createSellerProfile({
    handle,
    displayName: handle,
    defaultPayoutAddress: PAYOUT_ADDRESS,
  });
  return created.seller.sellerId;
}

interface FormOverrides {
  includeFileKey?: boolean;
  supplyMode?: string | null;
  supplyMax?: string | null;
  releaseSecretHash?: string | null;
}

function makeCreateRequest(
  sellerId: string | null,
  overrides: FormOverrides = {},
): Request {
  const encrypted = encryptedFixture();
  const form = new FormData();
  form.set(
    "encryptedFile",
    new Blob([copyToArrayBuffer(encrypted)], {
      type: "application/octet-stream",
    }),
    "course.zip.enc",
  );
  form.set("fileName", "course.zip");
  form.set("mimeType", "application/zip");
  form.set("originalSizeBytes", "123");
  form.set("encryptedFileSha256", sha256Hex(encrypted));
  form.set("encryptionIv", randomBytes(12).toString("base64"));
  if (overrides.releaseSecretHash !== null) {
    form.set(
      "releaseSecretHash",
      overrides.releaseSecretHash ?? RELEASE_SECRET_HASH,
    );
  }
  form.set("amountZats", "5000000");
  form.set("sellerPayoutAddress", PAYOUT_ADDRESS);
  form.set("sellerNote", "thanks for buying");
  if (overrides.supplyMode !== null) {
    form.set("supplyMode", overrides.supplyMode ?? "open");
  }
  if (overrides.supplyMax !== null && overrides.supplyMax !== undefined) {
    form.set("supplyMax", overrides.supplyMax);
  }
  if (overrides.includeFileKey) {
    form.set("fileKey", randomBytes(32).toString("base64"));
  }

  const headers: Record<string, string> = {};
  if (sellerId) {
    headers.cookie = `${SELLER_SESSION_COOKIE}=${createSellerSessionToken(sellerId)}`;
  }

  return new Request("http://localhost/api/products", {
    method: "POST",
    headers,
    body: form,
  });
}

describe("POST /api/products", () => {
  it("requires a seller session", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createProductRoute(makeCreateRequest(null));
      expect(response.status).toBe(401);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("auth_required");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("creates an open product and returns a secret-stripped public product", async () => {
    const sellerId = await authedSellerId();
    const response = await createProductRoute(
      makeCreateRequest(sellerId, { supplyMode: "open" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      product: PublicProduct;
      sharePath: string;
    };
    expect(body.product.productId).toMatch(/^prd_[a-f0-9]{24}$/u);
    expect(body.product.status).toBe("open");
    expect(body.product.salesCount).toBe(0);
    expect(body.product.supply.mode).toBe("open");
    expect(body.product.sellerId).toBe(sellerId);
    expect(body.product.sellerPayoutAddress).toBe(PAYOUT_ADDRESS);
    expect(body.sharePath).toContain("/products/");
    expect(body.sharePath).toContain(body.product.productId);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(RELEASE_SECRET_HASH);
    expect(serialized).not.toContain("releaseSecretHash");
  });

  it("creates a limited product with a max supply", async () => {
    const sellerId = await authedSellerId();
    const response = await createProductRoute(
      makeCreateRequest(sellerId, { supplyMode: "limited", supplyMax: "5" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { product: PublicProduct };
    expect(body.product.supply.mode).toBe("limited");
    expect(body.product.supply.max).toBe(5);
  });

  it("rejects a limited product without a positive max", async () => {
    const sellerId = await authedSellerId();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createProductRoute(
        makeCreateRequest(sellerId, { supplyMode: "limited", supplyMax: "0" }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("validation");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects an unknown supply mode", async () => {
    const sellerId = await authedSellerId();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createProductRoute(
        makeCreateRequest(sellerId, { supplyMode: "infinite" }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("validation");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects a plaintext fileKey (seller-held custody only)", async () => {
    const sellerId = await authedSellerId();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createProductRoute(
        makeCreateRequest(sellerId, { includeFileKey: true }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("validation");
      expect(body.error.message).toContain("fileKey");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects a create without the required releaseSecretHash", async () => {
    const sellerId = await authedSellerId();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createProductRoute(
        makeCreateRequest(sellerId, { releaseSecretHash: null }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("validation");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
