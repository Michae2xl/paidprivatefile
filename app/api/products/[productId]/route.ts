import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
  type ServerErrorEnvelope,
} from "../../../../lib/server/error-kinds";
import { getPublicProduct } from "../../../../lib/server/product-store";
import { enforceRateLimit } from "../../../../lib/server/rate-limit";

// Public read endpoint (no auth): a buyer loads a product before purchasing.
// Returns the secret-stripped PublicProduct (releaseSecretHash never reaches the
// wire). Generous limit because a buyer page polls supply/sold-out cheaply,
// mirroring the transfers read endpoint.
const RATE_LIMIT = { maxRequests: 240, windowMs: 60_000 };

interface RouteContext {
  params: Promise<{ productId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const throttled = enforceRateLimit(request, "products/read", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const { productId } = await context.params;
    return NextResponse.json({ product: await getPublicProduct(productId) });
  } catch (error) {
    // The store reports both an unknown product and a malformed id as a
    // "validation" ServerError. For a public GET-by-id, "not found" is the
    // honest, RESTful response, so surface those as 404 while letting any other
    // error fall through to the standard handler.
    if (error instanceof ServerError && error.kind === "validation") {
      return NextResponse.json<ServerErrorEnvelope>(
        { error: { kind: "validation", message: "Product not found" } },
        { status: 404 },
      );
    }
    return createServerErrorResponse("products/read", error);
  }
}
