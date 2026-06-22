import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
  type ServerErrorEnvelope,
} from "../../../lib/server/error-kinds";
import {
  createProduct,
  getPublicProduct,
  type ProductSupply,
} from "../../../lib/server/product-store";
import { enforceRateLimit } from "../../../lib/server/rate-limit";
import { requireSellerFromRequest } from "../../../lib/server/seller-store";

// Multi-buyer "product" model (Phase 1): a logged-in seller publishes a product
// (one catalog entry that many buyers can later purchase). Mirrors the create-
// order route (multipart upload, body cap, seller-held releaseSecretHash, the
// fileKey rejection) but is authenticated — only a seller may create a product.
// Phase 2 will spawn a per-buyer order from a product on purchase.
const RATE_LIMIT = { maxRequests: 8, windowMs: 60_000 };
const MAX_BODY_BYTES = 54 * 1024 * 1024;

function validationResponse(message: string, status = 400): NextResponse {
  return NextResponse.json<ServerErrorEnvelope>(
    { error: { kind: "validation", message } },
    { status },
  );
}

export async function POST(request: Request) {
  const throttled = enforceRateLimit(request, "products/create", RATE_LIMIT);
  if (throttled) return throttled;

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return validationResponse("Product upload is too large", 413);
  }

  try {
    // Authenticated: products are seller-owned, so require a logged-in seller.
    const seller = await requireSellerFromRequest(request);
    const form = await request.formData();

    const encryptedFile = form.get("encryptedFile");
    if (!(encryptedFile instanceof Blob)) {
      throw new ServerError("validation", "Missing encrypted file");
    }

    const sellerPayoutAddress =
      readFormString(form, "sellerPayoutAddress") ??
      seller.defaultPayoutAddress;
    if (!sellerPayoutAddress) {
      throw new ServerError(
        "validation",
        "Missing required field: sellerPayoutAddress",
      );
    }

    // Pure seller-held custody: the server must never receive the AES file key.
    if (form.has("fileKey")) {
      throw new ServerError(
        "validation",
        "fileKey is not accepted; this product is seller-held only",
      );
    }

    const product = await createProduct({
      encryptedFile: new Uint8Array(await encryptedFile.arrayBuffer()),
      fileName: readFormString(form, "fileName") ?? "private-file",
      mimeType:
        readFormString(form, "mimeType") ??
        encryptedFile.type ??
        "application/octet-stream",
      originalSizeBytes: readFormNumber(form, "originalSizeBytes"),
      encryptedFileSha256: requireFormString(form, "encryptedFileSha256"),
      encryptionIv: requireFormString(form, "encryptionIv"),
      releaseSecretHash: requireFormString(form, "releaseSecretHash"),
      amountZats: readFormNumber(form, "amountZats"),
      sellerPayoutAddress,
      sellerId: seller.sellerId,
      seller: {
        sellerId: seller.sellerId,
        handle: seller.handle,
        displayName: seller.displayName,
      },
      sellerNote: readFormString(form, "sellerNote"),
      supply: readSupply(form),
    });

    // Return the secret-stripped public projection straight from the store, so
    // the route and store never diverge and releaseSecretHash never reaches the
    // wire.
    const product_ = await getPublicProduct(product.productId);

    return NextResponse.json({
      product: product_,
      sharePath: `/s/${encodeURIComponent(
        seller.handle,
      )}/products/${encodeURIComponent(product.productId)}`,
    });
  } catch (error) {
    return createServerErrorResponse("products/create", error);
  }
}

function readSupply(form: FormData): ProductSupply {
  const mode = readFormString(form, "supplyMode") ?? "open";
  if (mode === "open") {
    return { mode: "open" };
  }
  if (mode === "limited") {
    const max = readFormNumber(form, "supplyMax");
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new ServerError(
        "validation",
        "Limited supply max must be a positive integer",
      );
    }
    return { mode: "limited", max };
  }
  throw new ServerError("validation", "supplyMode must be 'open' or 'limited'");
}

function requireFormString(form: FormData, name: string): string {
  const value = readFormString(form, name);
  if (!value) {
    throw new ServerError("validation", `Missing required field: ${name}`);
  }
  return value;
}

function readFormString(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function readFormNumber(form: FormData, name: string): number {
  const raw = requireFormString(form, name);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new ServerError("validation", `Invalid numeric field: ${name}`);
  }
  return parsed;
}
