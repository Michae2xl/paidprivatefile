// The seller dashboard "YOUR FILES" list and the manage screen both render a
// per-file status label off a single pure mapper,
// formatFileStatus(status, copy, nymSessionStatus). These tests pin each summary
// status to its dashboard copy key. Crucially, "Delivered" must mean the BUYER
// acked over Nym (nymSession.status === "delivered") — NOT the moment the buyer
// merely claimed the ciphertext URL. So a claimed/released order that has not
// been acked reads "Delivering" / "Awaiting delivery", and only the delivered
// ack maps to "Delivered". No React is involved.

import { describe, expect, it } from "vitest";

import { formatFileStatus } from "../app/components/paid-private-file/paid-private-file-panel";
import type { PaidPrivateFileCopy } from "../lib/paid-private-file-copy";

// Minimal copy stub: formatFileStatus only reads copy.dashboard status keys, so we
// give each one a distinct sentinel string and assert the mapping picks the right
// one. Cast through unknown so we don't have to build the full copy object.
const copy = {
  dashboard: {
    statusCreated: "CREATED",
    statusPaymentPending: "PENDING",
    statusPaid: "PAID",
    statusPaidReady: "PAID_READY",
    statusClaimed: "DELIVERED",
    statusAwaitingDelivery: "AWAITING_DELIVERY",
    statusDelivering: "DELIVERING",
  },
} as unknown as PaidPrivateFileCopy;

describe("formatFileStatus", () => {
  it("maps 'created' to the created label", () => {
    expect(formatFileStatus("created", copy)).toBe("CREATED");
  });

  it("maps 'payment_pending' to the awaiting-payment label", () => {
    expect(formatFileStatus("payment_pending", copy)).toBe("PENDING");
  });

  it("maps 'paid' (not released) to the ready-to-deliver label", () => {
    expect(formatFileStatus("paid", copy)).toBe("PAID_READY");
  });

  it("maps 'paid' once the key is released + sending to 'Awaiting delivery'", () => {
    expect(formatFileStatus("paid", copy, "queued")).toBe("AWAITING_DELIVERY");
    expect(formatFileStatus("paid", copy, "ready_for_delivery")).toBe(
      "AWAITING_DELIVERY",
    );
  });

  it("maps 'claimed' but NOT yet acked to 'Delivering' (not 'Delivered')", () => {
    expect(formatFileStatus("claimed", copy)).toBe("DELIVERING");
    expect(formatFileStatus("claimed", copy, "queued")).toBe("DELIVERING");
  });

  it("maps 'claimed' + delivered ack to the delivered label", () => {
    expect(formatFileStatus("claimed", copy, "delivered")).toBe("DELIVERED");
  });

  it("maps 'paid' + delivered ack to the delivered label", () => {
    expect(formatFileStatus("paid", copy, "delivered")).toBe("DELIVERED");
  });

  it("falls back to the created label for an unknown status", () => {
    expect(
      formatFileStatus("weird" as Parameters<typeof formatFileStatus>[0], copy),
    ).toBe("CREATED");
  });
});
