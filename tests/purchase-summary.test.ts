// Multi-buyer "file" model: the seller dashboard collapses a file's purchases
// into ONE compact aggregate line (no row-per-purchase). These tests pin the
// pure counters + formatter: total / delivered / in-progress, and the
// "{count}/{total} delivered · {inProgress} in progress" rendering. "Delivered"
// must mean the buyer ACKed over Nym (nymSessionStatus === "delivered"), exactly
// like formatFileStatus. No React is involved.

import { describe, expect, it } from "vitest";

import {
  computePurchaseCounts,
  formatPurchaseSummary,
  type PurchaseSummaryInput,
} from "../lib/purchase-summary";

// Match the real en copy tokens so the formatter assertions read like the UI.
const copy = {
  deliveredSummary: "{count}/{total} delivered",
  inProgressSuffix: " · {inProgress} in progress",
};

describe("computePurchaseCounts", () => {
  it("returns all-zero counts for an empty list", () => {
    expect(computePurchaseCounts([])).toEqual({
      total: 0,
      delivered: 0,
      inProgress: 0,
      awaiting: 0,
    });
  });

  it("counts a delivered purchase only when the buyer acked over Nym", () => {
    const purchases: PurchaseSummaryInput[] = [
      { status: "claimed", nymSessionStatus: "delivered" },
      { status: "paid", nymSessionStatus: "delivered" },
    ];
    expect(computePurchaseCounts(purchases)).toEqual({
      total: 2,
      delivered: 2,
      inProgress: 0,
      awaiting: 0,
    });
  });

  it("counts paid/claimed-but-not-acked purchases as in progress", () => {
    const purchases: PurchaseSummaryInput[] = [
      { status: "paid", nymSessionStatus: "ready_for_delivery" },
      { status: "claimed", nymSessionStatus: "queued" },
      { status: "paid" },
    ];
    expect(computePurchaseCounts(purchases)).toEqual({
      total: 3,
      delivered: 0,
      inProgress: 3,
      awaiting: 0,
    });
  });

  it("counts payment_pending / created purchases as awaiting (not in progress)", () => {
    const purchases: PurchaseSummaryInput[] = [
      { status: "payment_pending" },
      { status: "created" },
    ];
    expect(computePurchaseCounts(purchases)).toEqual({
      total: 2,
      delivered: 0,
      inProgress: 0,
      awaiting: 2,
    });
  });

  it("classifies a mixed list and the three buckets always sum to total", () => {
    const purchases: PurchaseSummaryInput[] = [
      { status: "claimed", nymSessionStatus: "delivered" }, // delivered
      { status: "paid", nymSessionStatus: "queued" }, // in progress
      { status: "claimed" }, // in progress
      { status: "payment_pending" }, // awaiting
    ];
    const counts = computePurchaseCounts(purchases);
    expect(counts).toEqual({
      total: 4,
      delivered: 1,
      inProgress: 2,
      awaiting: 1,
    });
    expect(counts.delivered + counts.inProgress + counts.awaiting).toBe(
      counts.total,
    );
  });
});

describe("formatPurchaseSummary", () => {
  it("returns an empty string when there are no purchases", () => {
    expect(
      formatPurchaseSummary(
        { total: 0, delivered: 0, inProgress: 0, awaiting: 0 },
        copy,
      ),
    ).toBe("");
  });

  it("renders just the delivered line when nothing is in progress", () => {
    expect(
      formatPurchaseSummary(
        { total: 2, delivered: 2, inProgress: 0, awaiting: 0 },
        copy,
      ),
    ).toBe("2/2 delivered");
  });

  it("appends the in-progress clause when some purchases are in flight", () => {
    expect(
      formatPurchaseSummary(
        { total: 3, delivered: 1, inProgress: 2, awaiting: 0 },
        copy,
      ),
    ).toBe("1/3 delivered · 2 in progress");
  });

  it("renders 0 delivered with an in-progress clause", () => {
    expect(
      formatPurchaseSummary(
        { total: 3, delivered: 0, inProgress: 3, awaiting: 0 },
        copy,
      ),
    ).toBe("0/3 delivered · 3 in progress");
  });

  it("does not append the in-progress clause for awaiting-only purchases", () => {
    expect(
      formatPurchaseSummary(
        { total: 2, delivered: 0, inProgress: 0, awaiting: 2 },
        copy,
      ),
    ).toBe("0/2 delivered");
  });

  it("composes counts + formatter end to end on a mixed list", () => {
    const purchases: PurchaseSummaryInput[] = [
      { status: "claimed", nymSessionStatus: "delivered" },
      { status: "paid", nymSessionStatus: "queued" },
      { status: "paid", nymSessionStatus: "ready_for_delivery" },
    ];
    expect(formatPurchaseSummary(computePurchaseCounts(purchases), copy)).toBe(
      "1/3 delivered · 2 in progress",
    );
  });
});
