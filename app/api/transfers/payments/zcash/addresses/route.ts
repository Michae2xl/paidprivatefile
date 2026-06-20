import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { registerDepositAddresses } from "../../../../../../lib/server/deposit-pool";
import {
  createServerErrorResponse,
  ServerError,
} from "../../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../../lib/server/rate-limit";
import { readLimitedText } from "../../../../../../lib/server/request-body";

const RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 };
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
  const throttled = enforceRateLimit(
    request,
    "transfers/zcash-pool",
    RATE_LIMIT,
  );
  if (throttled) return throttled;

  try {
    const rawBody = await readLimitedText(request, MAX_BODY_BYTES);
    verifyPoolSignature(request, rawBody);

    const parsed = JSON.parse(rawBody) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new ServerError(
        "validation",
        "Deposit-address registration body must be an object",
      );
    }
    const addresses = (parsed as Record<string, unknown>).addresses;
    if (!Array.isArray(addresses)) {
      throw new ServerError("validation", "addresses must be an array");
    }

    const result = await registerDepositAddresses(addresses as string[]);
    return NextResponse.json(result);
  } catch (error) {
    return createServerErrorResponse("transfers/zcash-pool", error);
  }
}

function verifyPoolSignature(request: Request, body: string): void {
  const secret = process.env.PAID_PRIVATE_FILE_ZCASH_POOL_SECRET;
  if (!secret) {
    throw new ServerError(
      "validation",
      "Deposit-address registration is not configured",
    );
  }

  const provided = request.headers.get("x-zcash-signature") ?? "";
  const normalized = provided.replace(/^sha256=/iu, "").trim();
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  if (!safeEqual(normalized, expected)) {
    throw new ServerError(
      "validation",
      "Invalid deposit-address registration signature",
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
