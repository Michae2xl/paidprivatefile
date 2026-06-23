import { afterEach, describe, expect, it, vi } from "vitest";

import { createCipherPayInvoice } from "../lib/server/cipherpay-client";
import { ServerError } from "../lib/server/error-kinds";

// #2 (critical-bug audit): with NO real payment rail configured, the marketplace
// must FAIL CLOSED in production rather than silently emitting a free, unsettleable
// "dev" invoice (honest payers never settle; a stray dev-pay flag = free files).
const INPUT = {
  orderId: "pl_aaaaaaaaaaaaaaaaaaaaaaaa",
  amountZats: 10_000,
  sellerPayoutAddress: "u1devpayoutaddressaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  buyerPublicKeyHash: "a".repeat(64),
  manifestRoot: "b".repeat(64),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createCipherPayInvoice fail-closed", () => {
  it("throws in production when no payment provider is configured (no free dev invoice)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Empty creds read as "unconfigured" by the client (falsy check).
    vi.stubEnv("CIPHERPAY_API_URL", "");
    vi.stubEnv("CIPHERPAY_API_KEY", "");
    await expect(createCipherPayInvoice(INPUT)).rejects.toBeInstanceOf(
      ServerError,
    );
  });

  it("falls back to a dev invoice OUTSIDE production (local/dev convenience)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CIPHERPAY_API_URL", "");
    vi.stubEnv("CIPHERPAY_API_KEY", "");
    const invoice = await createCipherPayInvoice(INPUT);
    expect(invoice.provider).toBe("dev");
    expect(invoice.paymentAddress).toBe(INPUT.sellerPayoutAddress);
  });
});
