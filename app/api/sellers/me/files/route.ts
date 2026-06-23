import { NextResponse } from "next/server";

import { createServerErrorResponse } from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { requireSellerFromRequest } from "../../../../../lib/server/seller-store";
import { listOrdersForSeller } from "../../../../../lib/server/transfer-store";

// Dashboard polls this list (~every 5s) plus mount/screen loads; cheap read.
const RATE_LIMIT = { maxRequests: 80, windowMs: 60_000 };

// Seller shop dashboard: list the authenticated seller's files (orders) as a
// compact summary the Dashboard / Files screens render. Buyer key material is
// already stripped by the public order shape; we expose only the fields the UI
// needs plus a share path back to the order.
export async function GET(request: Request) {
  const throttled = enforceRateLimit(request, "sellers/me/files", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const seller = await requireSellerFromRequest(request);
    const orders = await listOrdersForSeller(seller.sellerId);
    const files = orders.map((order) => ({
      orderId: order.orderId,
      fileName: order.file.fileName,
      displayZec: order.price.displayZec,
      status: order.status,
      // Multi-buyer "product" model (Phase 3b): the source product id when this
      // order is a purchase spawned from a catalog product, else null for a
      // single-use order. The dashboard groups purchases under their product and
      // delivers each one using the PRODUCT release draft + ciphertext (keyed by
      // productId), not the per-order draft (which a purchase never has). Safe to
      // expose: it is an opaque id, never key material.
      productId: order.productId,
      // Status-only delivery flag (no key material). The dashboard badge needs
      // it to show "Delivered" only after the buyer's pure-Nym ack, not the
      // moment the buyer merely claimed the ciphertext URL.
      nymSessionStatus: order.delivery.nymSession?.status ?? null,
      // Last buyer heartbeat (Nym session re-registration). The dashboard's
      // delivery queue uses its freshness to skip a buyer that has gone away so
      // an abandoned purchase never head-of-line-blocks the sequential queue.
      nymSessionUpdatedAt: order.delivery.nymSession?.updatedAt ?? null,
      // Provenance of a completed delivery: "nym" | "https" | null. Lets the
      // dashboard show how each order was delivered (pitch value). Null for
      // orders delivered before this field existed.
      deliveredVia: order.delivery.nymSession?.deliveredVia ?? null,
      createdAt: order.createdAt,
      sharePath: `/s/${encodeURIComponent(
        seller.handle,
      )}/files/${encodeURIComponent(order.orderId)}`,
    }));
    return NextResponse.json({ files });
  } catch (error) {
    return createServerErrorResponse("sellers/me/files", error);
  }
}
