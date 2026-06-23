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
  // ISO timestamp of the buyer's last Nym session registration (diagnostic only).
  nymSessionUpdatedAt?: string | null;
  // SERVER-COMPUTED age (ms) of the buyer's last Nym session registration:
  // serverNow - nymSession.updatedAt, both on the server clock. The buyer
  // heartbeat re-registers every ~8s, so a large age means the buyer has gone
  // away (closed tab). Used to skip absent buyers so an abandoned purchase never
  // head-of-line-blocks the queue. Server-relative ON PURPOSE: comparing the
  // seller browser's Date.now() against a server timestamp would wrongly skip a
  // present buyer under clock skew. Null when never registered.
  nymSessionAgeMs?: number | null;
  // Buyer-reported file bytes received so far. The queue watches this for
  // ADVANCEMENT (tracked by the caller across ticks) to demote a present-but-
  // stuck buyer without penalizing a slow-but-progressing one.
  nymSessionReceivedBytes?: number | null;
}

// A buyer is PRESENT if its Nym session was (re)registered within this window.
// The heartbeat fires ~every 8s, so a buyer unseen for ~40s (≈5 missed beats)
// has almost certainly closed its tab.
export const BUYER_PRESENCE_STALE_MS = 40_000;

// True when the buyer for this purchase is still present (recent heartbeat). Uses
// the SERVER-computed age (single clock) — never the seller's local clock — so
// clock skew on the seller's machine can't wrongly skip a present, paying buyer.
// A purchase with no nymSession yet is NOT present (no address to deliver to).
export function isBuyerPresent(
  summary: DeliverableSummary,
  staleMs: number = BUYER_PRESENCE_STALE_MS,
): boolean {
  const ageMs = summary.nymSessionAgeMs;
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) {
    return false;
  }
  // Negative age = server-side skew between the write and the read; treat as
  // fresh (the buyer just registered).
  return ageMs <= staleMs;
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
  // Optional presence gate: skip a pending purchase whose buyer has gone away
  // (no recent heartbeat) so an abandoned tab never head-of-line-blocks the
  // queue. When omitted, every purchase is treated as present (back-compat).
  isBuyerPresent?: (summary: DeliverableSummary) => boolean;
  // Optional demotion gate: a buyer that is PRESENT (heartbeating) but STUCK
  // (received-bytes not advancing) is rotated to the back so the buyers behind it
  // get served; it is still retried when it is the only candidate left. The
  // caller decides "stuck" by tracking received-bytes advancement across ticks,
  // so a slow-but-progressing buyer is never demoted. Omitted = nobody demoted.
  isDeprioritized?: (summary: DeliverableSummary) => boolean;
}): DeliverableSummary | null {
  const pending = pendingPurchases(args.summaries);

  // One-at-a-time: if the in-flight order is still pending, hold the queue.
  if (
    args.inFlightOrderId &&
    pending.some((summary) => summary.orderId === args.inFlightOrderId)
  ) {
    return null;
  }

  const deliverable = pending.filter(
    (summary) =>
      // productId is guaranteed by isProductPurchase, but narrow for the type.
      Boolean(summary.productId) &&
      args.hasReleaseDraft(summary.productId as string) &&
      // Skip an absent buyer (gone tab) so it doesn't block the queue.
      (!args.isBuyerPresent || args.isBuyerPresent(summary)),
  );
  if (deliverable.length === 0) {
    return null;
  }
  // Prefer a non-stuck buyer; fall back to the first deliverable (retry the
  // stuck one) only when every candidate is deprioritized.
  if (args.isDeprioritized) {
    const fresh = deliverable.find(
      (summary) => !args.isDeprioritized?.(summary),
    );
    if (fresh) {
      return fresh;
    }
  }
  return deliverable[0];
}
