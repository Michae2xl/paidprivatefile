import { cookies } from "next/headers";

import { resolveProductLocale, type ProductSearchParams } from "../lib/locale";
import { getPaidPrivateFileCopy } from "../lib/paid-private-file-copy";
import { getSellerFromRequest } from "../lib/server/seller-store";
import { PaidPrivateFilePanel } from "./components/paid-private-file/paid-private-file-panel";

interface PageProps {
  searchParams?: ProductSearchParams;
}

export default async function Page({ searchParams }: PageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const locale = await resolveProductLocale(resolvedSearchParams);
  const copy = getPaidPrivateFileCopy(locale);
  const orderParam = resolvedSearchParams?.order;
  const initialOrderId = Array.isArray(orderParam) ? orderParam[0] : orderParam;

  // Resolve the seller session SERVER-SIDE from the cookie so the dashboard (or
  // the logged-out start screen) renders on the first paint — no loading splash
  // and no login flash on refresh. `undefined` (only on an unexpected failure)
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
      initialOrderId={initialOrderId}
      initialSeller={initialSeller}
      backHref="/"
      backLabel="Paid Private File"
    />
  );
}
