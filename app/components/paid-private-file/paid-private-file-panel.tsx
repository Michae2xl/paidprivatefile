"use client";

import Link from "next/link";
import {
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import {
  createPaidLinkBuyerKeyPair,
  decryptPaidLinkFile,
  decryptPaidLinkFileKey,
  encryptPaidLinkFile,
  loadBuyerKeyPair,
  saveBuyerKeyPair,
  type PaidLinkBuyerKeyPair,
  type PaidLinkKeyEnvelope,
} from "../../../lib/paid-link-client-crypto";
import { extractServerErrorMessage } from "../../../lib/server-error-message";
import { createClientTimestampDraft } from "../../../lib/timestamp-client-crypto";
import type { ProductLocale } from "../../../lib/types";
import { withProductLocale } from "../../../lib/locale";
import type { PaidPrivateFileCopy } from "../../../lib/paid-private-file-copy";
import { ProductLocaleToggle } from "../locale/product-locale-toggle";

interface PaidPrivateFilePanelProps {
  locale: ProductLocale;
  copy: PaidPrivateFileCopy;
  initialOrderId?: string | null;
  backHref?: string;
  backLabel?: string;
}

interface TransferPublicOrder {
  orderId: string;
  status: "created" | "payment_pending" | "paid" | "claimed";
  createdAt: string;
  updatedAt: string;
  file: {
    fileName: string;
    mimeType: string;
    originalSizeBytes: number;
    encryptedSizeBytes: number;
    encryptedFileSha256: string;
    encryptionScheme: "aes-256-gcm-v1";
    encryptionIv: string;
  };
  price: {
    asset: "ZEC";
    amountZats: number;
    displayZec: string;
  };
  sellerPayoutAddress: string;
  sellerNote: string | null;
  timestamp: {
    commitmentScheme: string | null;
    commitment: string;
    blockHeight: number;
  } | null;
  manifestRoot: string;
  payment: TransferPayment | null;
  delivery: {
    requiredTransport: "nym-claim-v1" | "nym-transfer-v1";
    fallbackHttpDownload: false;
    nymSession: {
      transport: "nym-claim-v1" | "nym-transfer-v1";
      buyerNymAddress: string;
      status: "waiting_for_payment" | "ready_for_delivery" | "queued";
      createdAt: string;
      updatedAt: string;
    } | null;
  };
}

interface TransferPayment {
  provider: "cipherpay" | "dev";
  invoiceId: string;
  checkoutUrl: string | null;
  paymentAddress: string | null;
  memo: string | null;
  status: "pending" | "paid";
  createdAt?: string;
  confirmedAt?: string | null;
}

interface PaymentIntentResponse {
  order: TransferPublicOrder;
  payment: TransferPayment;
}

interface CreateTransferResponse {
  order: TransferPublicOrder;
  sharePath: string;
}

interface ClaimResponse {
  order: TransferPublicOrder;
  keyEnvelope: PaidLinkKeyEnvelope;
  download: {
    url: string;
    expiresAt: string;
  };
  nymDelivery: {
    deliveryId: string;
    transport: "nym-claim-v1" | "nym-transfer-v1";
    status: "queued_local_outbox";
    queuedAt: string;
  };
}

type Mode = "send" | "receive";
type BusyAction =
  | "idle"
  | "encrypting"
  | "loading"
  | "payment"
  | "unlocking";

export function PaidPrivateFilePanel({
  locale,
  copy,
  initialOrderId,
  backHref = "/",
  backLabel,
}: PaidPrivateFilePanelProps) {
  const [mode, setMode] = useState<Mode>(initialOrderId ? "receive" : "send");
  const [busyAction, setBusyAction] = useState<BusyAction>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [priceZec, setPriceZec] = useState("0.05");
  const [sellerPayoutAddress, setSellerPayoutAddress] = useState("");
  const [sellerNote, setSellerNote] = useState("");
  const [createdOrder, setCreatedOrder] = useState<TransferPublicOrder | null>(
    null,
  );
  const [shareUrl, setShareUrl] = useState("");
  const [orderInput, setOrderInput] = useState(initialOrderId ?? "");
  const [loadedOrder, setLoadedOrder] = useState<TransferPublicOrder | null>(
    null,
  );
  const [payment, setPayment] = useState<TransferPayment | null>(null);
  const [buyerNymAddress, setBuyerNymAddress] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadFileName, setDownloadFileName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    if (!initialOrderId) {
      return;
    }
    void loadOrder(initialOrderId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOrderId]);

  useEffect(() => {
    return () => {
      if (downloadUrl) {
        window.URL.revokeObjectURL(downloadUrl);
      }
    };
  }, [downloadUrl]);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }

  async function onCreateLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");
    setCreatedOrder(null);
    setShareUrl("");

    if (!file) {
      setErrorMessage(copy.errors.missingFile);
      return;
    }

    let amountZats: number;
    try {
      amountZats = parseZecToZats(priceZec);
    } catch {
      setErrorMessage(copy.errors.invalidPrice);
      return;
    }

    if (!isLikelyZcashUnifiedAddress(sellerPayoutAddress)) {
      setErrorMessage(copy.errors.invalidPayoutAddress);
      return;
    }

    setBusyAction("encrypting");
    try {
      const timestampDraft = await createClientTimestampDraft(file);
      const encrypted = await encryptPaidLinkFile(file);
      const form = new FormData();
      form.set("encryptedFile", encrypted.encryptedFile, `${file.name}.enc`);
      form.set("fileName", file.name);
      form.set("mimeType", file.type || "application/octet-stream");
      form.set("originalSizeBytes", String(file.size));
      form.set("encryptedFileSha256", encrypted.encryptedFileSha256);
      form.set("encryptionIv", encrypted.encryptionIv);
      form.set("fileKey", encrypted.fileKey);
      form.set("amountZats", String(amountZats));
      form.set("sellerPayoutAddress", sellerPayoutAddress.trim());
      form.set("sellerNote", sellerNote);
      form.set("timestampReceiptJson", JSON.stringify(timestampDraft.receipt));

      const body = await postJson<CreateTransferResponse>("/api/transfers", {
        method: "POST",
        body: form,
      });
      const href = new URL(
        withProductLocale(
          `/paid-private-file?order=${body.order.orderId}`,
          locale,
        ),
        window.location.origin,
      ).toString();
      setCreatedOrder(body.order);
      setShareUrl(href);
      setOrderInput(body.order.orderId);
      setLoadedOrder(body.order);
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  async function onLoadOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const orderId = extractOrderId(orderInput);
    if (!orderId) {
      setErrorMessage(copy.errors.missingOrder);
      return;
    }
    await loadOrder(orderId);
  }

  async function loadOrder(orderId: string) {
    setErrorMessage("");
    setBusyAction("loading");
    setDownloadUrl("");
    setDownloadFileName("");

    try {
      const body = await postJson<{ order: TransferPublicOrder }>(
        `/api/transfers/${encodeURIComponent(orderId)}`,
        { method: "GET" },
      );
      setLoadedOrder(body.order);
      setPayment(body.order.payment);
      setOrderInput(orderId);
      setMode("receive");
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  async function onCreatePayment() {
    if (!loadedOrder) {
      return;
    }

    setErrorMessage("");
    setBusyAction("payment");
    try {
      const keyPair = await getOrCreateBuyerKeyPair(loadedOrder.orderId);
      if (!buyerNymAddress.trim()) {
        throw new Error(copy.errors.missingNymAddress);
      }
      await postJson<{ order: TransferPublicOrder }>(
        `/api/transfers/${encodeURIComponent(loadedOrder.orderId)}/nym-session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            buyerNymAddress: buyerNymAddress.trim(),
            buyerPublicKeyJwk: keyPair.publicJwk,
            transport: loadedOrder.delivery.requiredTransport,
          }),
        },
      );
      const body = await postJson<PaymentIntentResponse>(
        `/api/transfers/${encodeURIComponent(
          loadedOrder.orderId,
        )}/payment-intent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            buyerPublicKeyJwk: keyPair.publicJwk,
            successUrl: window.location.href,
          }),
        },
      );
      setLoadedOrder(body.order);
      setPayment(body.payment);
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  async function onDevPay() {
    if (!loadedOrder) {
      return;
    }
    setErrorMessage("");
    setBusyAction("payment");
    try {
      const body = await postJson<{ order: TransferPublicOrder }>(
        `/api/transfers/${encodeURIComponent(loadedOrder.orderId)}/dev-pay`,
        { method: "POST" },
      );
      setLoadedOrder(body.order);
      setPayment(body.order.payment);
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  async function onUnlockFile() {
    if (!loadedOrder) {
      return;
    }
    setErrorMessage("");
    setBusyAction("unlocking");
    if (downloadUrl) {
      window.URL.revokeObjectURL(downloadUrl);
      setDownloadUrl("");
    }

    try {
      const keyPair = loadBuyerKeyPair(loadedOrder.orderId);
      if (!keyPair) {
        throw new Error(copy.errors.paymentRequired);
      }

      const claim = await postJson<ClaimResponse>(
        `/api/transfers/${encodeURIComponent(loadedOrder.orderId)}/claim`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ buyerPublicKeyJwk: keyPair.publicJwk }),
        },
      );
      const encryptedResponse = await fetch(claim.download.url);
      if (!encryptedResponse.ok) {
        const body = await readResponseBody(encryptedResponse);
        throw new Error(
          extractServerErrorMessage(body, "Encrypted file download failed"),
        );
      }

      const fileKey = await decryptPaidLinkFileKey(
        claim.keyEnvelope,
        keyPair.privateJwk,
      );
      const opened = await decryptPaidLinkFile(
        await encryptedResponse.arrayBuffer(),
        fileKey,
        claim.order.file.encryptionIv,
        claim.order.file.mimeType,
      );
      const objectUrl = window.URL.createObjectURL(opened);
      setLoadedOrder(claim.order);
      setPayment(claim.order.payment);
      setDownloadUrl(objectUrl);
      setDownloadFileName(claim.order.file.fileName);
    } catch (error) {
      if (error instanceof ApiError && error.status === 402) {
        setErrorMessage(copy.errors.paymentRequired);
      } else {
        setErrorMessage(formatError(error, copy.errors.serverError));
      }
    } finally {
      setBusyAction("idle");
    }
  }

  async function getOrCreateBuyerKeyPair(
    orderId: string,
  ): Promise<PaidLinkBuyerKeyPair> {
    const existing = loadBuyerKeyPair(orderId);
    if (existing) {
      return existing;
    }
    const next = await createPaidLinkBuyerKeyPair();
    saveBuyerKeyPair(orderId, next);
    return next;
  }

  const isBusy = busyAction !== "idle";

  return (
    <main className="page-shell product-shell zk-hub-shell zk-timestamp-shell zectime-paid-link-shell">
      <div className="background-grid" aria-hidden="true" />

      <header className="frame zk-hub-topbar surface-reveal">
        <div className="zk-hub-topbar-brand">
          <p className="eyebrow zk-hub-topbar-eyebrow">
            {copy.shell.eyebrow}
          </p>
          <Link
            className="zk-hub-topbar-back"
            href={withProductLocale(backHref, locale)}
          >
            {backLabel ?? copy.shell.backLabel}
          </Link>
        </div>
        <div className="zk-hub-topbar-tools">
          <ProductLocaleToggle
            locale={locale}
            ariaLabel={copy.shell.eyebrow}
          />
        </div>
      </header>

      <div className="zk-hub-body zectime-paid-body">
        <section className="frame zectime-paid-hero surface-reveal">
          <div>
            <p className="eyebrow">{copy.shell.eyebrow}</p>
            <h1>{copy.shell.title}</h1>
          </div>
          <p className="hero-copy">{copy.shell.body}</p>
          <div className="zectime-paid-tabs" role="tablist">
            <button
              type="button"
              className="zectime-paid-tab"
              data-active={mode === "send"}
              onClick={() => setMode("send")}
            >
              {copy.tabs.send}
            </button>
            <button
              type="button"
              className="zectime-paid-tab"
              data-active={mode === "receive"}
              onClick={() => setMode("receive")}
            >
              {copy.tabs.receive}
            </button>
          </div>
        </section>

        {errorMessage ? (
          <p className="zk-hub-form-feedback zk-hub-form-feedback-error">
            {errorMessage}
          </p>
        ) : null}

        {mode === "send" ? (
          <section className="frame zectime-paid-panel surface-reveal">
            <div className="zectime-paid-panel-copy">
              <p className="eyebrow">{copy.tabs.send}</p>
              <h2>{copy.send.title}</h2>
              <p>{copy.send.body}</p>
            </div>

            <form className="zk-hub-form" onSubmit={onCreateLink}>
              <label className="zk-hub-form-field">
                <span className="zk-hub-form-label">{copy.send.fileLabel}</span>
                <span className="zk-hub-file-picker">
                  <input
                    className="zk-hub-file-input"
                    type="file"
                    onChange={onFileChange}
                    disabled={isBusy}
                  />
                  <span className="zk-hub-file-button">
                    {copy.send.chooseFileLabel}
                  </span>
                  <span className="zk-hub-file-name">
                    {file ? file.name : copy.send.emptyFileLabel}
                  </span>
                </span>
              </label>

              <label className="zk-hub-form-field">
                <span className="zk-hub-form-label">{copy.send.priceLabel}</span>
                <input
                  value={priceZec}
                  onChange={(event) => setPriceZec(event.target.value)}
                  inputMode="decimal"
                  disabled={isBusy}
                />
                <span className="zk-hub-form-hint">{copy.send.priceHint}</span>
              </label>

              <label className="zk-hub-form-field">
                <span className="zk-hub-form-label">
                  {copy.send.payoutAddressLabel}
                </span>
                <input
                  value={sellerPayoutAddress}
                  onChange={(event) =>
                    setSellerPayoutAddress(event.target.value)
                  }
                  placeholder={copy.send.payoutAddressPlaceholder}
                  autoComplete="off"
                  disabled={isBusy}
                />
                <span className="zk-hub-form-hint">
                  {copy.send.payoutAddressHint}
                </span>
              </label>

              <label className="zk-hub-form-field">
                <span className="zk-hub-form-label">{copy.send.noteLabel}</span>
                <textarea
                  value={sellerNote}
                  onChange={(event) => setSellerNote(event.target.value)}
                  placeholder={copy.send.notePlaceholder}
                  disabled={isBusy}
                  rows={3}
                />
              </label>

              <button className="button-primary" type="submit" disabled={isBusy}>
                {busyAction === "encrypting"
                  ? copy.send.busyLabel
                  : copy.send.submitLabel}
              </button>
            </form>

            {createdOrder && shareUrl ? (
              <div className="zectime-paid-result">
                <div>
                  <p className="eyebrow">{copy.send.successTitle}</p>
                  <p>{copy.send.successBody}</p>
                </div>
                <code>{shareUrl}</code>
                <div className="zectime-paid-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => void navigator.clipboard.writeText(shareUrl)}
                  >
                    {copy.send.copyLinkLabel}
                  </button>
                  <a className="button-primary" href={shareUrl}>
                    {copy.send.openLinkLabel}
                  </a>
                </div>
                <OrderDetails order={createdOrder} copy={copy} />
              </div>
            ) : null}
          </section>
        ) : (
          <section className="frame zectime-paid-panel surface-reveal">
            <div className="zectime-paid-panel-copy">
              <p className="eyebrow">{copy.tabs.receive}</p>
              <h2>{copy.receive.title}</h2>
              <p>{copy.receive.body}</p>
            </div>

            <form className="zk-hub-form" onSubmit={onLoadOrder}>
              <label className="zk-hub-form-field">
                <span className="zk-hub-form-label">
                  {copy.receive.orderLabel}
                </span>
                <input
                  value={orderInput}
                  onChange={(event) => setOrderInput(event.target.value)}
                  placeholder={copy.receive.orderPlaceholder}
                  disabled={isBusy}
                />
                </label>
              <label className="zk-hub-form-field">
                <span className="zk-hub-form-label">
                  {copy.receive.nymAddressLabel}
                </span>
                <input
                  value={buyerNymAddress}
                  onChange={(event) => setBuyerNymAddress(event.target.value)}
                  placeholder={copy.receive.nymAddressPlaceholder}
                  disabled={isBusy}
                />
                <span className="zk-hub-form-hint">
                  {copy.receive.nymAddressHint}
                </span>
              </label>
              <button className="button-secondary" type="submit" disabled={isBusy}>
                {busyAction === "loading"
                  ? `${copy.receive.loadLabel}...`
                  : copy.receive.loadLabel}
              </button>
            </form>

            {loadedOrder ? (
              <div className="zectime-paid-result">
                <OrderDetails order={loadedOrder} copy={copy} />

                <div className="zectime-paid-payment">
                  <div>
                    <p className="eyebrow">
                      {loadedOrder.payment?.status === "paid"
                        ? copy.receive.paidStatus
                        : copy.receive.pendingStatus}
                    </p>
                    {payment ? <PaymentDetails payment={payment} copy={copy} /> : null}
                  </div>
                  <div className="zectime-paid-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => void onCreatePayment()}
                      disabled={isBusy || loadedOrder.payment?.status === "paid"}
                    >
                      {busyAction === "payment"
                        ? `${copy.receive.payLabel}...`
                        : copy.receive.payLabel}
                    </button>
                    {payment?.checkoutUrl ? (
                      <a
                        className="button-primary"
                        href={payment.checkoutUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {copy.receive.checkoutLabel}
                      </a>
                    ) : null}
                    {payment?.provider === "dev" &&
                    loadedOrder.payment?.status !== "paid" ? (
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => void onDevPay()}
                        disabled={isBusy}
                      >
                        {copy.receive.devPayLabel}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="button-primary"
                      onClick={() => void onUnlockFile()}
                      disabled={isBusy || !loadedOrder.payment}
                    >
                      {busyAction === "unlocking"
                        ? `${copy.receive.unlockLabel}...`
                        : copy.receive.unlockLabel}
                    </button>
                  </div>
                </div>

                {downloadUrl ? (
                  <a
                    className="button-primary zectime-paid-download"
                    href={downloadUrl}
                    download={downloadFileName}
                  >
                    {copy.receive.downloadLabel}
                  </a>
                ) : null}
              </div>
            ) : null}
          </section>
        )}
      </div>
    </main>
  );
}

function OrderDetails({
  order,
  copy,
}: {
  order: TransferPublicOrder;
  copy: PaidPrivateFileCopy;
}) {
  return (
    <dl className="zectime-paid-details">
      <div>
        <dt>{copy.details.file}</dt>
        <dd>{order.file.fileName}</dd>
      </div>
      <div>
        <dt>{copy.details.price}</dt>
        <dd>{order.price.displayZec} ZEC</dd>
      </div>
      <div className="zectime-paid-details-wide">
        <dt>{copy.details.sellerPayoutAddress}</dt>
        <dd>{order.sellerPayoutAddress}</dd>
      </div>
      <div>
        <dt>{copy.details.size}</dt>
        <dd>{formatBytes(order.file.originalSizeBytes)}</dd>
      </div>
      <div>
        <dt>{copy.details.status}</dt>
        <dd>{order.status}</dd>
      </div>
      <div>
        <dt>{copy.details.privateDelivery}</dt>
        <dd>{order.delivery.requiredTransport}</dd>
      </div>
      <div>
        <dt>{copy.details.nymSession}</dt>
        <dd>{order.delivery.nymSession?.status ?? "required"}</dd>
      </div>
      <div className="zectime-paid-details-wide">
        <dt>{copy.details.digest}</dt>
        <dd>{order.file.encryptedFileSha256}</dd>
      </div>
      {order.timestamp ? (
        <div className="zectime-paid-details-wide">
          <dt>{copy.details.timestamp}</dt>
          <dd>{order.timestamp.commitment}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function PaymentDetails({
  payment,
  copy,
}: {
  payment: TransferPayment;
  copy: PaidPrivateFileCopy;
}) {
  return (
    <dl className="zectime-paid-details zectime-paid-payment-details">
      <div>
        <dt>{copy.details.invoice}</dt>
        <dd>{payment.invoiceId}</dd>
      </div>
      {payment.paymentAddress ? (
        <div className="zectime-paid-details-wide">
          <dt>{copy.details.paymentAddress}</dt>
          <dd>{payment.paymentAddress}</dd>
        </div>
      ) : null}
      {payment.memo ? (
        <div className="zectime-paid-details-wide">
          <dt>{copy.details.paymentMemo}</dt>
          <dd>{payment.memo}</dd>
        </div>
      ) : null}
    </dl>
  );
}

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function postJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractServerErrorMessage(body, `HTTP ${response.status}`),
    );
  }
  return body as T;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function formatError(error: unknown, prefix: string): string {
  if (error instanceof Error) {
    return `${prefix}${error.message}`;
  }
  return `${prefix}${String(error)}`;
}

function extractOrderId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    const fromQuery = parsed.searchParams.get("order");
    if (fromQuery) {
      return extractOrderId(fromQuery);
    }
  } catch {
    // Plain order ids are expected here too.
  }

  const match = trimmed.match(/pl_[a-f0-9]{24}/u);
  return match?.[0] ?? null;
}

function parseZecToZats(value: string): number {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,8})?$/u.test(normalized)) {
    throw new Error("Invalid ZEC amount");
  }
  const [whole, fractional = ""] = normalized.split(".");
  const zats =
    BigInt(whole) * 100_000_000n +
    BigInt(fractional.padEnd(8, "0").slice(0, 8));
  if (zats < 1n || zats > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid ZEC amount");
  }
  return Number(zats);
}

function isLikelyZcashUnifiedAddress(value: string): boolean {
  const cleaned = value.trim();
  return (
    cleaned.length <= 512 &&
    /^(u1|utest|uregtest)[a-z0-9]{16,}$/iu.test(cleaned)
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
