import { NextResponse } from "next/server";

import { createServerErrorResponse } from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import {
  requireSellerFromRequest,
  rotateSellerAccessKey,
} from "../../../../../lib/server/seller-store";

// Rotating the access key is a sensitive, irreversible action (the old key dies
// instantly), so keep the limit tight — mirror the UFVK route's per-minute cap.
const RATE_LIMIT = { maxRequests: 6, windowMs: 60_000 };

// Recovery for a logged-in seller who lost their access key. Only the hash is
// stored, so the old key can't be re-shown — we mint a NEW key, replace the
// stored hash, and return the new plaintext exactly once. Authenticated via the
// session cookie (same mechanism as the other /api/sellers/me routes); rejects
// when there is no session.
export async function POST(request: Request) {
  const throttled = enforceRateLimit(
    request,
    "sellers/me/access-key",
    RATE_LIMIT,
  );
  if (throttled) return throttled;

  try {
    const seller = await requireSellerFromRequest(request);
    const { accessKey } = await rotateSellerAccessKey(seller.sellerId);
    return NextResponse.json({ accessKey });
  } catch (error) {
    return createServerErrorResponse("sellers/me/access-key", error);
  }
}
