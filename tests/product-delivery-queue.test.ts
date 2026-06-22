import { describe, expect, it } from "vitest";

import {
  isProductPurchase,
  isPurchasePendingDelivery,
  pendingPurchases,
  selectNextPurchaseToDeliver,
  type DeliverableSummary,
} from "../lib/product-delivery-queue";

function summary(
  overrides: Partial<DeliverableSummary> & { orderId: string },
): DeliverableSummary {
  return {
    productId: "prd_aaaaaaaaaaaaaaaaaaaaaaaa",
    status: "paid",
    nymSessionStatus: null,
    ...overrides,
  };
}

describe("isProductPurchase", () => {
  it("is true only when a productId is present", () => {
    expect(isProductPurchase(summary({ orderId: "pl_1" }))).toBe(true);
    expect(
      isProductPurchase(summary({ orderId: "pl_1", productId: null })),
    ).toBe(false);
    expect(
      isProductPurchase(summary({ orderId: "pl_1", productId: undefined })),
    ).toBe(false);
  });
});

describe("isPurchasePendingDelivery", () => {
  it("selects paid/claimed product purchases that are not yet delivered", () => {
    expect(isPurchasePendingDelivery(summary({ orderId: "pl_1" }))).toBe(true);
    expect(
      isPurchasePendingDelivery(
        summary({ orderId: "pl_1", status: "claimed" }),
      ),
    ).toBe(true);
  });

  it("rejects unpaid, delivered, or single-use orders", () => {
    // Not yet paid.
    expect(
      isPurchasePendingDelivery(
        summary({ orderId: "pl_1", status: "created" }),
      ),
    ).toBe(false);
    // Already ACKed by the buyer.
    expect(
      isPurchasePendingDelivery(
        summary({ orderId: "pl_1", nymSessionStatus: "delivered" }),
      ),
    ).toBe(false);
    // Single-use order (no productId) is never handled by this queue.
    expect(
      isPurchasePendingDelivery(summary({ orderId: "pl_1", productId: null })),
    ).toBe(false);
  });
});

describe("pendingPurchases", () => {
  it("returns only pending purchases, sorted by orderId, excluding single-use", () => {
    const result = pendingPurchases([
      summary({ orderId: "pl_c" }),
      summary({ orderId: "pl_a" }),
      summary({ orderId: "pl_b", nymSessionStatus: "delivered" }),
      summary({ orderId: "pl_single", productId: null }),
    ]);
    expect(result.map((entry) => entry.orderId)).toEqual(["pl_a", "pl_c"]);
  });

  it("does not mutate the input array", () => {
    const input = [summary({ orderId: "pl_b" }), summary({ orderId: "pl_a" })];
    const snapshot = input.map((entry) => entry.orderId);
    pendingPurchases(input);
    expect(input.map((entry) => entry.orderId)).toEqual(snapshot);
  });
});

describe("selectNextPurchaseToDeliver", () => {
  const hasDraft = () => true;

  it("returns the first pending purchase when nothing is in flight", () => {
    const next = selectNextPurchaseToDeliver({
      summaries: [summary({ orderId: "pl_b" }), summary({ orderId: "pl_a" })],
      inFlightOrderId: null,
      hasReleaseDraft: hasDraft,
    });
    expect(next?.orderId).toBe("pl_a");
  });

  it("holds the queue while an in-flight purchase is still pending (one-at-a-time)", () => {
    const next = selectNextPurchaseToDeliver({
      summaries: [summary({ orderId: "pl_a" }), summary({ orderId: "pl_b" })],
      inFlightOrderId: "pl_a",
      hasReleaseDraft: hasDraft,
    });
    expect(next).toBeNull();
  });

  it("advances to the next purchase once the in-flight one is delivered", () => {
    const next = selectNextPurchaseToDeliver({
      summaries: [
        summary({ orderId: "pl_a", nymSessionStatus: "delivered" }),
        summary({ orderId: "pl_b" }),
      ],
      inFlightOrderId: "pl_a",
      hasReleaseDraft: hasDraft,
    });
    // pl_a is no longer pending, so the queue is free to start pl_b.
    expect(next?.orderId).toBe("pl_b");
  });

  it("skips purchases whose release secret is not held by this browser", () => {
    const next = selectNextPurchaseToDeliver({
      summaries: [
        summary({ orderId: "pl_a", productId: "prd_no" }),
        summary({ orderId: "pl_b", productId: "prd_yes" }),
      ],
      inFlightOrderId: null,
      hasReleaseDraft: (productId) => productId === "prd_yes",
    });
    expect(next?.orderId).toBe("pl_b");
  });

  it("returns null when no purchase is deliverable", () => {
    expect(
      selectNextPurchaseToDeliver({
        summaries: [summary({ orderId: "pl_a", productId: null })],
        inFlightOrderId: null,
        hasReleaseDraft: hasDraft,
      }),
    ).toBeNull();
  });
});
