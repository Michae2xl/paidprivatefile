import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
  type ServerErrorEnvelope,
} from "../../../../../lib/server/error-kinds";
import { spawnOrderFromProduct } from "../../../../../lib/server/product-store";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { type TransferPublicOrder } from "../../../../../lib/server/transfer-store";

// Public purchase endpoint (no auth): a buyer initiates a purchase of a catalog
// product. This spawns a FRESH per-buyer order (own per-order deposit address +
// Nym session), so multiple buyers never collide. The client then drives the
// EXISTING order flow (register Nym session + pay + receive) against
// order.orderId. Rate-limited like create-order — each call mints a new order.
//
// Sold-out handling: spawnOrderFromProduct reserves a unit for a limited product
// BEFORE creating the order; a sold-out product rejects with a "flow_conflict"
// ServerError (HTTP 409) and no order is ever created.
const RATE_LIMIT = { maxRequests: 8, windowMs: 60_000 };

interface RouteContext {
  params: Promise<{ productId: string }>;
}

interface PurchaseResponse {
  order: TransferPublicOrder;
}

export async function POST(request: Request, context: RouteContext) {
  const throttled = enforceRateLimit(request, "products/purchase", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const { productId } = await context.params;
    const order = await spawnOrderFromProduct(productId);
    return NextResponse.json<PurchaseResponse>({ order });
  } catch (error) {
    // Map an unknown/malformed product id to a 404 so a buyer hitting a dead
    // product link gets the honest status. Any other ServerError (e.g.
    // "sold out" flow_conflict -> 409) flows through the standard handler.
    if (
      error instanceof ServerError &&
      error.kind === "validation" &&
      error.message === "Product not found"
    ) {
      return NextResponse.json<ServerErrorEnvelope>(
        { error: { kind: "validation", message: "Product not found" } },
        { status: 404 },
      );
    }
    return createServerErrorResponse("products/purchase", error);
  }
}
