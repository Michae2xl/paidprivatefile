// The buyer + seller status steppers drive their highlight off two pure helpers:
//   - getBuyerStatusStageIndex: (phase, order, downloadUrl) -> 0..4
//   - getSellerStatusStageIndex: (order delivery state) -> 0..4
// Plus shortNymAddress for the buyer Nym-health line. These pin the stage
// transitions (including the pure-Nym "delivered" terminal) without React.

import { describe, expect, it } from "vitest";

import {
  getBuyerStatusStageIndex,
  getSellerStatusStageIndex,
  shortNymAddress,
} from "../app/components/paid-private-file/paid-private-file-panel";

describe("getBuyerStatusStageIndex", () => {
  it("is stage 0 (awaiting payment) while loading or awaiting payment", () => {
    expect(
      getBuyerStatusStageIndex({
        phase: "loading",
        order: { status: "created", payment: null },
        downloadUrl: "",
      }),
    ).toBe(0);
    expect(
      getBuyerStatusStageIndex({
        phase: "awaiting-payment",
        order: { status: "payment_pending", payment: { status: "pending" } },
        downloadUrl: "",
      }),
    ).toBe(0);
  });

  it("is stage 2 (paid) when paid but the key is not released yet", () => {
    expect(
      getBuyerStatusStageIndex({
        phase: "in-transit",
        order: {
          status: "paid",
          payment: { status: "paid" },
          release: { status: "seller_pending" },
        },
        downloadUrl: "",
      }),
    ).toBe(2);
  });

  it("is stage 3 (receiving key) once the seller has released the key", () => {
    expect(
      getBuyerStatusStageIndex({
        phase: "in-transit",
        order: {
          status: "paid",
          payment: { status: "paid" },
          release: { status: "ready" },
        },
        downloadUrl: "",
      }),
    ).toBe(3);
  });

  it("is stage 4 (done) once the file is opened locally", () => {
    expect(
      getBuyerStatusStageIndex({
        phase: "done",
        order: { status: "claimed", payment: { status: "paid" } },
        downloadUrl: "blob:abc",
      }),
    ).toBe(4);
  });

  it("is stage 4 (done) once the Nym session reports delivered", () => {
    expect(
      getBuyerStatusStageIndex({
        phase: "in-transit",
        order: {
          status: "paid",
          payment: { status: "paid" },
          release: { status: "ready" },
          delivery: { nymSession: { status: "delivered" } },
        },
        downloadUrl: "",
      }),
    ).toBe(4);
  });
});

describe("getSellerStatusStageIndex", () => {
  it("is stage 0 (awaiting payment) before payment", () => {
    expect(
      getSellerStatusStageIndex({
        status: "payment_pending",
        payment: { status: "pending" },
        release: { status: "seller_pending" },
      }),
    ).toBe(0);
  });

  it("is stage 1 (paid) once paid but not released", () => {
    expect(
      getSellerStatusStageIndex({
        status: "paid",
        payment: { status: "paid" },
        release: { status: "seller_pending" },
      }),
    ).toBe(1);
  });

  it("is stage 3 (sent over Nym) once released but not yet acked", () => {
    expect(
      getSellerStatusStageIndex({
        status: "claimed",
        payment: { status: "paid" },
        release: { status: "ready" },
        nymSession: { status: "queued" },
      }),
    ).toBe(3);
  });

  it("is stage 4 (delivered) only when the buyer acks (nymSession delivered)", () => {
    expect(
      getSellerStatusStageIndex({
        status: "claimed",
        payment: { status: "paid" },
        release: { status: "ready" },
        nymSession: { status: "delivered" },
      }),
    ).toBe(4);
  });
});

describe("shortNymAddress", () => {
  it("returns short addresses unchanged", () => {
    expect(shortNymAddress("nym1short")).toBe("nym1short");
  });

  it("truncates long addresses to head…tail", () => {
    const long = `${"a".repeat(20)}@${"b".repeat(40)}`;
    const result = shortNymAddress(long);
    expect(result).toContain("…");
    expect(result.length).toBeLessThan(long.length);
  });
});
