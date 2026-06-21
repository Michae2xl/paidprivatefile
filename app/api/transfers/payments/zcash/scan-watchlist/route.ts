import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
} from "../../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../../lib/server/rate-limit";
import { readLimitedText } from "../../../../../../lib/server/request-body";
import { listScanWatchlistEntries } from "../../../../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 60, windowMs: 60_000 };
const MAX_BODY_BYTES = 16 * 1024;

// Non-custodial marketplace (Phase 1): the Rust scanner pulls this to learn
// which OPEN orders have a per-order UFVK binding. The response includes each
// seller's decrypted UFVK so the scanner can trial-decrypt — it is therefore
// HMAC-authenticated with the pool secret, exactly like the sibling watchlist.
export async function POST(request: Request) {
  const throttled = enforceRateLimit(
    request,
    "transfers/zcash-scan-watchlist",
    RATE_LIMIT,
  );
  if (throttled) return throttled;

  try {
    const rawBody = await readLimitedText(request, MAX_BODY_BYTES);
    verifyScanWatchlistSignature(request, rawBody);

    const entries = await listScanWatchlistEntries();
    return NextResponse.json({ entries });
  } catch (error) {
    return createServerErrorResponse("transfers/zcash-scan-watchlist", error);
  }
}

function verifyScanWatchlistSignature(request: Request, body: string): void {
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
