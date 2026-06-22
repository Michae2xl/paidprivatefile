// Multi-buyer "product" model (Phase 3b): pure, framework-free helpers for the
// SELLER's per-purchase delivery of catalog products.
//
// A product is sold to many buyers; each purchase is its own order carrying
// order.productId. The seller browser delivers every pending purchase over Nym
// using ONE shared product release draft + ciphertext (keyed by productId), not
// a per-order draft (a purchase never has one). Because all sends share the same
// ~46 KiB/s Nym gateway, running several concurrently would stall them all — so
// deliveries run SEQUENTIALLY: at most one in flight across every product, the
// next starts only after the current one settles (ack / fail / timeout).
//
// These helpers are extracted from the React panel so the selection + source
// logic can be unit-tested without a browser, IndexedDB, or the Nym client.

// The minimal shape of a dashboard "file" (order summary) this module needs.
// Mirrors the SellerFile rows the panel already holds, plus the productId added
// to the files API in Phase 3b.
export interface DeliverableSummary {
  orderId: string;
  // Source product id when this order is a purchase of a catalog product, else
  // null/undefined for a single-use order.
  productId?: string | null;
  // Order lifecycle status. Only paid/claimed orders are deliverable.
  status: "created" | "payment_pending" | "paid" | "claimed";
  // Pure-Nym delivery state. "delivered" means the buyer ACKed — nothing left to
  // do. Anything else (or absent) means the purchase still needs delivery.
  nymSessionStatus?: string | null;
}

// True when a summary is a PRODUCT purchase (has a productId). Single-use orders
// (no productId) are delivered with the per-order draft and are explicitly NOT
// handled by this queue.
export function isProductPurchase(summary: DeliverableSummary): boolean {
  return Boolean(summary.productId);
}

// True when a product purchase still needs delivery from this browser: it must
// be paid (or already claimed) and the buyer must not have ACKed yet
// ("delivered"). A single-use order (no productId) is never selected here.
export function isPurchasePendingDelivery(
  summary: DeliverableSummary,
): boolean {
  if (!isProductPurchase(summary)) {
    return false;
  }
  const paid = summary.status === "paid" || summary.status === "claimed";
  const delivered = summary.nymSessionStatus === "delivered";
  return paid && !delivered;
}

// Every product purchase that still needs delivery, oldest order id first for a
// stable, deterministic queue order (so the same purchase is attempted first on
// every tick rather than thrashing). Single-use orders are filtered out.
export function pendingPurchases(
  summaries: readonly DeliverableSummary[],
): DeliverableSummary[] {
  return summaries
    .filter(isPurchasePendingDelivery)
    .slice()
    .sort((left, right) => left.orderId.localeCompare(right.orderId));
}

// Sequential queue core: pick the single NEXT purchase to deliver.
//
//  - If a send is already in flight (inFlightOrderId set AND still pending), we
//    return null so the caller does not start a second concurrent transfer —
//    this is the one-at-a-time guarantee.
//  - Otherwise we return the first pending purchase whose release secret is held
//    by THIS browser (hasReleaseDraft), since only the creating browser can
//    deliver. Returns null when nothing is deliverable.
//
// `hasReleaseDraft(productId)` is injected so the pure helper never touches
// localStorage; the panel passes a closure over loadProductReleaseDraft.
export function selectNextPurchaseToDeliver(args: {
  summaries: readonly DeliverableSummary[];
  inFlightOrderId: string | null;
  hasReleaseDraft: (productId: string) => boolean;
}): DeliverableSummary | null {
  const pending = pendingPurchases(args.summaries);

  // One-at-a-time: if the in-flight order is still pending, hold the queue.
  if (
    args.inFlightOrderId &&
    pending.some((summary) => summary.orderId === args.inFlightOrderId)
  ) {
    return null;
  }

  for (const summary of pending) {
    // productId is guaranteed by isProductPurchase, but narrow for the type.
    if (summary.productId && args.hasReleaseDraft(summary.productId)) {
      return summary;
    }
  }
  return null;
}
