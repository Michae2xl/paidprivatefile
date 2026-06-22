// The dead-simple buyer checkout drives its UI off two pure helpers:
//   - isOrderPaid: payment confirmed regardless of which field the server uses
//   - getBuyerFlowPhase: (order, payment, downloadUrl) -> visible phase
// These tests pin the transitions: loading -> awaiting-payment -> in-transit ->
// done, plus the paid-detection edge cases. No React is involved.

import { describe, expect, it } from "vitest";

import {
  getBuyerFlowPhase,
  isOrderPaid,
  isPaymentDetected,
} from "../app/components/paid-private-file/paid-private-file-panel";

describe("isOrderPaid", () => {
  it("is false for null / undefined orders", () => {
    expect(isOrderPaid(null)).toBe(false);
    expect(isOrderPaid(undefined)).toBe(false);
  });

  it("is false when neither order nor payment is paid", () => {
    expect(
      isOrderPaid({
        status: "payment_pending",
        payment: { status: "pending" },
      }),
    ).toBe(false);
  });

  it("is true when the payment status is paid", () => {
    expect(
      isOrderPaid({ status: "payment_pending", payment: { status: "paid" } }),
    ).toBe(true);
  });

  it("is true when the order status is paid even with no payment", () => {
    expect(isOrderPaid({ status: "paid", payment: null })).toBe(true);
  });

  it("is true once the order is claimed", () => {
    expect(
      isOrderPaid({ status: "claimed", payment: { status: "paid" } }),
    ).toBe(true);
  });
});

describe("isPaymentDetected", () => {
  it("is false for null / undefined / no-payment orders", () => {
    expect(isPaymentDetected(null)).toBe(false);
    expect(isPaymentDetected(undefined)).toBe(false);
    expect(
      isPaymentDetected({ status: "payment_pending", payment: null }),
    ).toBe(false);
  });

  it("is false before any sighting", () => {
    expect(
      isPaymentDetected({
        status: "payment_pending",
        payment: { status: "pending" },
      }),
    ).toBe(false);
  });

  it("is true once detectedAt is set", () => {
    expect(
      isPaymentDetected({
        status: "payment_pending",
        payment: { status: "pending", detectedAt: "2026-01-01T00:00:00Z" },
      }),
    ).toBe(true);
  });

  it("is true once an onchain sighting is recorded", () => {
    expect(
      isPaymentDetected({
        status: "payment_pending",
        payment: { status: "pending", onchain: { txid: "a".repeat(64) } },
      }),
    ).toBe(true);
  });
});

describe("getBuyerFlowPhase", () => {
  it("is 'loading' before a payment address exists (auto-create in flight)", () => {
    expect(
      getBuyerFlowPhase({
        order: { status: "created", payment: null },
        payment: null,
        downloadUrl: "",
      }),
    ).toBe("loading");
  });

  it("is 'awaiting-payment' once the payment address (QR) is available", () => {
    expect(
      getBuyerFlowPhase({
        order: { status: "payment_pending", payment: { status: "pending" } },
        payment: { paymentAddress: "u1abc" },
        downloadUrl: "",
      }),
    ).toBe("awaiting-payment");
  });

  it("is 'detected' on a 0-conf sighting (detectedAt) before it confirms", () => {
    expect(
      getBuyerFlowPhase({
        order: {
          status: "payment_pending",
          payment: { status: "pending", detectedAt: "2026-01-01T00:00:00Z" },
        },
        payment: { paymentAddress: "u1abc" },
        downloadUrl: "",
      }),
    ).toBe("detected");
  });

  it("is 'detected' when an onchain sighting is present but not paid", () => {
    expect(
      getBuyerFlowPhase({
        order: {
          status: "payment_pending",
          payment: { status: "pending", onchain: { txid: "a".repeat(64) } },
        },
        payment: { paymentAddress: "u1abc" },
        downloadUrl: "",
      }),
    ).toBe("detected");
  });

  it("prefers 'in-transit' (paid) over 'detected' once confirmed", () => {
    expect(
      getBuyerFlowPhase({
        order: {
          status: "paid",
          payment: {
            status: "paid",
            detectedAt: "2026-01-01T00:00:00Z",
            onchain: { txid: "a".repeat(64) },
          },
        },
        payment: { paymentAddress: "u1abc" },
        downloadUrl: "",
      }),
    ).toBe("in-transit");
  });

  it("is 'in-transit' once payment is confirmed but the file is not opened", () => {
    expect(
      getBuyerFlowPhase({
        order: { status: "paid", payment: { status: "paid" } },
        payment: { paymentAddress: "u1abc" },
        downloadUrl: "",
      }),
    ).toBe("in-transit");
  });

  it("is 'done' once the file has been opened locally (downloadUrl set)", () => {
    expect(
      getBuyerFlowPhase({
        order: { status: "claimed", payment: { status: "paid" } },
        payment: { paymentAddress: "u1abc" },
        downloadUrl: "blob:abc",
      }),
    ).toBe("done");
  });

  it("prefers 'done' over 'in-transit' when both could apply", () => {
    expect(
      getBuyerFlowPhase({
        order: { status: "paid", payment: { status: "paid" } },
        payment: { paymentAddress: "u1abc" },
        downloadUrl: "blob:abc",
      }),
    ).toBe("done");
  });
});
