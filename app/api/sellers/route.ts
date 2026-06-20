import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
} from "../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../lib/server/rate-limit";
import { readLimitedJsonObject } from "../../../lib/server/request-body";
import {
  createSellerProfile,
  createSellerSessionToken,
  SELLER_SESSION_COOKIE,
} from "../../../lib/server/seller-store";

const RATE_LIMIT = { maxRequests: 6, windowMs: 60_000 };
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request) {
  const throttled = enforceRateLimit(request, "sellers/create", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const body = await readLimitedJsonObject(request, MAX_BODY_BYTES);
    const created = await createSellerProfile({
      handle: requireString(body.handle, "handle"),
      displayName:
        typeof body.displayName === "string" ? body.displayName : undefined,
      defaultPayoutAddress: requireString(
        body.defaultPayoutAddress,
        "defaultPayoutAddress",
      ),
    });
    const response = NextResponse.json(created, {
      status: 201,
      headers: { Location: created.seller.publicPath },
    });
    response.cookies.set({
      name: SELLER_SESSION_COOKIE,
      value: createSellerSessionToken(created.seller.sellerId),
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (error) {
    return createServerErrorResponse("sellers/create", error);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ServerError("validation", `Missing required field: ${field}`);
  }
  return value;
}
