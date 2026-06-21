import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
} from "../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../lib/server/rate-limit";
import { readLimitedJsonObject } from "../../../lib/server/request-body";
import {
  authenticateSeller,
  createSellerSessionToken,
  getSellerFromRequest,
  SELLER_SESSION_COOKIE,
} from "../../../lib/server/seller-store";

const RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 };
const MAX_BODY_BYTES = 16 * 1024;

export async function GET(request: Request) {
  const throttled = enforceRateLimit(
    request,
    "seller-session/read",
    RATE_LIMIT,
  );
  if (throttled) return throttled;

  try {
    return NextResponse.json({ seller: await getSellerFromRequest(request) });
  } catch (error) {
    return createServerErrorResponse("seller-session/read", error);
  }
}

export async function POST(request: Request) {
  const throttled = enforceRateLimit(
    request,
    "seller-session/login",
    RATE_LIMIT,
  );
  if (throttled) return throttled;

  try {
    const body = await readLimitedJsonObject(request, MAX_BODY_BYTES);
    const accessKey = requireString(body.accessKey, "accessKey");
    const handle =
      typeof body.handle === "string" && body.handle.trim()
        ? body.handle
        : undefined;
    const seller = await authenticateSeller({ handle, accessKey });
    const response = NextResponse.json({ seller });
    response.cookies.set({
      name: SELLER_SESSION_COOKIE,
      value: createSellerSessionToken(seller.sellerId),
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (error) {
    return createServerErrorResponse("seller-session/login", error);
  }
}

export async function DELETE(request: Request) {
  const throttled = enforceRateLimit(
    request,
    "seller-session/logout",
    RATE_LIMIT,
  );
  if (throttled) return throttled;

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SELLER_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ServerError("validation", `Missing required field: ${field}`);
  }
  return value;
}
