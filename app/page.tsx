import {
  resolveProductLocale,
  type ProductSearchParams,
} from "../lib/locale";
import { getPaidPrivateFileCopy } from "../lib/paid-private-file-copy";
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

  return (
    <PaidPrivateFilePanel
      locale={locale}
      copy={copy}
      initialOrderId={initialOrderId}
      backHref="/"
      backLabel="Paid Private File"
    />
  );
}
