// Multi-buyer "file" model: a COMPACT aggregate of a file's purchases for the
// seller dashboard. Instead of one row per purchase, each file row shows a single
// summary line — total purchases, how many were delivered (buyer ACKed over Nym),
// and how many are still in progress (paid/claimed but not yet acked).
//
// Pure + framework-free so it can be unit-tested without React or the browser.

// The minimal shape of a purchase (an order summary carrying a productId) this
// module needs. Mirrors the SellerFile rows the panel already holds.
export interface PurchaseSummaryInput {
  // Order lifecycle status. Only paid/claimed orders count as "in progress"
  // (toward delivery); a payment_pending order is still merely "awaiting".
  status: "created" | "payment_pending" | "paid" | "claimed";
  // Pure-Nym delivery state. "delivered" means the buyer ACKed — the purchase is
  // done. Anything else (or absent) means it is not delivered yet.
  nymSessionStatus?: string | null;
}

// The aggregate counts rendered on a single file row.
export interface PurchaseCounts {
  // Every purchase of the file, regardless of status.
  total: number;
  // Purchases the buyer has ACKed over Nym (nymSessionStatus === "delivered").
  delivered: number;
  // Paid/claimed purchases whose key is in flight but not yet acked.
  inProgress: number;
  // Purchases still awaiting payment (payment_pending / created) — neither
  // delivered nor in progress. Surfaced for completeness; the dashboard line
  // focuses on delivered + inProgress.
  awaiting: number;
}

// A purchase is DELIVERED only when the buyer acked over Nym. This mirrors the
// honest "Delivered" rule used by formatFileStatus.
function isDelivered(purchase: PurchaseSummaryInput): boolean {
  return purchase.nymSessionStatus === "delivered";
}

// A purchase is IN PROGRESS when it is paid (or already claimed) but the buyer
// has not yet acked — i.e. the key/file is on its way over Nym.
function isInProgress(purchase: PurchaseSummaryInput): boolean {
  const paid = purchase.status === "paid" || purchase.status === "claimed";
  return paid && !isDelivered(purchase);
}

// Compute the compact counts from a file's purchase list. Each purchase falls
// into exactly one of delivered / inProgress / awaiting, so the three always sum
// to total.
export function computePurchaseCounts(
  purchases: readonly PurchaseSummaryInput[],
): PurchaseCounts {
  let delivered = 0;
  let inProgress = 0;
  let awaiting = 0;
  for (const purchase of purchases) {
    if (isDelivered(purchase)) {
      delivered += 1;
    } else if (isInProgress(purchase)) {
      inProgress += 1;
    } else {
      awaiting += 1;
    }
  }
  return { total: purchases.length, delivered, inProgress, awaiting };
}

// Render the single compact summary line for a file row from its counts + copy.
// Examples (en):
//  - all done:  "2/2 delivered"
//  - mixed:     "1/3 delivered · 2 in progress"
//  - none done: "0/3 delivered · 3 in progress"
// The inProgress clause is appended only when there is at least one in-progress
// purchase. Returns an empty string when there are no purchases at all (the
// caller shows its empty-state copy instead).
export function formatPurchaseSummary(
  counts: PurchaseCounts,
  copy: { deliveredSummary: string; inProgressSuffix: string },
): string {
  if (counts.total === 0) {
    return "";
  }
  let line = copy.deliveredSummary
    .replace("{count}", String(counts.delivered))
    .replace("{total}", String(counts.total));
  if (counts.inProgress > 0) {
    line += copy.inProgressSuffix.replace(
      "{inProgress}",
      String(counts.inProgress),
    );
  }
  return line;
}
