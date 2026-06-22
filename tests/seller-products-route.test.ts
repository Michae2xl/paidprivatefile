import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as listProductsRoute } from "../app/api/sellers/me/products/route";
import { createProduct, type ProductSupply } from "../lib/server/product-store";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";
import {
  createSellerProfile,
  createSellerSessionToken,
  SELLER_SESSION_COOKIE,
} from "../lib/server/seller-store";
import { createHash } from "node:crypto";

const SELLER_ADDRESS =
  "u1sellerproductsaddr00000000000000000000000000000000000";
const RELEASE_SECRET_HASH = "b".repeat(64);

let runtimeDir: string;

interface ProductsEnvelope {
  products: Array<{
    productId: string;
    fileName: string;
    displayZec: string;
    status: string;
    supply: { mode: string; max?: number };
    salesCount: number;
    remainingSupply: number | null;
    soldOut: boolean;
    createdAt: string;
    sharePath: string;
  }>;
}

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-products-list-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  resetRateLimitStateForTesting();
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS;
  await rm(runtimeDir, { recursive: true, force: true });
});

function encryptedFixture(seed: number): Uint8Array {
  return new Uint8Array([seed, seed + 1, seed + 2, seed + 3]);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeSeller(handle: string): Promise<{
  sellerId: string;
  handle: string;
  displayName: string;
}> {
  const created = await createSellerProfile({
    handle,
    displayName: handle,
    defaultPayoutAddress: SELLER_ADDRESS,
  });
  return {
    sellerId: created.seller.sellerId,
    handle: created.seller.handle,
    displayName: created.seller.displayName,
  };
}

async function makeProduct(
  seller: { sellerId: string; handle: string; displayName: string },
  fileName: string,
  supply: ProductSupply,
  seed: number,
): Promise<string> {
  const encrypted = encryptedFixture(seed);
  const product = await createProduct({
    encryptedFile: encrypted,
    fileName,
    mimeType: "application/zip",
    originalSizeBytes: 100,
    encryptedFileSha256: sha256Hex(encrypted),
    encryptionIv: Buffer.from(new Uint8Array(12)).toString("base64"),
    releaseSecretHash: RELEASE_SECRET_HASH,
    amountZats: 5_000_000,
    sellerPayoutAddress: SELLER_ADDRESS,
    sellerId: seller.sellerId,
    seller,
    supply,
  });
  return product.productId;
}

function listRequest(sellerId: string | null): Request {
  const headers: Record<string, string> = {};
  if (sellerId) {
    headers.cookie = `${SELLER_SESSION_COOKIE}=${createSellerSessionToken(sellerId)}`;
  }
  return new Request("http://localhost/api/sellers/me/products", {
    method: "GET",
    headers,
  });
}

describe("GET /api/sellers/me/products", () => {
  it("requires a seller session", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await listProductsRoute(listRequest(null));
      expect(response.status).toBe(401);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("returns the seller's products newest first with summary fields", async () => {
    const seller = await makeSeller("products-list-shop");
    const first = await makeProduct(seller, "alpha.zip", { mode: "open" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await makeProduct(
      seller,
      "beta.zip",
      { mode: "limited", max: 10 },
      20,
    );

    const response = await listProductsRoute(listRequest(seller.sellerId));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as ProductsEnvelope;
    expect(parsed.products.map((p) => p.productId)).toEqual([second, first]);

    const top = parsed.products[0];
    expect(top.fileName).toBe("beta.zip");
    expect(top.displayZec).toBe("0.05");
    expect(top.status).toBe("open");
    expect(top.supply).toEqual({ mode: "limited", max: 10 });
    expect(top.salesCount).toBe(0);
    expect(top.remainingSupply).toBe(10);
    expect(top.soldOut).toBe(false);
    expect(top.sharePath).toBe(`/s/${seller.handle}/products/${second}`);

    const open = parsed.products[1];
    expect(open.supply).toEqual({ mode: "open" });
    // Infinity does not survive JSON; the route maps an unlimited remaining to
    // null on purpose so the client can render "Open" for it.
    expect(open.remainingSupply).toBeNull();
  });

  it("returns an empty list when the seller has no products", async () => {
    const seller = await makeSeller("empty-products-shop");
    const response = await listProductsRoute(listRequest(seller.sellerId));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as ProductsEnvelope;
    expect(parsed.products).toEqual([]);
  });

  it("does not leak the seller release secret hash", async () => {
    const seller = await makeSeller("leak-products-shop");
    await makeProduct(seller, "secret.zip", { mode: "open" }, 7);
    const response = await listProductsRoute(listRequest(seller.sellerId));
    const text = await response.text();
    expect(text).not.toContain(RELEASE_SECRET_HASH);
    expect(text).not.toContain("releaseSecretHash");
  });
});
