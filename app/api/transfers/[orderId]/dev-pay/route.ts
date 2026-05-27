import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
} from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { markTransferPaidForDev } from "../../../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 };

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const throttled = enforceRateLimit(request, "transfers/dev-pay", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    if (
      process.env.NODE_ENV === "production" &&
      process.env.PAID_PRIVATE_FILE_ENABLE_DEV_PAY !== "1" &&
      process.env.ZECTIME_ENABLE_DEV_PAY !== "1"
    ) {
      throw new ServerError("validation", "Dev payment is disabled");
    }

    const { orderId } = await context.params;
    return NextResponse.json({ order: await markTransferPaidForDev(orderId) });
  } catch (error) {
    return createServerErrorResponse("transfers/dev-pay", error);
  }
}
