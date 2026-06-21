import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { listAssignedDepositAddresses } from "../../../../../../lib/server/deposit-pool";
import {
  createServerErrorResponse,
  ServerError,
} from "../../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../../lib/server/rate-limit";
import { readLimitedText } from "../../../../../../lib/server/request-body";

const RATE_LIMIT = { maxRequests: 60, windowMs: 60_000 };
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request) {
  const throttled = enforceRateLimit(
    request,
    "transfers/zcash-watchlist",
    RATE_LIMIT,
  );
  if (throttled) return throttled;

  try {
    const rawBody = await readLimitedText(request, MAX_BODY_BYTES);
    verifyWatchlistSignature(request, rawBody);

    const addresses = await listAssignedDepositAddresses();
    return NextResponse.json({ addresses });
  } catch (error) {
    return createServerErrorResponse("transfers/zcash-watchlist", error);
  }
}

function verifyWatchlistSignature(request: Request, body: string): void {
  const secret = process.env.PAID_PRIVATE_FILE_ZCASH_POOL_SECRET;
  if (!secret) {
    throw new ServerError(
      "validation",
      "Deposit-address watchlist is not configured",
    );
  }

  const provided = request.headers.get("x-zcash-signature") ?? "";
  const normalized = provided.replace(/^sha256=/iu, "").trim();
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  if (!safeEqual(normalized, expected)) {
    throw new ServerError(
      "validation",
      "Invalid deposit-address watchlist signature",
    );
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
