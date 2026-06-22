import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerError } from "../lib/server/error-kinds";
import { registerDepositAddresses } from "../lib/server/deposit-pool";
import {
  createProduct,
  getProduct,
  getPublicProduct,
  isSoldOut,
  listProductsForSeller,
  recordProductSale,
  remainingSupply,
  spawnOrderFromProduct,
  type CreateProductInput,
  type ProductSupply,
} from "../lib/server/product-store";
import {
  createPaymentIntentForOrder,
  getTransferPublicOrder,
} from "../lib/server/transfer-store";

let runtimeDir: string;

const SELLER_ID = "sel_aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SELLER_ID = "sel_bbbbbbbbbbbbbbbbbbbbbbbb";
const PAYOUT_ADDRESS = "u1sellerpayoutaddress000000000000000000000000000000000";
const RELEASE_SECRET_HASH = "a".repeat(64);

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-product-store-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
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

describe("product-store createProduct", () => {
  it("creates an open product, persists the ciphertext, starts at 0 sales", async () => {
    const product = await createProduct(makeInput());

    expect(product.productId).toMatch(/^prd_[a-f0-9]{24}$/u);
    expect(product.status).toBe("open");
    expect(product.salesCount).toBe(0);
    expect(product.supply).toEqual({ mode: "open" });
    expect(product.price.amountZats).toBe(5_000_000);
    expect(product.sellerId).toBe(SELLER_ID);
    expect(product.releaseSecretHash).toBe(RELEASE_SECRET_HASH);

    const stored = await getProduct(product.productId);
    expect(stored.productId).toBe(product.productId);

    // The ciphertext landed on disk.
    const bytes = new Uint8Array(
      await readFile(
        join(
          runtimeDir,
          "paid-products",
          "products",
          product.productId,
          "encrypted.bin",
        ),
      ),
    );
    expect(bytes).toEqual(encryptedFixture());
  });

  it("creates a limited product with a max supply", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 3 } }),
    );
    expect(product.supply).toEqual({ mode: "limited", max: 3 });
    expect(product.status).toBe("open");
    expect(remainingSupply(product)).toBe(3);
  });

  it("rejects a limited supply with a non-positive max", async () => {
    await expect(
      createProduct(makeInput({ supply: { mode: "limited", max: 0 } })),
    ).rejects.toBeInstanceOf(ServerError);
    await expect(
      createProduct(
        makeInput({ supply: { mode: "limited", max: -1 } as ProductSupply }),
      ),
    ).rejects.toBeInstanceOf(ServerError);
  });

  it("rejects a mismatched ciphertext digest", async () => {
    await expect(
      createProduct(makeInput({ encryptedFileSha256: "f".repeat(64) })),
    ).rejects.toBeInstanceOf(ServerError);
  });

  it("rejects an invalid release secret hash", async () => {
    await expect(
      createProduct(makeInput({ releaseSecretHash: "not-hex" })),
    ).rejects.toBeInstanceOf(ServerError);
  });
});

describe("product-store getPublicProduct", () => {
  it("strips the release secret hash and never exposes key material", async () => {
    const product = await createProduct(makeInput());
    const publicProduct = await getPublicProduct(product.productId);

    expect(publicProduct.productId).toBe(product.productId);
    expect(publicProduct.salesCount).toBe(0);
    expect(publicProduct.soldOut).toBe(false);
    expect(
      (publicProduct as unknown as { releaseSecretHash?: string })
        .releaseSecretHash,
    ).toBeUndefined();
    const serialized = JSON.stringify(publicProduct);
    expect(serialized).not.toContain(RELEASE_SECRET_HASH);
    expect(serialized).not.toContain("releaseSecretHash");
  });
});

describe("product-store listProductsForSeller", () => {
  it("returns only the seller's products, newest first, secret-stripped", async () => {
    const first = await createProduct(makeInput({ fileName: "one.zip" }));
    // Ensure a distinct createdAt ordering.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createProduct(makeInput({ fileName: "two.zip" }));
    await createProduct(
      makeInput({
        sellerId: OTHER_SELLER_ID,
        seller: {
          sellerId: OTHER_SELLER_ID,
          handle: "bob",
          displayName: "Bob",
        },
      }),
    );

    const list = await listProductsForSeller(SELLER_ID);
    expect(list).toHaveLength(2);
    expect(list[0].productId).toBe(second.productId);
    expect(list[1].productId).toBe(first.productId);
    expect(JSON.stringify(list)).not.toContain(RELEASE_SECRET_HASH);
  });

  it("returns an empty list when the seller has no products", async () => {
    expect(await listProductsForSeller(SELLER_ID)).toEqual([]);
  });
});

describe("product-store supply helpers", () => {
  it("treats open products as infinite supply and never sold out", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "open" } }),
    );
    expect(remainingSupply(product)).toBe(Number.POSITIVE_INFINITY);
    expect(isSoldOut(product)).toBe(false);
  });

  it("computes remaining supply and sold-out for limited products", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 2 } }),
    );
    expect(remainingSupply(product)).toBe(2);
    expect(isSoldOut(product)).toBe(false);
  });
});

describe("product-store recordProductSale", () => {
  it("increments salesCount on an open product without ever selling out", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "open" } }),
    );
    const afterOne = await recordProductSale(product.productId);
    expect(afterOne.salesCount).toBe(1);
    expect(afterOne.status).toBe("open");

    const afterTwo = await recordProductSale(product.productId);
    expect(afterTwo.salesCount).toBe(2);
    expect(afterTwo.status).toBe("open");
    expect(isSoldOut(afterTwo)).toBe(false);
  });

  it("flips a limited product to sold_out at the boundary", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 2 } }),
    );

    const afterOne = await recordProductSale(product.productId);
    expect(afterOne.salesCount).toBe(1);
    expect(afterOne.status).toBe("open");
    expect(isSoldOut(afterOne)).toBe(false);

    const afterTwo = await recordProductSale(product.productId);
    expect(afterTwo.salesCount).toBe(2);
    expect(afterTwo.status).toBe("sold_out");
    expect(isSoldOut(afterTwo)).toBe(true);
    expect(remainingSupply(afterTwo)).toBe(0);
  });

  it("rejects a sale once a limited product is sold out", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 1 } }),
    );
    await recordProductSale(product.productId);
    await expect(recordProductSale(product.productId)).rejects.toBeInstanceOf(
      ServerError,
    );
  });

  it("never oversells the last unit under concurrent sales", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 3 } }),
    );

    // Fire five concurrent sales against a 3-unit product: exactly three settle,
    // two are rejected. The per-product lock serializes the increments.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => recordProductSale(product.productId)),
    );
    const settled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(settled).toHaveLength(3);
    expect(rejected).toHaveLength(2);

    const final = await getProduct(product.productId);
    expect(final.salesCount).toBe(3);
    expect(final.status).toBe("sold_out");
  });
});

async function buyerPublicKeyJwk(): Promise<JsonWebKey> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
  delete jwk.key_ops;
  delete jwk.ext;
  return jwk;
}

describe("product-store spawnOrderFromProduct", () => {
  it("rejects an unknown product id", async () => {
    await expect(
      spawnOrderFromProduct("prd_ffffffffffffffffffffffff"),
    ).rejects.toBeInstanceOf(ServerError);
  });

  it("spawns a self-contained purchase order from an open product", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "open" } }),
    );

    const order = await spawnOrderFromProduct(product.productId);

    // A fresh normal order, linked back to its source product.
    expect(order.orderId).toMatch(/^pl_[a-f0-9]{24}$/u);
    expect(order.productId).toBe(product.productId);
    expect(order.status).toBe("created");
    // File metadata + price + seller copied from the product.
    expect(order.file.fileName).toBe("course.zip");
    expect(order.file.encryptedFileSha256).toBe(product.encryptedFileSha256);
    expect(order.price.amountZats).toBe(product.price.amountZats);
    expect(order.sellerPayoutAddress).toBe(product.sellerPayoutAddress);

    // The purchase has its OWN ciphertext copied onto disk.
    const bytes = new Uint8Array(
      await readFile(
        join(
          runtimeDir,
          "paid-transfers",
          "orders",
          order.orderId,
          "encrypted.bin",
        ),
      ),
    );
    expect(bytes).toEqual(encryptedFixture());

    // The order is also readable through the canonical store projection.
    const reread = await getTransferPublicOrder(order.orderId);
    expect(reread.productId).toBe(product.productId);
  });

  it("does NOT reserve a unit for an open product (unlimited)", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "open" } }),
    );

    await spawnOrderFromProduct(product.productId);
    await spawnOrderFromProduct(product.productId);
    await spawnOrderFromProduct(product.productId);

    const after = await getProduct(product.productId);
    // Open supply is never reserved on spawn, so salesCount stays at 0 and the
    // product is never sold out.
    expect(after.salesCount).toBe(0);
    expect(after.status).toBe("open");
  });

  it("gives multiple open purchases distinct order ids and deposit addresses", async () => {
    process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN = "1";
    process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET =
      "test-spawn-token-secret";
    try {
      await registerDepositAddresses([
        "u1depositpooladdressaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "u1depositpooladdressbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ]);
      const product = await createProduct(
        makeInput({ supply: { mode: "open" } }),
      );

      const first = await spawnOrderFromProduct(product.productId);
      const second = await spawnOrderFromProduct(product.productId);

      expect(first.orderId).not.toBe(second.orderId);

      const firstIntent = await createPaymentIntentForOrder(
        first.orderId,
        await buyerPublicKeyJwk(),
      );
      const secondIntent = await createPaymentIntentForOrder(
        second.orderId,
        await buyerPublicKeyJwk(),
      );

      // Each purchase gets its own per-order deposit address — two buyers never
      // collide on the same deposit.
      expect(firstIntent.payment.paymentAddress).toBeTruthy();
      expect(secondIntent.payment.paymentAddress).toBeTruthy();
      expect(firstIntent.payment.paymentAddress).not.toBe(
        secondIntent.payment.paymentAddress,
      );
    } finally {
      delete process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN;
      delete process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET;
    }
  });

  it("reserves a unit and increments salesCount for a limited product", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 3 } }),
    );

    const order = await spawnOrderFromProduct(product.productId);
    expect(order.productId).toBe(product.productId);

    const after = await getProduct(product.productId);
    expect(after.salesCount).toBe(1);
    expect(after.status).toBe("open");
    expect(remainingSupply(after)).toBe(2);
  });

  it("flips a limited product to sold_out and rejects the Nth+1 purchase", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 2 } }),
    );

    const first = await spawnOrderFromProduct(product.productId);
    const second = await spawnOrderFromProduct(product.productId);
    expect(first.orderId).not.toBe(second.orderId);

    const soldOut = await getProduct(product.productId);
    expect(soldOut.salesCount).toBe(2);
    expect(soldOut.status).toBe("sold_out");
    expect(isSoldOut(soldOut)).toBe(true);

    // No paid buyer can ever be created against a sold-out product.
    await expect(
      spawnOrderFromProduct(product.productId),
    ).rejects.toBeInstanceOf(ServerError);
  });

  it("handles a single buyer of a 1-supply product and rejects the second", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 1 } }),
    );

    const order = await spawnOrderFromProduct(product.productId);
    expect(order.orderId).toMatch(/^pl_[a-f0-9]{24}$/u);

    const after = await getProduct(product.productId);
    expect(after.salesCount).toBe(1);
    expect(after.status).toBe("sold_out");

    await expect(
      spawnOrderFromProduct(product.productId),
    ).rejects.toBeInstanceOf(ServerError);
  });

  it("never oversells the last unit under concurrent spawns", async () => {
    const product = await createProduct(
      makeInput({ supply: { mode: "limited", max: 3 } }),
    );

    // Five concurrent purchases against a 3-unit product: exactly three orders
    // are created, two are rejected sold-out. The per-product lock in
    // recordProductSale serializes the reservation.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => spawnOrderFromProduct(product.productId)),
    );
    const settled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(settled).toHaveLength(3);
    expect(rejected).toHaveLength(2);

    const final = await getProduct(product.productId);
    expect(final.salesCount).toBe(3);
    expect(final.status).toBe("sold_out");

    // Each successful purchase is a distinct order.
    const orderIds = new Set(
      settled.map(
        (r) => (r as PromiseFulfilledResult<{ orderId: string }>).value.orderId,
      ),
    );
    expect(orderIds.size).toBe(3);
  });
});
