import {
  resolveProductLocale,
  type ProductSearchParams,
} from "../../../../../lib/locale";
import { getPaidPrivateFileCopy } from "../../../../../lib/paid-private-file-copy";
import { PaidPrivateFilePanel } from "../../../../components/paid-private-file/paid-private-file-panel";

interface SellerFilePageProps {
  params: Promise<{ handle: string; orderId: string }>;
  searchParams?: ProductSearchParams;
}

export default async function SellerFilePage({
  params,
  searchParams,
}: SellerFilePageProps) {
  const [{ handle, orderId }, locale] = await Promise.all([
    params,
    resolveProductLocale(searchParams),
  ]);
  const copy = getPaidPrivateFileCopy(locale);

  return (
    <PaidPrivateFilePanel
      locale={locale}
      copy={copy}
      initialOrderId={orderId}
      backHref={`/s/${handle}`}
      backLabel={`@${handle}`}
    />
  );
}
