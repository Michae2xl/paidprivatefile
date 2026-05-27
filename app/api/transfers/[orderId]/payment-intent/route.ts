import { NextResponse } from "next/server";

import { createServerErrorResponse } from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { readLimitedJsonObject } from "../../../../../lib/server/request-body";
import { createPaymentIntentForOrder } from "../../../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 12, windowMs: 60_000 };
const MAX_BODY_BYTES = 8_192;

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const throttled = enforceRateLimit(request, "transfers/payment", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const { orderId } = await context.params;
    const payload = await readLimitedJsonObject(request, MAX_BODY_BYTES);
    const buyerPublicKeyJwk = payload.buyerPublicKeyJwk as JsonWebKey;
    const successUrl =
      typeof payload.successUrl === "string" ? payload.successUrl : undefined;
    const result = await createPaymentIntentForOrder(
      orderId,
      buyerPublicKeyJwk,
      successUrl,
    );
    return NextResponse.json(result);
  } catch (error) {
    return createServerErrorResponse("transfers/payment", error);
  }
}
