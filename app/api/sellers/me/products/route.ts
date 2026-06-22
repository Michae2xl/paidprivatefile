import { NextResponse } from "next/server";

import { createServerErrorResponse } from "../../../../../lib/server/error-kinds";
import { listProductsForSeller } from "../../../../../lib/server/product-store";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { requireSellerFromRequest } from "../../../../../lib/server/seller-store";

// Multi-buyer "product" model (Phase 3a): list the authenticated seller's
// PRODUCTS (catalog entries many buyers can purchase), as a compact summary the
// Dashboard Files screen renders alongside the single-use files. Mirrors
// /api/sellers/me/files (same auth, same generous polling-friendly rate limit).
// The store returns the secret-stripped PublicProduct, so releaseSecretHash and
// other secret material never reach the wire.
const RATE_LIMIT = { maxRequests: 80, windowMs: 60_000 };

export async function GET(request: Request) {
  const throttled = enforceRateLimit(
    request,
    "sellers/me/products",
    RATE_LIMIT,
  );
  if (throttled) return throttled;

  try {
    const seller = await requireSellerFromRequest(request);
    const products = await listProductsForSeller(seller.sellerId);
    const items = products.map((product) => ({
      productId: product.productId,
      fileName: product.file.fileName,
      displayZec: product.price.displayZec,
      status: product.status,
      supply: product.supply,
      salesCount: product.salesCount,
      remainingSupply: Number.isFinite(product.remainingSupply)
        ? product.remainingSupply
        : null,
      soldOut: product.soldOut,
      createdAt: product.createdAt,
      sharePath: `/s/${encodeURIComponent(
        seller.handle,
      )}/products/${encodeURIComponent(product.productId)}`,
    }));
    return NextResponse.json({ products: items });
  } catch (error) {
    return createServerErrorResponse("sellers/me/products", error);
  }
}
