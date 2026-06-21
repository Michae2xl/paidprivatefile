// QR payment URI builder for the buyer checkout. The QR encodes a Zcash
// payment URI for the per-order PAYMENT ADDRESS so the buyer can scan to pay:
// `zcash:<address>?amount=<ZEC decimal>`. These assertions pin the format and
// the no-precision-invented rule (the amount is the display price verbatim).

import { describe, expect, it } from "vitest";

import { buildZcashPaymentUri } from "../app/components/paid-private-file/paid-private-file-panel";

describe("buildZcashPaymentUri", () => {
  it("encodes address and amount as a zcash: URI", () => {
    expect(buildZcashPaymentUri("u1abc", "0.0001")).toBe(
      "zcash:u1abc?amount=0.0001",
    );
  });

  it("uses the display price verbatim without inventing precision", () => {
    expect(buildZcashPaymentUri("u1abc", "0.05")).toBe(
      "zcash:u1abc?amount=0.05",
    );
  });

  it("trims surrounding whitespace from address and amount", () => {
    expect(buildZcashPaymentUri("  u1abc  ", "  0.0001  ")).toBe(
      "zcash:u1abc?amount=0.0001",
    );
  });

  it("omits the amount when no price is provided", () => {
    expect(buildZcashPaymentUri("u1abc", "")).toBe("zcash:u1abc");
    expect(buildZcashPaymentUri("u1abc", null)).toBe("zcash:u1abc");
  });

  it("returns null when the address is missing", () => {
    expect(buildZcashPaymentUri("", "0.0001")).toBeNull();
    expect(buildZcashPaymentUri(null, "0.0001")).toBeNull();
    expect(buildZcashPaymentUri(undefined, "0.0001")).toBeNull();
  });
});
