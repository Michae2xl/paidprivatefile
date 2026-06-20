import { NextResponse } from "next/server";

import { createServerErrorResponse } from "../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../lib/server/rate-limit";
import { readLimitedJsonObject } from "../../../../lib/server/request-body";
import {
  requireSellerFromRequest,
  updateSellerProfile,
} from "../../../../lib/server/seller-store";

const RATE_LIMIT = { maxRequests: 20, windowMs: 60_000 };
const MAX_BODY_BYTES = 16 * 1024;

export async function GET(request: Request) {
  const throttled = enforceRateLimit(request, "sellers/me/read", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    return NextResponse.json({ seller: await requireSellerFromRequest(request) });
  } catch (error) {
    return createServerErrorResponse("sellers/me/read", error);
  }
}

export async function PATCH(request: Request) {
  const throttled = enforceRateLimit(request, "sellers/me/update", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const seller = await requireSellerFromRequest(request);
    const body = await readLimitedJsonObject(request, MAX_BODY_BYTES);
    const updated = await updateSellerProfile(seller.sellerId, {
      displayName:
        typeof body.displayName === "string" ? body.displayName : undefined,
      defaultPayoutAddress:
        typeof body.defaultPayoutAddress === "string"
          ? body.defaultPayoutAddress
          : undefined,
    });
    return NextResponse.json({ seller: updated });
  } catch (error) {
    return createServerErrorResponse("sellers/me/update", error);
  }
}
