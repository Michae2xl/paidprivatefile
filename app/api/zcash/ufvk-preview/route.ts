import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
} from "../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../lib/server/rate-limit";
import { readLimitedJsonObject } from "../../../../lib/server/request-body";
import { getScannerClient } from "../../../../lib/server/scanner-client";

const RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 };
const MAX_BODY_BYTES = 16 * 1024;

// Public, read-only preview: validate a pasted viewing key (UFVK) and return the
// derived receiving address so the seller sees it live while typing. It stores
// nothing and never echoes the key back.
export async function POST(request: Request) {
  const throttled = enforceRateLimit(request, "zcash/ufvk-preview", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const body = await readLimitedJsonObject(request, MAX_BODY_BYTES);
    const ufvk = typeof body.ufvk === "string" ? body.ufvk.trim() : "";
    if (!ufvk) {
      throw new ServerError("validation", "Missing required field: ufvk");
    }
    const ua =
      typeof body.ua === "string" && body.ua.trim()
        ? body.ua.trim()
        : undefined;

    const result = await getScannerClient().validateUfvk(
      ua ? { ufvk, ua } : { ufvk },
    );
    return NextResponse.json({
      valid: result.valid,
      network: result.network,
      defaultAddress: result.valid ? result.defaultAddress : null,
      fingerprint: result.valid ? result.fingerprint : null,
      uaMatches: result.uaMatches ?? null,
    });
  } catch (error) {
    return createServerErrorResponse("zcash/ufvk-preview", error);
  }
}
