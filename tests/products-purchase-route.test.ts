import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as readProductRoute } from "../app/api/products/[productId]/route";
import { POST as purchaseProductRoute } from "../app/api/products/[productId]/purchase/route";
import {
  createProduct,
  type CreateProductInput,
  type ProductSupply,
} from "../lib/server/product-store";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";

const PAYOUT_ADDRESS = "u1sellerpayoutaddress000000000000000000000000000000000";
const RELEASE_SECRET_HASH = "a".repeat(64);
const SELLER_ID = "sel_aaaaaaaaaaaaaaaaaaaaaaaa";

let runtimeDir: string;

interface PublicProductBody {
  product: {
    productId: string;
    status: string;
    supply: { mode: string; max?: number };
    salesCount: number;
    soldOut: boolean;
    remainingSupply: number;
  };
}

interface PurchaseBody {
  order: {
    orderId: string;
    productId: string | null;
    status: string;
    price: { amountZats: number };
  };
}

interface ErrorEnvelope {
  error: { kind: string; message: string };
}

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-purchase-route-"));
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

function makeInput(
  overrides: Partial<CreateProductInput> = {},
): CreateProductInput {
  const encrypted = encryptedFixture();
  return {
    encryptedFile: encrypted,
    fileName: "course.zip",
    mimeType: "application/zip",
    originalSizeBytes: 123,
    encryptedFileSha256: sha256Hex(encrypted),
    encryptionIv: randomBytes(12).toString("base64"),
    releaseSecretHash: RELEASE_SECRET_HASH,
    amountZats: 5_000_000,
    sellerPayoutAddress: PAYOUT_ADDRESS,
    sellerId: SELLER_ID,
    seller: { sellerId: SELLER_ID, handle: "alice", displayName: "Alice" },
    sellerNote: "thanks for buying",
    supply: { mode: "open" },
    ...overrides,
  };
}

function readContext(productId: string) {
  return { params: Promise.resolve({ productId }) };
}

function readRequest(productId: string): Request {
  return new Request(`http://localhost/api/products/${productId}`);
}

function purchaseRequest(productId: string): Request {
  return new Request(`http://localhost/api/products/${productId}/purchase`, {
    method: "POST",
  });
}

describe("GET /api/products/[productId]", () => {
  it("returns the public product (no auth required)", async () => {
    const product = await createProduct(makeInput());
    const response = await readProductRoute(
      readRequest(product.productId),
      readContext(product.productId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as PublicProductBody;
    expect(body.product.productId).toBe(product.productId);
    expect(body.product.status).toBe("open");
    expect(body.product.salesCount).toBe(0);
    expect(body.product.soldOut).toBe(false);

    // The secret hash must never reach the wire.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(RELEASE_SECRET_HASH);
    expect(serialized).not.toContain("releaseSecretHash");
  });

  it("returns 404 for an unknown product", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const unknownId = "prd_ffffffffffffffffffffffff";
      const response = await readProductRoute(
        readRequest(unknownId),
        readContext(unknownId),
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("validation");
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("POST /api/products/[productId]/purchase", () => {
  it("spawns a fresh per-buyer order from an open product (no auth)", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "open" } }),
    );

    const response = await purchaseProductRoute(
      purchaseRequest(product.productId),
      readContext(product.productId),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as PurchaseBody;
    expect(body.order.orderId).toMatch(/^pl_[a-f0-9]{24}$/u);
    expect(body.order.productId).toBe(product.productId);
    expect(body.order.status).toBe("created");
    expect(body.order.price.amountZats).toBe(5_000_000);
  });

  it("gives two buyers distinct order ids", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "open" } }),
    );

    const first = (await (
      await purchaseProductRoute(
        purchaseRequest(product.productId),
        readContext(product.productId),
      )
    ).json()) as PurchaseBody;
    const second = (await (
      await purchaseProductRoute(
        purchaseRequest(product.productId),
        readContext(product.productId),
      )
    ).json()) as PurchaseBody;

    expect(first.order.orderId).not.toBe(second.order.orderId);
  });

  it("returns 404 for an unknown product", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const unknownId = "prd_ffffffffffffffffffffffff";
      const response = await purchaseProductRoute(
        purchaseRequest(unknownId),
        readContext(unknownId),
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("validation");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("lets a single buyer purchase a 1-supply limited product and rejects the second", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 1 } as ProductSupply }),
    );

    const firstResponse = await purchaseProductRoute(
      purchaseRequest(product.productId),
      readContext(product.productId),
    );
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as PurchaseBody;
    expect(firstBody.order.productId).toBe(product.productId);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const secondResponse = await purchaseProductRoute(
        purchaseRequest(product.productId),
        readContext(product.productId),
      );
      // Sold out -> flow_conflict -> HTTP 409. No second order is created.
      expect(secondResponse.status).toBe(409);
      const secondBody = (await secondResponse.json()) as ErrorEnvelope;
      expect(secondBody.error.kind).toBe("flow_conflict");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects a purchase against a sold-out limited product (200 then 409)", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 2 } as ProductSupply }),
    );

    expect(
      (
        await purchaseProductRoute(
          purchaseRequest(product.productId),
          readContext(product.productId),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await purchaseProductRoute(
          purchaseRequest(product.productId),
          readContext(product.productId),
        )
      ).status,
    ).toBe(200);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const soldOut = await purchaseProductRoute(
        purchaseRequest(product.productId),
        readContext(product.productId),
      );
      expect(soldOut.status).toBe(409);
      const body = (await soldOut.json()) as ErrorEnvelope;
      expect(body.error.kind).toBe("flow_conflict");

      // The public product reflects sold-out after the limit was hit.
      const productView = (await (
        await readProductRoute(
          readRequest(product.productId),
          readContext(product.productId),
        )
      ).json()) as PublicProductBody;
      expect(productView.product.soldOut).toBe(true);
      expect(productView.product.salesCount).toBe(2);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
