import { NextResponse } from "next/server";

import { createServerErrorResponse } from "../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../lib/server/rate-limit";
import { getTransferPublicOrder } from "../../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 60, windowMs: 60_000 };

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const throttled = enforceRateLimit(request, "transfers/read", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const { orderId } = await context.params;
    return NextResponse.json({ order: await getTransferPublicOrder(orderId) });
  } catch (error) {
    return createServerErrorResponse("transfers/read", error);
  }
}
