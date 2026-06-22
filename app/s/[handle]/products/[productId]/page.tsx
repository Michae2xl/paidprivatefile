import { cookies } from "next/headers";

import {
  resolveProductLocale,
  type ProductSearchParams,
} from "../../../../../lib/locale";
import { getPaidPrivateFileCopy } from "../../../../../lib/paid-private-file-copy";
import { getSellerFromRequest } from "../../../../../lib/server/seller-store";
import { PaidPrivateFilePanel } from "../../../../components/paid-private-file/paid-private-file-panel";

// Multi-buyer "product" model (Phase 3b): the BUYER product page. A buyer opens
// this link to purchase a catalog product; the panel (with initialProductId)
// fetches the listing and, on Buy, spawns a fresh per-buyer order and drives the
// existing pay/receive flow. Mirrors the single-use order page
// (files/[orderId]/page.tsx) including the SSR initialSeller resolution so the
// seller's own dashboard does not flash. The panel itself gates the product view
// on productsEnabled(); with the flag off it falls back to the start screen.
interface SellerProductPageProps {
  params: Promise<{ handle: string; productId: string }>;
  searchParams?: ProductSearchParams;
}

export default async function SellerProductPage({
  params,
  searchParams,
}: SellerProductPageProps) {
  const [{ handle, productId }, locale] = await Promise.all([
    params,
    resolveProductLocale(searchParams),
  ]);
  const copy = getPaidPrivateFileCopy(locale);

  // Resolve the seller session SERVER-SIDE from the cookie so the first paint is
  // correct (same pattern as app/page.tsx). `undefined` on an unexpected failure
  // makes the panel fall back to a client-side check.
  let initialSeller:
    | Awaited<ReturnType<typeof getSellerFromRequest>>
    | undefined;
  try {
    const cookieStore = await cookies();
    initialSeller = await getSellerFromRequest(
      new Request("https://internal.invalid/", {
        headers: { cookie: cookieStore.toString() },
      }),
    );
  } catch {
    initialSeller = undefined;
  }

  return (
    <PaidPrivateFilePanel
      locale={locale}
      copy={copy}
      initialProductId={productId}
      initialSeller={initialSeller}
      backHref={`/s/${handle}`}
      backLabel={`@${handle}`}
    />
  );
}
