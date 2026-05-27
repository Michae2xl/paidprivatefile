import { NextResponse } from "next/server";

import { createServerErrorResponse } from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { readLimitedJsonObject } from "../../../../../lib/server/request-body";
import { claimTransfer } from "../../../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 12, windowMs: 60_000 };
const MAX_BODY_BYTES = 8_192;

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const throttled = enforceRateLimit(request, "transfers/claim", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const { orderId } = await context.params;
    const payload = await readLimitedJsonObject(request, MAX_BODY_BYTES);
    const buyerPublicKeyJwk = payload.buyerPublicKeyJwk as JsonWebKey;
    return NextResponse.json(await claimTransfer(orderId, buyerPublicKeyJwk));
  } catch (error) {
    return createServerErrorResponse("transfers/claim", error);
  }
}
