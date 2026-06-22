import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
} from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { readLimitedJsonObject } from "../../../../../lib/server/request-body";
import {
  markTransferDelivered,
  type TransferDeliveredVia,
  type TransferPublicOrder,
} from "../../../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 12, windowMs: 60_000 };
const MAX_BODY_BYTES = 8_192;

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

interface DeliveredResponse {
  order: TransferPublicOrder;
}

// Pure-Nym delivery acknowledgement. The buyer POSTs this after it has decrypted
// + downloaded the file over the mixnet. The body carries ONLY the buyer public
// key (same shape as claim) — never any key material. The server verifies the key
// matches the confirmed payment, then flips the Nym session to "delivered" so the
// seller's re-send-until-acked loop can stop. The wrapped file key never reaches
// the server in this flow.
export async function POST(request: Request, context: RouteContext) {
  const { orderId } = await context.params;
  const throttled = enforceRateLimit(
    request,
    `transfers/delivered:${orderId}`,
    RATE_LIMIT,
  );
  if (throttled) return throttled;

  try {
    const payload = await readLimitedJsonObject(request, MAX_BODY_BYTES);
    const buyerPublicKeyJwk = requireJsonWebKey(payload.buyerPublicKeyJwk);
    const via = optionalDeliveredVia(payload.via);
    const order = await markTransferDelivered(orderId, buyerPublicKeyJwk, via);
    return NextResponse.json<DeliveredResponse>({ order });
  } catch (error) {
    return createServerErrorResponse("transfers/delivered", error);
  }
}

function requireJsonWebKey(value: unknown): JsonWebKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerError("validation", "buyerPublicKeyJwk must be an object");
  }
  return value as JsonWebKey;
}

// Optional delivery-path provenance: accept only "nym" or "https", or absent
// (undefined/null) which maps to null. Any other value is rejected so the field
// cannot be used to smuggle junk into stored order state.
function optionalDeliveredVia(value: unknown): TransferDeliveredVia | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (value === "nym" || value === "https") {
    return value;
  }
  throw new ServerError("validation", "via must be 'nym' or 'https'");
}
