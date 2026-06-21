import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPaidLinkSellerReleaseDraft } from "../lib/paid-link-client-crypto";
import { createSellerProfile } from "../lib/server/seller-store";
import {
  createTransferOrder,
  listOrdersForSeller,
  type TransferSeller,
} from "../lib/server/transfer-store";

const SELLER_ADDRESS = "u1selleraddr0000000000000000000000000000000000";

let runtimeDir: string;
let releaseDraft: { releaseSecretHash: string };

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
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-seller-files-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  releaseDraft = await createPaidLinkSellerReleaseDraft(
    randomBytes(32).toString("base64"),
  );
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

async function makeSeller(handle: string): Promise<TransferSeller> {
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

async function makeOrder(
  seller: TransferSeller | null,
  fileName: string,
): Promise<string> {
  const encrypted = new Uint8Array([1, 2, 3, 4, 5]);
  const order = await createTransferOrder({
    encryptedFile: encrypted,
    fileName,
    mimeType: "application/pdf",
    originalSizeBytes: 120,
    encryptedFileSha256: createHash("sha256").update(encrypted).digest("hex"),
    encryptionIv: randomBytes(12).toString("base64"),
    releaseSecretHash: releaseDraft.releaseSecretHash,
    amountZats: 5_000_000,
    sellerPayoutAddress: SELLER_ADDRESS,
    seller,
  });
  return order.orderId;
}

describe("listOrdersForSeller", () => {
  it("returns an empty list when the seller has no orders", async () => {
    const seller = await makeSeller("empty-shop");
    expect(await listOrdersForSeller(seller.sellerId)).toEqual([]);
  });

  it("returns only the orders that belong to the given seller", async () => {
    const sellerA = await makeSeller("shop-a");
    const sellerB = await makeSeller("shop-b");
    const orderA1 = await makeOrder(sellerA, "a1.pdf");
    const orderA2 = await makeOrder(sellerA, "a2.pdf");
    await makeOrder(sellerB, "b1.pdf");
    await makeOrder(null, "anon.pdf");

    const ordersForA = await listOrdersForSeller(sellerA.sellerId);
    expect(ordersForA.map((order) => order.orderId).sort()).toEqual(
      [orderA1, orderA2].sort(),
    );
    for (const order of ordersForA) {
      expect(order.seller?.sellerId).toBe(sellerA.sellerId);
    }
  });

  it("returns the orders newest first", async () => {
    const seller = await makeSeller("ordered-shop");
    const first = await makeOrder(seller, "first.pdf");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await makeOrder(seller, "second.pdf");

    const orders = await listOrdersForSeller(seller.sellerId);
    expect(orders).toHaveLength(2);
    expect(orders[0].orderId).toBe(second);
    expect(orders[1].orderId).toBe(first);
  });

  it("returns public orders that never expose the buyer key material", async () => {
    const seller = await makeSeller("public-shop");
    await makeOrder(seller, "secret.pdf");
    const orders = await listOrdersForSeller(seller.sellerId);
    const serialized = JSON.stringify(orders);
    expect(serialized).not.toContain("buyerPublicKeyHash");
    expect(serialized).not.toContain("releaseSecretHash");
  });
});
