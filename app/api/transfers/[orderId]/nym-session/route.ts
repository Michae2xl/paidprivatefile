import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
} from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { readLimitedJsonObject } from "../../../../../lib/server/request-body";
import {
  registerNymSessionForOrder,
  type TransferPublicOrder,
} from "../../../../../lib/server/transfer-store";

// The buyer's self-healing receiver re-registers its live Nym address on a
// ~8s heartbeat; give it headroom so a long session doesn't trip the limiter.
const RATE_LIMIT = { maxRequests: 40, windowMs: 60_000 };
const MAX_BODY_BYTES = 32 * 1024;

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

interface NymSessionResponse {
  order: TransferPublicOrder;
  nymSession: TransferPublicOrder["delivery"]["nymSession"];
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { orderId } = await context.params;
    // Per-ORDER rate limit. A global "transfers/nym-session" bucket is shared by
    // every buyer (behind a proxy the client key collapses to one), so at ~5
    // concurrent buyers their ~8s heartbeats saturate the 40/min budget and the
    // next buyer's re-registration 429s — the seller's delivery queue then sees a
    // stale address and skips that PAID buyer. Scoping by orderId gives each buyer
    // its own budget so concurrent buyers never collide.
    const throttled = enforceRateLimit(
      request,
      `transfers/nym-session:${orderId}`,
      RATE_LIMIT,
    );
    if (throttled) return throttled;

    const body = await readLimitedJsonObject(request, MAX_BODY_BYTES);
    const registered = await registerNymSessionForOrder(orderId, {
      buyerNymAddress: requireString(body.buyerNymAddress, "buyerNymAddress"),
      transport:
        body.transport === "nym-transfer-v1"
          ? "nym-transfer-v1"
          : "nym-claim-v1",
      buyerPublicKeyJwk: requireJsonWebKey(body.buyerPublicKeyJwk),
    });

    return NextResponse.json<NymSessionResponse>(registered);
  } catch (error) {
    return createServerErrorResponse("transfers/nym-session", error);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServerError("validation", `Missing required field: ${field}`);
  }
  return value;
}

function requireJsonWebKey(value: unknown): JsonWebKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerError("validation", "buyerPublicKeyJwk must be an object");
  }
  return value as JsonWebKey;
}
