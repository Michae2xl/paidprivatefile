// The seller dashboard "YOUR FILES" list and the manage screen both render a
// per-file status label off a single pure mapper, formatFileStatus(status, copy).
// These tests pin each summary status to its dashboard copy key (notably: "paid"
// maps to the "ready to deliver" label, the seller's cue to release the key), and
// that an unknown status falls back to "Created". No React is involved.

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
    statusClaimed: "CLAIMED",
  },
} as unknown as PaidPrivateFileCopy;

describe("formatFileStatus", () => {
  it("maps 'created' to the created label", () => {
    expect(formatFileStatus("created", copy)).toBe("CREATED");
  });

  it("maps 'payment_pending' to the awaiting-payment label", () => {
    expect(formatFileStatus("payment_pending", copy)).toBe("PENDING");
  });

  it("maps 'paid' to the ready-to-deliver label (not the bare 'Paid')", () => {
    expect(formatFileStatus("paid", copy)).toBe("PAID_READY");
  });

  it("maps 'claimed' to the delivered label", () => {
    expect(formatFileStatus("claimed", copy)).toBe("CLAIMED");
  });

  it("falls back to the created label for an unknown status", () => {
    expect(
      formatFileStatus("weird" as Parameters<typeof formatFileStatus>[0], copy),
    ).toBe("CREATED");
  });
});
