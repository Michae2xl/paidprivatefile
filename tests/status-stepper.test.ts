// The seller status stepper drives its highlight off a pure helper:
//   - getSellerStatusStageIndex: (order delivery state) -> 0..4
// Plus shortNymAddress for the seller-side compact address display. These pin
// the stage transitions (including the pure-Nym "delivered" terminal) without
// React. The buyer-side stepper was removed in favour of a dead-simple flow
// (single "Receiving your file…" card + auto-download), so there is no buyer
// stage helper to cover here anymore.

import { describe, expect, it } from "vitest";

import {
  getSellerStatusStageIndex,
  shortNymAddress,
} from "../app/components/paid-private-file/paid-private-file-panel";

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
