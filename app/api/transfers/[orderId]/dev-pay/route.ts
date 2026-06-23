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
    // Production guard: dev-pay is OFF unless explicitly enabled. The legacy
    // ZECTIME_ENABLE_DEV_PAY escape hatch is removed — only the current,
    // documented flag can ever enable free payments, and only outside the default.
    if (
      process.env.NODE_ENV === "production" &&
      process.env.PAID_PRIVATE_FILE_ENABLE_DEV_PAY !== "1"
    ) {
      throw new ServerError("validation", "Dev payment is disabled");
    }

    const { orderId } = await context.params;
    return NextResponse.json({ order: await markTransferPaidForDev(orderId) });
  } catch (error) {
    return createServerErrorResponse("transfers/dev-pay", error);
  }
}
