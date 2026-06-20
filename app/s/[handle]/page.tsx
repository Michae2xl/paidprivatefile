import Link from "next/link";
import { notFound } from "next/navigation";

import {
  resolveProductLocale,
  type ProductSearchParams,
  withProductLocale,
} from "../../../lib/locale";
import { getPublicSellerProfileByHandle } from "../../../lib/server/seller-store";
import { listSellerTransferPublicOrders } from "../../../lib/server/transfer-store";

interface SellerPageProps {
  params: Promise<{ handle: string }>;
  searchParams?: ProductSearchParams;
}

export default async function SellerPage({
  params,
  searchParams,
}: SellerPageProps) {
  const [{ handle }, locale] = await Promise.all([
    params,
    resolveProductLocale(searchParams),
  ]);
  const seller = await getPublicSellerProfileByHandle(handle);
  if (!seller) {
    notFound();
  }
  const files = await listSellerTransferPublicOrders(seller.handle);

  return (
    <main className="page-shell product-shell zk-hub-shell zk-timestamp-shell zectime-paid-link-shell">
      <div className="background-grid" aria-hidden="true" />
      <header className="frame zk-hub-topbar surface-reveal">
        <div className="zk-hub-topbar-brand">
          <p className="eyebrow">Paid Private File</p>
          <Link className="zk-hub-topbar-back" href={withProductLocale("/", locale)}>
            Paid Private File
          </Link>
        </div>
      </header>

      <div className="zk-hub-body zectime-paid-body">
        <section className="frame zectime-paid-hero surface-reveal">
          <div>
            <p className="eyebrow">@{seller.handle}</p>
            <h1>{seller.displayName}</h1>
          </div>
          <p className="hero-copy">
            Private files sold in ZEC. Delivery unlocks through a private Nym
            session after payment.
          </p>
        </section>

        <section className="frame zectime-paid-panel zectime-seller-panel surface-reveal">
          <div className="zectime-paid-panel-copy">
            <p className="eyebrow">Files</p>
            <h2>Private file shelf</h2>
            <p>Choose a file, pay in ZEC, and open it locally after Nym delivery.</p>
          </div>

          <div className="zectime-seller-files">
            {files.length > 0 ? (
              files.map((file) => (
                <Link
                  key={file.orderId}
                  className="zectime-seller-file"
                  href={withProductLocale(
                    `/s/${seller.handle}/files/${file.orderId}`,
                    locale,
                  )}
                >
                  <span className="eyebrow">{file.price.displayZec} ZEC</span>
                  <strong>{file.file.fileName}</strong>
                  <span>{formatBytes(file.file.originalSizeBytes)}</span>
                </Link>
              ))
            ) : (
              <p className="zectime-paid-result">
                This seller has no public files yet.
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
