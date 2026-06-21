import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
} from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { readLimitedJsonObject } from "../../../../../lib/server/request-body";
import {
  registerSellerUfvk,
  requireSellerFromRequest,
} from "../../../../../lib/server/seller-store";

const RATE_LIMIT = { maxRequests: 6, windowMs: 60_000 };
const MAX_BODY_BYTES = 16 * 1024;

// Non-custodial marketplace (Phase 1): a logged-in seller registers a pasted
// viewing key (UFVK), optionally bound to a unified address. The store
// validates it via the scanner, rejects invalid / non-mainnet keys and
// non-matching UAs, and stores it encrypted. We return only the fingerprint,
// network, and the scanner-reported default address (for the confirmation UI).
// The UFVK itself is NEVER echoed back.
export async function POST(request: Request) {
  const throttled = enforceRateLimit(request, "sellers/me/ufvk", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const seller = await requireSellerFromRequest(request);
    const body = await readLimitedJsonObject(request, MAX_BODY_BYTES);
    const ufvk = requireString(body.ufvk, "ufvk");
    const ua = typeof body.ua === "string" && body.ua.trim() ? body.ua : null;

    const result = await registerSellerUfvk(seller.sellerId, { ufvk, ua });
    return NextResponse.json(result);
  } catch (error) {
    return createServerErrorResponse("sellers/me/ufvk", error);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ServerError("validation", `Missing required field: ${field}`);
  }
  return value;
}
