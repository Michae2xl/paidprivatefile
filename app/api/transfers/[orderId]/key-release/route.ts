import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
} from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { readLimitedJsonObject } from "../../../../../lib/server/request-body";
import {
  getTransferReleaseChallenge,
  releaseTransferKey,
  type TransferKeyEnvelope,
} from "../../../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 12, windowMs: 60_000 };
const MAX_BODY_BYTES = 16 * 1024;

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const { orderId } = await context.params;
  const throttled = enforceRateLimit(
    request,
    `transfers/key-release:${orderId}`,
    RATE_LIMIT,
  );
  if (throttled) return throttled;

  try {
    const body = await readLimitedJsonObject(request, MAX_BODY_BYTES);
    const action = typeof body.action === "string" ? body.action : "status";
    const releaseSecret = requireString(body.releaseSecret, "releaseSecret");

    if (action === "release") {
      const keyEnvelope = requireKeyEnvelope(body.keyEnvelope);
      return NextResponse.json(
        await releaseTransferKey({ orderId, releaseSecret, keyEnvelope }),
      );
    }

    return NextResponse.json(
      await getTransferReleaseChallenge(orderId, releaseSecret),
    );
  } catch (error) {
    return createServerErrorResponse("transfers/key-release", error);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServerError("validation", `Missing required field: ${field}`);
  }
  return value;
}

function requireKeyEnvelope(value: unknown): TransferKeyEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerError("validation", "keyEnvelope must be an object");
  }
  return value as TransferKeyEnvelope;
}
