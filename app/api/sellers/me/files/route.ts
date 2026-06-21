import { NextResponse } from "next/server";

import { createServerErrorResponse } from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { requireSellerFromRequest } from "../../../../../lib/server/seller-store";
import { listOrdersForSeller } from "../../../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 20, windowMs: 60_000 };

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
