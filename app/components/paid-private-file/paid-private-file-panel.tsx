"use client";

import Link from "next/link";
import QRCode from "qrcode";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  createPaidLinkBuyerKeyPair,
  createPaidLinkSellerReleaseDraft,
  decryptPaidLinkFile,
  decryptPaidLinkFileKey,
  encryptPaidLinkFile,
  fingerprintPaidLinkPublicKey,
  loadBuyerKeyPair,
  loadSellerReleaseDraft,
  saveBuyerKeyPair,
  saveSellerReleaseDraft,
  wrapPaidLinkFileKeyForBuyer,
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
  seller: SellerProfile | null;
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
  release: {
    mode: "seller-held";
    status: "seller_pending" | "ready";
    releasedAt: string | null;
  };
}

interface KeyReleaseResponse {
  order: TransferPublicOrder;
  release: {
    status:
      | "waiting_for_payment"
      | "waiting_for_buyer"
      | "ready_to_release"
      | "released";
    buyerPublicKeyHash: string | null;
    buyerPublicKeyJwk: JsonWebKey | null;
    buyerNymAddress: string | null;
    releasedAt: string | null;
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

interface SellerProfile {
  sellerId: string;
  handle: string;
  displayName: string;
  defaultPayoutAddress: string;
  publicPath: string;
  // Non-custodial marketplace: only the fingerprint + network are exposed.
  ufvkFingerprint?: string;
  network?: "main" | "test" | "regtest";
}

interface SellerFile {
  orderId: string;
  fileName: string;
  displayZec: string;
  status: TransferPublicOrder["status"];
  createdAt: string;
  sharePath: string;
}

interface SellerFilesResponse {
  files: SellerFile[];
}

interface SellerCreateResponse {
  seller: SellerProfile;
  accessKey: string;
}

interface SellerSessionResponse {
  seller: SellerProfile | null;
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
  deliveryMode: "http-dev-fallback" | "nym" | "browser-nym";
  keyEnvelope?: PaidLinkKeyEnvelope;
  download?: {
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

interface TransferManifest {
  orderId: string;
  fileName: string;
  mimeType: string;
  encryptedFileSha256: string;
  encryptionIv: string;
}

interface NymClaimPayload {
  schema: "paidprivatefile.nym.claim.v1";
  orderId: string;
  manifest: TransferManifest;
  keyEnvelope: PaidLinkKeyEnvelope;
  encryptedFileDownload?: {
    url: string;
    expiresAt: string;
  };
  devHttpFallback?: {
    url: string;
    expiresAt: string;
  };
}

interface BrowserNymClient {
  client: {
    start: (opts?: Record<string, unknown>) => Promise<void>;
    stop: () => Promise<void>;
    selfAddress: () => Promise<string | undefined>;
    send: (args: {
      payload: { message: string | Uint8Array; mimeType?: string };
      recipient: string;
      replySurbs?: number;
    }) => Promise<void>;
  };
  events: {
    subscribeToTextMessageReceivedEvent: (
      handler: (event: { args: { payload: string } }) => void | Promise<void>,
    ) => () => void;
  };
}

type Mode = "send" | "receive";
type SellerAuthMode = "create" | "login";
type SellerScreen = "dashboard" | "files" | "settings" | "create";
type FlowMotionStage = "transfer" | "payment" | "done";
type BusyAction =
  | "idle"
  | "encrypting"
  | "loading"
  | "payment"
  | "nym"
  | "seller"
  | "release"
  | "unlocking";
type BrowserNymStatus = "idle" | "starting" | "ready" | "waiting" | "error";

const SELLER_PAYOUT_STORAGE_KEY = "paidprivatefile_seller_payout_address";
const SELLER_PRICE_STORAGE_KEY = "paidprivatefile_seller_price_zec";
const BUYER_NYM_CLIENT_ID_STORAGE_KEY = "paidprivatefile_buyer_nym_client_id";

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
  const [seller, setSeller] = useState<SellerProfile | null>(null);
  const [sellerAuthMode, setSellerAuthMode] =
    useState<SellerAuthMode>("create");
  // Seller shop dashboard: one screen at a time (no stacking). Defaults to the
  // dashboard whenever a seller is logged in.
  const [sellerScreen, setSellerScreen] = useState<SellerScreen>("dashboard");
  const [sellerFiles, setSellerFiles] = useState<SellerFile[]>([]);
  const [sellerFilesStatus, setSellerFilesStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<
    "idle" | "saving" | "saved"
  >("idle");
  const [publicLinkCopied, setPublicLinkCopied] = useState(false);
  const [sellerHandle, setSellerHandle] = useState("");
  const [sellerDisplayName, setSellerDisplayName] = useState("");
  const [sellerAccessKey, setSellerAccessKey] = useState("");
  const [newSellerAccessKey, setNewSellerAccessKey] = useState("");
  const [accessKeyCopied, setAccessKeyCopied] = useState(false);
  const [accessKeyAcknowledged, setAccessKeyAcknowledged] = useState(false);
  // Non-custodial marketplace (Phase 1): the shop viewing key (UFVK).
  const [sellerUfvk, setSellerUfvk] = useState("");
  const [ufvkAcknowledged, setUfvkAcknowledged] = useState(false);
  const [ufvkConfirmation, setUfvkConfirmation] = useState<{
    ufvkFingerprint: string;
    network: string;
    defaultAddress: string;
  } | null>(null);
  const [ufvkPreview, setUfvkPreview] = useState<{
    status: "idle" | "checking" | "valid" | "invalid";
    address?: string;
  }>({ status: "idle" });
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
  const [showManualNymAddress, setShowManualNymAddress] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadFileName, setDownloadFileName] = useState("");
  // Browser-direct Nym: the buyer's claim returns the signed ciphertext URL but
  // NOT the key envelope (the seller delivers that over the mixnet). We stash
  // the URL here so the Nym receive handler can fetch the file once the key
  // arrives over Nym.
  const pendingDownloadRef = useRef<{ url: string; expiresAt: string } | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [releaseMessage, setReleaseMessage] = useState("");
  const [nymStatus, setNymStatus] = useState<BrowserNymStatus>("idle");
  const [nymMessage, setNymMessage] = useState("");
  const [buyerVerificationCode, setBuyerVerificationCode] = useState("");
  const [buyerKeyEpoch, setBuyerKeyEpoch] = useState(0);
  const [sellerBuyerCode, setSellerBuyerCode] = useState("");
  const [sellerCodeConfirmed, setSellerCodeConfirmed] = useState(false);
  const browserNymClientRef = useRef<BrowserNymClient | null>(null);
  const browserNymUnsubscribeRef = useRef<(() => void) | null>(null);
  const autoReleaseRef = useRef(false);

  useEffect(() => {
    if (!initialOrderId) {
      return;
    }
    void loadOrder(initialOrderId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOrderId]);

  // Live preview: as the seller types a viewing key, validate it (debounced) and
  // show the derived receiving address before the shop is created.
  useEffect(() => {
    const key = sellerUfvk.trim();
    if (!key.toLowerCase().startsWith("uview1") || key.length < 40) {
      setUfvkPreview({ status: "idle" });
      return;
    }
    let active = true;
    setUfvkPreview({ status: "checking" });
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch("/api/zcash/ufvk-preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ufvk: key }),
          });
          const data = (await res.json()) as {
            valid?: boolean;
            defaultAddress?: string | null;
          };
          if (!active) return;
          if (res.ok && data.valid && data.defaultAddress) {
            setUfvkPreview({ status: "valid", address: data.defaultAddress });
          } else {
            setUfvkPreview({ status: "invalid" });
          }
        } catch {
          if (active) setUfvkPreview({ status: "invalid" });
        }
      })();
    }, 600);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [sellerUfvk]);

  useEffect(() => {
    return () => {
      if (downloadUrl) {
        window.URL.revokeObjectURL(downloadUrl);
      }
    };
  }, [downloadUrl]);

  // Buyer self-verification: derive the buyer's OWN public-key fingerprint so it
  // can be compared out-of-band with the code the seller sees. If they match,
  // the server did not substitute the buyer key the seller wraps to.
  useEffect(() => {
    const orderId = loadedOrder?.orderId;
    if (mode !== "receive" || !orderId) {
      setBuyerVerificationCode("");
      return;
    }
    const keyPair = loadBuyerKeyPair(orderId);
    if (!keyPair) {
      setBuyerVerificationCode("");
      return;
    }
    let active = true;
    void fingerprintPaidLinkPublicKey(keyPair.publicJwk)
      .then((code) => {
        if (active) {
          setBuyerVerificationCode(code);
        }
      })
      .catch(() => {
        if (active) {
          setBuyerVerificationCode("");
        }
      });
    return () => {
      active = false;
    };
  }, [mode, loadedOrder?.orderId, buyerKeyEpoch]);

  useEffect(() => {
    const savedPayoutAddress = window.localStorage.getItem(
      SELLER_PAYOUT_STORAGE_KEY,
    );
    const savedPrice = window.localStorage.getItem(SELLER_PRICE_STORAGE_KEY);
    if (savedPayoutAddress) {
      setSellerPayoutAddress(savedPayoutAddress);
    }
    if (savedPrice) {
      setPriceZec(savedPrice);
    }
    void loadSellerSession();

    return () => {
      browserNymUnsubscribeRef.current?.();
      browserNymUnsubscribeRef.current = null;
      const client = browserNymClientRef.current;
      browserNymClientRef.current = null;
      void client?.client.stop();
    };
  }, []);

  useEffect(() => {
    if (isLikelyZcashUnifiedAddress(sellerPayoutAddress)) {
      window.localStorage.setItem(
        SELLER_PAYOUT_STORAGE_KEY,
        sellerPayoutAddress.trim(),
      );
    }
  }, [sellerPayoutAddress]);

  useEffect(() => {
    try {
      parseZecToZats(priceZec);
      window.localStorage.setItem(SELLER_PRICE_STORAGE_KEY, priceZec.trim());
    } catch {
      // Persist only valid prices.
    }
  }, [priceZec]);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }

  async function loadSellerSession() {
    try {
      const body = await postJson<SellerSessionResponse>(
        "/api/seller-session",
        {
          method: "GET",
        },
      );
      if (body.seller) {
        applySeller(body.seller);
      }
    } catch {
      // Anonymous sellers can still create one-off local prototype links.
    }
  }

  async function loadSellerFiles() {
    setSellerFilesStatus("loading");
    try {
      const body = await postJson<SellerFilesResponse>(
        "/api/sellers/me/files",
        { method: "GET" },
      );
      setSellerFiles(body.files);
      setSellerFilesStatus("ready");
    } catch {
      // Non-fatal: the dashboard still renders without the files list.
      setSellerFilesStatus("error");
    }
  }

  // Seller dashboard: refresh the files list when the dashboard or files screen
  // becomes active for a logged-in seller (mount + screen switch + after a new
  // file is created, which routes back to the dashboard).
  useEffect(() => {
    if (!seller) {
      return;
    }
    if (sellerScreen !== "dashboard" && sellerScreen !== "files") {
      return;
    }
    void loadSellerFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seller?.sellerId, sellerScreen]);

  async function onCreateSeller() {
    setErrorMessage("");
    setNewSellerAccessKey("");
    if (!sellerUfvk.trim() || !ufvkAcknowledged) {
      setErrorMessage(copy.errors.ufvkRequired);
      return;
    }
    setBusyAction("seller");
    try {
      setUfvkConfirmation(null);
      // Non-custodial: the shop is created from the viewing key; the receiving
      // address is DERIVED from it server-side (no separate wallet to paste).
      const body = await postJson<SellerCreateResponse>("/api/sellers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: sellerHandle,
          displayName: sellerDisplayName,
          ufvk: sellerUfvk.trim(),
        }),
      });
      applySeller(body.seller);
      setNewSellerAccessKey(body.accessKey);
      setAccessKeyCopied(false);
      setAccessKeyAcknowledged(false);
      setSellerAccessKey("");

      // Read back the confirmation (fingerprint + derived receiving address) for
      // the success panel; the key itself is already stored from creation.
      await registerSellerUfvk();
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  async function registerSellerUfvk() {
    setUfvkConfirmation(null);
    const confirmation = await postJson<{
      ufvkFingerprint: string;
      network: string;
      defaultAddress: string;
    }>("/api/sellers/me/ufvk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ufvk: sellerUfvk.trim() }),
    });
    setUfvkConfirmation(confirmation);
  }

  async function onLoginSeller() {
    setErrorMessage("");
    setBusyAction("seller");
    try {
      const body = await postJson<{ seller: SellerProfile }>(
        "/api/seller-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handle: sellerHandle,
            accessKey: sellerAccessKey,
          }),
        },
      );
      applySeller(body.seller);
      setNewSellerAccessKey("");
      setAccessKeyCopied(false);
      setAccessKeyAcknowledged(false);
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  function applySeller(nextSeller: SellerProfile) {
    setSeller(nextSeller);
    setSellerHandle(nextSeller.handle);
    setSellerDisplayName(nextSeller.displayName);
    setSellerPayoutAddress(nextSeller.defaultPayoutAddress);
    setSellerScreen("dashboard");
  }

  // Settings screen: persist an edited public display name via the existing
  // PATCH /api/sellers/me endpoint (handle + receiving config stay read-only).
  async function onSaveSettings() {
    if (!seller) {
      return;
    }
    setErrorMessage("");
    setSettingsSaveStatus("saving");
    try {
      const body = await postJson<{ seller: SellerProfile }>(
        "/api/sellers/me",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: sellerDisplayName }),
        },
      );
      setSeller(body.seller);
      setSellerDisplayName(body.seller.displayName);
      setSettingsSaveStatus("saved");
    } catch (error) {
      setSettingsSaveStatus("idle");
      setErrorMessage(formatError(error, copy.errors.serverError));
    }
  }

  async function onCopyPublicLink() {
    if (!seller) {
      return;
    }
    const href = new URL(
      withProductLocale(seller.publicPath, locale),
      window.location.origin,
    ).toString();
    await navigator.clipboard.writeText(href);
    setPublicLinkCopied(true);
  }

  async function onCopyNewSellerAccessKey() {
    if (!newSellerAccessKey) {
      return;
    }
    await navigator.clipboard.writeText(newSellerAccessKey);
    setAccessKeyCopied(true);
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
    if (newSellerAccessKey && !accessKeyAcknowledged) {
      setErrorMessage(copy.seller.accessKeyBlocker);
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
      // Pure seller-held custody: the AES file key never leaves this browser.
      // We only upload the SHA-256 of a random release secret; the actual file
      // key stays in the local seller vault until the seller releases it.
      const releaseDraft = await createPaidLinkSellerReleaseDraft(
        encrypted.fileKey,
      );
      const form = new FormData();
      form.set("encryptedFile", encrypted.encryptedFile, `${file.name}.enc`);
      form.set("fileName", file.name);
      form.set("mimeType", file.type || "application/octet-stream");
      form.set("originalSizeBytes", String(file.size));
      form.set("encryptedFileSha256", encrypted.encryptedFileSha256);
      form.set("encryptionIv", encrypted.encryptionIv);
      form.set("releaseSecretHash", releaseDraft.releaseSecretHash);
      form.set("amountZats", String(amountZats));
      form.set("sellerPayoutAddress", sellerPayoutAddress.trim());
      form.set("sellerNote", sellerNote);
      form.set("timestampReceiptJson", JSON.stringify(timestampDraft.receipt));

      const body = await postJson<CreateTransferResponse>("/api/transfers", {
        method: "POST",
        body: form,
      });
      saveSellerReleaseDraft(body.order.orderId, releaseDraft);
      const href = new URL(
        withProductLocale(body.sharePath, locale),
        window.location.origin,
      ).toString();
      setCreatedOrder(body.order);
      setShareUrl(href);
      setOrderInput(body.order.orderId);
      setLoadedOrder(body.order);
      // Seller dashboard: after a successful create, return to the dashboard so
      // the new file appears in "Your files" (the share link stays available on
      // the dashboard via the createdOrder/shareUrl state).
      if (seller) {
        setSellerScreen("dashboard");
        void loadSellerFiles();
      }
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
    pendingDownloadRef.current = null;

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
      setBuyerKeyEpoch((current) => current + 1);
      const nymAddress = buyerNymAddress.trim() || (await startBrowserNym());
      await postJson<{ order: TransferPublicOrder }>(
        `/api/transfers/${encodeURIComponent(loadedOrder.orderId)}/nym-session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            buyerNymAddress: nymAddress,
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
      if (!browserNymClientRef.current && buyerNymAddress.trim().length === 0) {
        await startBrowserNym();
      }

      const claim = await postJson<ClaimResponse>(
        `/api/transfers/${encodeURIComponent(loadedOrder.orderId)}/claim`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ buyerPublicKeyJwk: keyPair.publicJwk }),
        },
      );
      setLoadedOrder(claim.order);
      setPayment(claim.order.payment);
      if (claim.keyEnvelope && claim.download) {
        await openClaimPayload(
          {
            schema: "paidprivatefile.nym.claim.v1",
            orderId: claim.order.orderId,
            manifest: {
              orderId: claim.order.orderId,
              fileName: claim.order.file.fileName,
              mimeType: claim.order.file.mimeType,
              encryptedFileSha256: claim.order.file.encryptedFileSha256,
              encryptionIv: claim.order.file.encryptionIv,
            },
            keyEnvelope: claim.keyEnvelope,
            encryptedFileDownload: claim.download,
          },
          keyPair,
        );
        return;
      }

      // Browser-direct Nym: the claim returns the signed ciphertext URL but no
      // key envelope (the seller sends that over the mixnet). Stash the URL and
      // wait for the key to arrive via the in-browser Nym receiver.
      if (claim.deliveryMode === "browser-nym" && claim.download) {
        pendingDownloadRef.current = claim.download;
      }

      setNymStatus("waiting");
      setNymMessage(copy.receive.nymWaitingLabel);
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

  // Shared Nym client bootstrap used by BOTH the buyer receiver (subscribes to
  // inbound text messages) and the seller sender (uses client.send). It reuses
  // the existing client when one is already running, otherwise it spins up a
  // FRESH client per attempt and polls selfAddress() until the gateway
  // handshake completes.
  //
  // Gateway-rotation rationale: the SDK picks a gateway when a client is
  // started, and a single slow/unreachable gateway makes selfAddress() hang
  // forever (production users waited the full poll window for nothing). Because
  // the SDK selects a different gateway on each FRESH start, we retry with a
  // brand-new client a few times instead of polling one client indefinitely.
  // Only the client that actually returns an address is kept and (for the
  // buyer) subscribed; abandoned clients are stopped so we never double-
  // subscribe or leak a half-open connection.
  async function bootstrapBrowserNymClient(options: {
    subscribe: boolean;
  }): Promise<{ client: BrowserNymClient; address: string }> {
    const existing = browserNymClientRef.current;
    if (existing) {
      const existingAddress = (await existing.client.selfAddress()) ?? "";
      if (existingAddress) {
        return { client: existing, address: existingAddress };
      }
    }

    const nymModule = await import("@nymproject/sdk-full-fat");
    // The SDK pins a gateway per clientId (persisted in IndexedDB), so reusing a
    // single id across attempts would re-draw the SAME (possibly dead) gateway
    // and defeat rotation. The first attempt reuses the stored id for a stable
    // address across reloads when its gateway is healthy; later attempts use a
    // fresh ephemeral id so the SDK rotates to a different gateway.
    const storedClientId = getStoredBrowserNymClientId();

    for (
      let attempt = 0;
      attempt < BROWSER_NYM_GATEWAY_ATTEMPTS;
      attempt += 1
    ) {
      const clientId =
        attempt === 0 && storedClientId
          ? storedClientId
          : `paidprivatefile-${crypto.randomUUID()}`;

      const nym = (await nymModule.createNymMixnetClient({
        autoConvertStringMimeTypes: [
          nymModule.MimeTypes.ApplicationJson,
          nymModule.MimeTypes.TextPlain,
        ],
      })) as BrowserNymClient;

      const address = await startAndAwaitNymAddress(nym, { clientId });
      if (!address) {
        // This attempt drew a bad gateway; drop the client (best effort) and
        // let the next attempt draw a fresh one.
        await stopBrowserNymClientQuietly(nym);
        continue;
      }

      // Persist the identity that actually reached a gateway so a later reload
      // reuses this working gateway first.
      persistBrowserNymClientId(clientId);

      if (options.subscribe) {
        browserNymUnsubscribeRef.current?.();
        browserNymUnsubscribeRef.current =
          nym.events.subscribeToTextMessageReceivedEvent((event) => {
            void handleNymTextMessage(event.args.payload);
          });
      }

      browserNymClientRef.current = nym;
      return { client: nym, address };
    }

    throw new Error("Nym client did not return an address");
  }

  async function startBrowserNym(): Promise<string> {
    if (browserNymClientRef.current && buyerNymAddress.trim()) {
      return buyerNymAddress.trim();
    }

    setErrorMessage("");
    setNymStatus("starting");
    setNymMessage(copy.receive.nymStartingLabel);
    setBusyAction("nym");
    try {
      const { address } = await bootstrapBrowserNymClient({ subscribe: true });
      setBuyerNymAddress(address);
      setNymStatus("ready");
      setNymMessage(copy.receive.nymReadyLabel);
      return address;
    } catch (error) {
      setNymStatus("error");
      setNymMessage(copy.errors.nymUnavailable);
      throw error;
    } finally {
      setBusyAction("idle");
    }
  }

  // Seller-side browser-direct Nym send: reuse the shared client bootstrap, then
  // deliver the wrapped key envelope straight to the buyer's Nym address over
  // the mixnet. The SDK exposes client.send({ payload: { message, mimeType },
  // recipient }); the buyer receiver decodes it via subscribeToTextMessage.
  async function sendKeyEnvelopeOverNym(input: {
    orderId: string;
    keyEnvelope: PaidLinkKeyEnvelope;
    buyerNymAddress: string;
  }): Promise<void> {
    const { client } = await bootstrapBrowserNymClient({ subscribe: false });
    const message = JSON.stringify({
      schema: "paidprivatefile.nym.claim.v1",
      orderId: input.orderId,
      keyEnvelope: input.keyEnvelope,
    });
    await client.client.send({
      payload: { message, mimeType: "application/json" },
      recipient: input.buyerNymAddress,
    });
  }

  async function handleNymTextMessage(payload: string): Promise<void> {
    // Legacy full payload (server-relayed) carries the manifest + file URL.
    const parsed = parseNymClaimPayload(payload);
    if (parsed) {
      if (loadedOrder && parsed.orderId !== loadedOrder.orderId) {
        return;
      }
      const keyPair = loadBuyerKeyPair(parsed.orderId);
      if (!keyPair) {
        setErrorMessage(copy.errors.paymentRequired);
        return;
      }
      await openClaimPayload(parsed, keyPair);
      return;
    }

    // Browser-direct Nym (frente B): the seller sends only { schema, orderId,
    // keyEnvelope }. The buyer reconstructs the manifest from the loaded order
    // and uses the signed download URL stashed from its own claim response.
    const keyOnly = parseNymKeyOnlyPayload(payload);
    if (!keyOnly) {
      return;
    }
    if (!loadedOrder || keyOnly.orderId !== loadedOrder.orderId) {
      return;
    }
    const keyPair = loadBuyerKeyPair(keyOnly.orderId);
    if (!keyPair) {
      setErrorMessage(copy.errors.paymentRequired);
      return;
    }
    const download = pendingDownloadRef.current;
    if (!download) {
      setErrorMessage(copy.errors.paymentRequired);
      return;
    }
    await openClaimPayload(
      {
        schema: "paidprivatefile.nym.claim.v1",
        orderId: loadedOrder.orderId,
        manifest: {
          orderId: loadedOrder.orderId,
          fileName: loadedOrder.file.fileName,
          mimeType: loadedOrder.file.mimeType,
          encryptedFileSha256: loadedOrder.file.encryptedFileSha256,
          encryptionIv: loadedOrder.file.encryptionIv,
        },
        keyEnvelope: keyOnly.keyEnvelope,
        encryptedFileDownload: download,
      },
      keyPair,
    );
  }

  async function openClaimPayload(
    payload: NymClaimPayload,
    keyPair: PaidLinkBuyerKeyPair,
  ): Promise<void> {
    const encryptedFileDownload =
      payload.encryptedFileDownload ?? payload.devHttpFallback;
    if (!encryptedFileDownload) {
      throw new Error("Nym claim payload did not include a file URL");
    }

    const encryptedResponse = await fetch(encryptedFileDownload.url);
    if (!encryptedResponse.ok) {
      const body = await readResponseBody(encryptedResponse);
      throw new Error(
        extractServerErrorMessage(body, "Encrypted file download failed"),
      );
    }

    const fileKey = await decryptPaidLinkFileKey(
      payload.keyEnvelope,
      keyPair.privateJwk,
    );
    const opened = await decryptPaidLinkFile(
      await encryptedResponse.arrayBuffer(),
      fileKey,
      payload.manifest.encryptionIv,
      payload.manifest.mimeType,
    );
    const objectUrl = window.URL.createObjectURL(opened);
    setDownloadUrl(objectUrl);
    setDownloadFileName(payload.manifest.fileName);
    setNymStatus("ready");
    setNymMessage(copy.receive.nymReadyLabel);
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

  // Verified manual release: fetch the key-release challenge (status only) so
  // the seller can SEE the buyer-key fingerprint and compare it out-of-band with
  // the code the buyer reads. A mismatch exposes a server key substitution.
  async function onRevealBuyerCode(order: TransferPublicOrder): Promise<void> {
    setErrorMessage("");
    setReleaseMessage("");
    setBusyAction("release");
    try {
      const draft = loadSellerReleaseDraft(order.orderId);
      if (!draft) {
        throw new Error(
          locale === "pt"
            ? "Esta maquina nao tem o segredo local do vendedor para liberar a chave."
            : "This browser does not hold the seller release secret for this file.",
        );
      }
      const challenge = await postJson<KeyReleaseResponse>(
        `/api/transfers/${encodeURIComponent(order.orderId)}/key-release`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ releaseSecret: draft.releaseSecret }),
        },
      );
      applyOrderState(challenge.order);
      if (challenge.release.status !== "ready_to_release") {
        setReleaseMessage(
          formatReleaseStatus(challenge.release.status, locale),
        );
        return;
      }
      if (!challenge.release.buyerPublicKeyJwk) {
        throw new Error(
          locale === "pt"
            ? "A chave publica do comprador ainda nao esta disponivel."
            : "The buyer public key is not available yet.",
        );
      }
      const code = await fingerprintPaidLinkPublicKey(
        challenge.release.buyerPublicKeyJwk,
      );
      setSellerBuyerCode(code);
      setSellerCodeConfirmed(false);
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  async function onReleaseSellerKey(
    order: TransferPublicOrder,
    options?: { silent?: boolean },
  ): Promise<void> {
    const silent = options?.silent ?? false;
    if (!silent) {
      setErrorMessage("");
    }
    setReleaseMessage("");
    setBusyAction("release");
    try {
      const draft = loadSellerReleaseDraft(order.orderId);
      if (!draft) {
        throw new Error(
          locale === "pt"
            ? "Esta maquina nao tem o segredo local do vendedor para liberar a chave."
            : "This browser does not hold the seller release secret for this file.",
        );
      }

      const challenge = await postJson<KeyReleaseResponse>(
        `/api/transfers/${encodeURIComponent(order.orderId)}/key-release`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ releaseSecret: draft.releaseSecret }),
        },
      );
      applyOrderState(challenge.order);
      if (challenge.release.status === "released") {
        setReleaseMessage(formatReleaseStatus("released", locale));
        return;
      }
      if (challenge.release.status !== "ready_to_release") {
        const message = formatReleaseStatus(challenge.release.status, locale);
        if (silent) {
          setReleaseMessage(message);
        } else {
          throw new Error(message);
        }
        return;
      }
      if (!challenge.release.buyerPublicKeyJwk) {
        throw new Error(
          locale === "pt"
            ? "A chave publica do comprador ainda nao esta disponivel."
            : "The buyer public key is not available yet.",
        );
      }

      const keyEnvelope = await wrapPaidLinkFileKeyForBuyer(
        draft.fileKey,
        challenge.release.buyerPublicKeyJwk,
      );
      const released = await postJson<KeyReleaseResponse>(
        `/api/transfers/${encodeURIComponent(order.orderId)}/key-release`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "release",
            releaseSecret: draft.releaseSecret,
            keyEnvelope,
          }),
        },
      );
      applyOrderState(released.order);
      setReleaseMessage(formatReleaseStatus("released", locale));

      // Frente B: keep the server key-release POST above (record + fallback),
      // then deliver the envelope to the buyer DIRECTLY over the Nym mixnet.
      // The server never relays the key in this mode.
      if (browserNymDeliveryEnabled() && challenge.release.buyerNymAddress) {
        try {
          await sendKeyEnvelopeOverNym({
            orderId: order.orderId,
            keyEnvelope,
            buyerNymAddress: challenge.release.buyerNymAddress,
          });
          setReleaseMessage(
            locale === "pt"
              ? "Chave liberada e enviada ao comprador pela Nym."
              : "Key released and delivered to the buyer over Nym.",
          );
        } catch (nymError) {
          setReleaseMessage(
            formatError(
              nymError,
              locale === "pt"
                ? "Chave liberada, mas o envio pela Nym falhou: "
                : "Key released, but Nym delivery failed: ",
            ),
          );
        }
      }
    } catch (error) {
      if (silent) {
        setReleaseMessage(formatError(error, copy.errors.serverError));
      } else {
        setErrorMessage(formatError(error, copy.errors.serverError));
      }
    } finally {
      setBusyAction("idle");
    }
  }

  function applyOrderState(order: TransferPublicOrder): void {
    if (mode === "send") {
      setCreatedOrder(order);
    }
    setLoadedOrder(order);
    setPayment(order.payment);
  }

  // Seller-online polling: while the created order still awaits seller key
  // release, the seller's tab polls the public order status so the auto-release
  // effect below can fire as soon as payment is confirmed.
  useEffect(() => {
    if (mode !== "send" || !createdOrder) {
      return;
    }
    if (createdOrder.release?.status !== "seller_pending") {
      return;
    }
    if (!loadSellerReleaseDraft(createdOrder.orderId)) {
      return;
    }
    const orderId = createdOrder.orderId;
    let active = true;
    const interval = window.setInterval(() => {
      void (async () => {
        try {
          const body = await postJson<{ order: TransferPublicOrder }>(
            `/api/transfers/${encodeURIComponent(orderId)}`,
            { method: "GET" },
          );
          if (active) {
            setCreatedOrder(body.order);
          }
        } catch {
          // Transient polling failures are non-fatal; retry on next tick.
        }
      })();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, createdOrder?.orderId, createdOrder?.release?.status]);

  // Seller-online auto release: when the seller's tab detects that payment is
  // confirmed but the key has not been released yet, and this browser holds the
  // local release secret, wrap and release the key automatically.
  useEffect(() => {
    const order = createdOrder ?? loadedOrder;
    if (!order) {
      return;
    }
    const paymentPaid =
      order.payment?.status === "paid" ||
      order.status === "paid" ||
      order.status === "claimed";
    const needsRelease = order.release?.status === "seller_pending";
    if (!paymentPaid || !needsRelease) {
      autoReleaseRef.current = false;
      return;
    }
    if (autoReleaseRef.current || busyAction !== "idle") {
      return;
    }
    if (!loadSellerReleaseDraft(order.orderId)) {
      return;
    }
    autoReleaseRef.current = true;
    void onReleaseSellerKey(order, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createdOrder, loadedOrder, busyAction]);

  const isBusy = busyAction !== "idle";
  const mustAcknowledgeAccessKey =
    Boolean(newSellerAccessKey) && !accessKeyAcknowledged;
  const canPublishFile = Boolean(seller) && !mustAcknowledgeAccessKey;
  const flowMotionStage = getFlowMotionStage({
    busyAction,
    createdOrder,
    loadedOrder,
    payment,
    downloadUrl,
    nymStatus,
  });

  return (
    <main className="page-shell product-shell zk-hub-shell zk-timestamp-shell zectime-paid-link-shell">
      <div className="background-grid" aria-hidden="true" />

      <header className="frame zk-hub-topbar surface-reveal">
        <div className="zk-hub-topbar-brand">
          <p className="eyebrow zk-hub-topbar-eyebrow">{copy.shell.eyebrow}</p>
          <Link
            className="zk-hub-topbar-back"
            href={withProductLocale(backHref, locale)}
          >
            {backLabel ?? copy.shell.backLabel}
          </Link>
        </div>
        <div className="zk-hub-topbar-tools">
          <div
            className="zectime-topbar-logos"
            aria-label={copy.brand.railLabel}
          >
            <BrandMark kind="zcash" label={copy.brand.zcash} />
            <BrandMark kind="nym" label={copy.brand.nym} />
          </div>
          <ProductLocaleToggle locale={locale} ariaLabel={copy.shell.eyebrow} />
        </div>
      </header>

      <div className="zk-hub-body zectime-paid-body">
        <section className="frame zectime-paid-hero surface-reveal">
          <div>
            <p className="eyebrow">{copy.shell.eyebrow}</p>
            <h1>{copy.shell.title}</h1>
          </div>
          <p className="hero-copy">{copy.shell.body}</p>
          <TransferMotion copy={copy} stage={flowMotionStage} />
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

        {mode === "send" && seller ? (
          <SellerDashboard
            copy={copy}
            locale={locale}
            seller={seller}
            screen={sellerScreen}
            onScreenChange={setSellerScreen}
            files={sellerFiles}
            filesStatus={sellerFilesStatus}
            newSellerAccessKey={newSellerAccessKey}
            displayNameInput={sellerDisplayName}
            onDisplayNameChange={setSellerDisplayName}
            settingsSaveStatus={settingsSaveStatus}
            onSaveSettings={() => void onSaveSettings()}
            publicLinkCopied={publicLinkCopied}
            onCopyPublicLink={() => void onCopyPublicLink()}
            isBusy={isBusy}
          >
            {sellerScreen === "create" ? (
              <>
                {canPublishFile ? (
                  <form className="zk-hub-form" onSubmit={onCreateLink}>
                    <label className="zk-hub-form-field">
                      <span className="zk-hub-form-label">
                        {copy.send.fileLabel}
                      </span>
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
                      <span className="zk-hub-form-label">
                        {copy.send.priceLabel}
                      </span>
                      <input
                        value={priceZec}
                        onChange={(event) => setPriceZec(event.target.value)}
                        inputMode="decimal"
                        disabled={isBusy}
                      />
                      <span className="zk-hub-form-hint">
                        {copy.send.priceHint}
                      </span>
                    </label>

                    <label className="zk-hub-form-field">
                      <span className="zk-hub-form-label">
                        {copy.send.noteLabel}
                      </span>
                      <textarea
                        value={sellerNote}
                        onChange={(event) => setSellerNote(event.target.value)}
                        placeholder={copy.send.notePlaceholder}
                        disabled={isBusy}
                        rows={3}
                      />
                    </label>

                    <button
                      className="button-primary"
                      type="submit"
                      disabled={isBusy}
                    >
                      {busyAction === "encrypting"
                        ? copy.send.busyLabel
                        : copy.send.submitLabel}
                    </button>
                  </form>
                ) : null}

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
                        onClick={() =>
                          void navigator.clipboard.writeText(shareUrl)
                        }
                      >
                        {copy.send.copyLinkLabel}
                      </button>
                      <a className="button-primary" href={shareUrl}>
                        {copy.send.openLinkLabel}
                      </a>
                    </div>
                    <OrderDetails order={createdOrder} copy={copy} />

                    <SellerReleasePanel
                      order={createdOrder}
                      locale={locale}
                      busy={busyAction === "release"}
                      releaseMessage={releaseMessage}
                      buyerCode={sellerBuyerCode}
                      codeConfirmed={sellerCodeConfirmed}
                      onConfirmCodeChange={setSellerCodeConfirmed}
                      onRevealCode={() => void onRevealBuyerCode(createdOrder)}
                      onRelease={() => void onReleaseSellerKey(createdOrder)}
                      disabled={isBusy}
                    />
                  </div>
                ) : null}
              </>
            ) : null}
          </SellerDashboard>
        ) : mode === "send" ? (
          <section className="frame zectime-paid-panel surface-reveal">
            <div className="zectime-paid-panel-copy">
              <p className="eyebrow">{copy.tabs.send}</p>
              <h2>{copy.send.title}</h2>
              <p>{copy.send.body}</p>
              <SellerShopArt copy={copy} authMode={sellerAuthMode} />
            </div>

            <div className="zectime-paid-result zectime-seller-auth">
              <div>
                <p className="eyebrow">{copy.seller.title}</p>
                <p>{copy.seller.body}</p>
              </div>

              {
                <>
                  <div className="zectime-paid-tabs" role="tablist">
                    <button
                      type="button"
                      className="zectime-paid-tab"
                      data-active={sellerAuthMode === "create"}
                      onClick={() => setSellerAuthMode("create")}
                    >
                      {copy.seller.createTab}
                    </button>
                    <button
                      type="button"
                      className="zectime-paid-tab"
                      data-active={sellerAuthMode === "login"}
                      onClick={() => setSellerAuthMode("login")}
                    >
                      {copy.seller.loginTab}
                    </button>
                  </div>

                  <div className="zk-hub-form">
                    {sellerAuthMode === "create" ? (
                      <>
                        <section className="zk-hub-form-section">
                          <p className="zk-hub-form-section-title">
                            {copy.seller.sectionIdentityTitle}
                          </p>
                          <label className="zk-hub-form-field">
                            <span className="zk-hub-form-label">
                              {copy.seller.handleLabel}
                            </span>
                            <input
                              value={sellerHandle}
                              onChange={(event) =>
                                setSellerHandle(event.target.value)
                              }
                              placeholder={copy.seller.handlePlaceholder}
                              disabled={isBusy}
                            />
                          </label>
                          <label className="zk-hub-form-field">
                            <span className="zk-hub-form-label">
                              {copy.seller.displayNameLabel}
                            </span>
                            <input
                              value={sellerDisplayName}
                              onChange={(event) =>
                                setSellerDisplayName(event.target.value)
                              }
                              placeholder={copy.seller.displayNamePlaceholder}
                              disabled={isBusy}
                            />
                          </label>
                        </section>
                        <section className="zk-hub-form-section">
                          <p className="zk-hub-form-section-title">
                            {copy.seller.sectionPayoutTitle}
                          </p>
                          <p className="zk-hub-form-section-note">
                            {copy.seller.sectionPayoutNote}
                          </p>
                          <div
                            className="zectime-paid-warning"
                            role="note"
                            data-tone="warning"
                          >
                            <p className="eyebrow">
                              {copy.seller.ufvkWarningTitle}
                            </p>
                            <p>{copy.seller.ufvkWarningBody}</p>
                          </div>
                          <label className="zk-hub-form-field">
                            <span className="zk-hub-form-label">
                              {copy.seller.ufvkLabel}
                            </span>
                            <textarea
                              value={sellerUfvk}
                              onChange={(event) =>
                                setSellerUfvk(event.target.value)
                              }
                              placeholder={copy.seller.ufvkPlaceholder}
                              autoComplete="off"
                              spellCheck={false}
                              rows={3}
                              disabled={isBusy}
                            />
                            <span className="zk-hub-form-hint">
                              {copy.seller.ufvkHint}
                            </span>
                          </label>
                          {ufvkPreview.status !== "idle" ? (
                            <div
                              className="zk-hub-ufvk-preview"
                              data-state={ufvkPreview.status}
                            >
                              {ufvkPreview.status === "checking" ? (
                                <span>{copy.seller.ufvkPreviewChecking}</span>
                              ) : ufvkPreview.status === "valid" ? (
                                <>
                                  <span className="zk-hub-ufvk-preview-label">
                                    {copy.seller.ufvkPreviewReceives}
                                  </span>
                                  <code>{ufvkPreview.address}</code>
                                </>
                              ) : (
                                <span>{copy.seller.ufvkPreviewInvalid}</span>
                              )}
                            </div>
                          ) : null}
                          {sellerUfvk.trim() ? (
                            <label className="zk-hub-form-check">
                              <input
                                type="checkbox"
                                checked={ufvkAcknowledged}
                                onChange={(event) =>
                                  setUfvkAcknowledged(event.target.checked)
                                }
                                disabled={isBusy}
                              />
                              <span>{copy.seller.ufvkAckLabel}</span>
                            </label>
                          ) : null}
                        </section>
                      </>
                    ) : (
                      <>
                        <label className="zk-hub-form-field">
                          <span className="zk-hub-form-label">
                            {copy.seller.handleLabel}
                          </span>
                          <input
                            value={sellerHandle}
                            onChange={(event) =>
                              setSellerHandle(event.target.value)
                            }
                            placeholder={copy.seller.handlePlaceholder}
                            disabled={isBusy}
                          />
                        </label>
                        <label className="zk-hub-form-field">
                          <span className="zk-hub-form-label">
                            {copy.seller.accessKeyLabel}
                          </span>
                          <input
                            value={sellerAccessKey}
                            onChange={(event) =>
                              setSellerAccessKey(event.target.value)
                            }
                            placeholder={copy.seller.accessKeyPlaceholder}
                            autoComplete="off"
                            disabled={isBusy}
                          />
                        </label>
                      </>
                    )}
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={
                        isBusy ||
                        (sellerAuthMode === "create" &&
                          sellerUfvk.trim().length > 0 &&
                          !ufvkAcknowledged)
                      }
                      onClick={() =>
                        sellerAuthMode === "create"
                          ? void onCreateSeller()
                          : void onLoginSeller()
                      }
                    >
                      {sellerAuthMode === "create"
                        ? copy.seller.createLabel
                        : copy.seller.loginLabel}
                    </button>
                  </div>
                </>
              }

              {newSellerAccessKey ? (
                <div className="zectime-key-vault">
                  <div>
                    <p className="eyebrow">{copy.seller.accessKeySavedTitle}</p>
                    <p>{copy.seller.accessKeySavedBody}</p>
                  </div>
                  <code>{newSellerAccessKey}</code>
                  <div className="zectime-paid-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => void onCopyNewSellerAccessKey()}
                    >
                      {accessKeyCopied
                        ? copy.seller.accessKeyCopiedLabel
                        : copy.seller.accessKeyCopyLabel}
                    </button>
                    <label className="zectime-key-confirm">
                      <input
                        type="checkbox"
                        checked={accessKeyAcknowledged}
                        onChange={(event) =>
                          setAccessKeyAcknowledged(event.target.checked)
                        }
                      />
                      <span>{copy.seller.accessKeyConfirmLabel}</span>
                    </label>
                  </div>
                  {!accessKeyAcknowledged ? (
                    <p className="zectime-key-lock">
                      {copy.seller.accessKeyBlocker}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {ufvkConfirmation ? (
                <div className="zectime-key-vault" data-tone="ok">
                  <div>
                    <p className="eyebrow">{copy.seller.ufvkConfirmedTitle}</p>
                    <p>{copy.seller.ufvkConfirmedBody}</p>
                  </div>
                  <dl className="zk-hub-detail-list">
                    <dt>{copy.seller.ufvkFingerprintLabel}</dt>
                    <dd>
                      <code>{ufvkConfirmation.ufvkFingerprint}</code>
                    </dd>
                    <dt>{copy.seller.ufvkAddressLabel}</dt>
                    <dd>
                      <code>{ufvkConfirmation.defaultAddress}</code>
                    </dd>
                  </dl>
                </div>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="frame zectime-paid-panel surface-reveal">
            <div className="zectime-paid-panel-copy">
              <p className="eyebrow">{copy.tabs.receive}</p>
              <h2>{copy.receive.title}</h2>
              <p>{copy.receive.body}</p>
              <BrandRail copy={copy} />
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
              <div className="zectime-nym-receiver">
                <div>
                  <p className="eyebrow">{copy.receive.privateReceiverLabel}</p>
                  <p>
                    {nymMessage ||
                      (buyerNymAddress
                        ? copy.receive.nymReadyLabel
                        : copy.receive.privateReceiverBody)}
                  </p>
                </div>
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => setShowManualNymAddress((current) => !current)}
                  disabled={isBusy}
                >
                  {showManualNymAddress
                    ? copy.receive.manualNymHideLabel
                    : copy.receive.manualNymLabel}
                </button>
              </div>
              {showManualNymAddress ? (
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
              ) : null}
              <button
                className="button-secondary"
                type="submit"
                disabled={isBusy}
              >
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
                    {payment ? (
                      <PaymentDetails
                        payment={payment}
                        priceZec={loadedOrder.price.displayZec}
                        copy={copy}
                      />
                    ) : null}
                    {!loadedOrder.payment ? (
                      <p className="zk-hub-form-hint">
                        {copy.receive.paymentAddressHint}
                      </p>
                    ) : null}
                    {loadedOrder.payment?.status === "paid" &&
                    loadedOrder.release?.status === "seller_pending" ? (
                      <p className="zk-hub-form-hint">
                        {locale === "pt"
                          ? "Pagamento confirmado. Aguardando o vendedor liberar a chave (custodia do vendedor)."
                          : "Payment confirmed. Awaiting seller key release (seller-held custody)."}
                      </p>
                    ) : null}
                    {buyerVerificationCode ? (
                      <div className="zectime-verification-code">
                        <p className="eyebrow">
                          {locale === "pt"
                            ? "Codigo de verificacao"
                            : "Verification code"}
                        </p>
                        <code>{buyerVerificationCode}</code>
                        <p className="zk-hub-form-hint">
                          {locale === "pt"
                            ? "Codigo de verificacao acima. Se quiser confirmar um canal privado, passe este codigo ao vendedor antes de ele liberar a chave."
                            : "Verification code above. To confirm a private channel, share this code with the seller before they release the key."}
                        </p>
                      </div>
                    ) : null}
                  </div>
                  <div className="zectime-paid-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={() => void onCreatePayment()}
                      disabled={
                        isBusy || loadedOrder.payment?.status === "paid"
                      }
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

function SellerDashboard({
  copy,
  locale,
  seller,
  screen,
  onScreenChange,
  files,
  filesStatus,
  newSellerAccessKey,
  displayNameInput,
  onDisplayNameChange,
  settingsSaveStatus,
  onSaveSettings,
  publicLinkCopied,
  onCopyPublicLink,
  isBusy,
  children,
}: {
  copy: PaidPrivateFileCopy;
  locale: ProductLocale;
  seller: SellerProfile;
  screen: SellerScreen;
  onScreenChange: (screen: SellerScreen) => void;
  files: SellerFile[];
  filesStatus: "idle" | "loading" | "ready" | "error";
  newSellerAccessKey: string;
  displayNameInput: string;
  onDisplayNameChange: (value: string) => void;
  settingsSaveStatus: "idle" | "saving" | "saved";
  onSaveSettings: () => void;
  publicLinkCopied: boolean;
  onCopyPublicLink: () => void;
  isBusy: boolean;
  children: ReactNode;
}) {
  const tabs: Array<{ screen: SellerScreen; label: string }> = [
    { screen: "dashboard", label: copy.dashboard.tabDashboard },
    { screen: "files", label: copy.dashboard.tabFiles },
    { screen: "settings", label: copy.dashboard.tabSettings },
  ];
  const activeTab = screen === "create" ? "dashboard" : screen;

  return (
    <section className="frame ppf-shop surface-reveal">
      <header className="ppf-shop-header">
        <div className="ppf-shop-identity">
          <h2>{seller.displayName}</h2>
          <p className="ppf-shop-handle">@{seller.handle}</p>
        </div>
        <button
          type="button"
          className="button-primary ppf-shop-cta"
          onClick={() => onScreenChange("create")}
        >
          {copy.dashboard.createFileCta}
        </button>
      </header>

      <nav className="ppf-shop-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.screen}
            type="button"
            role="tab"
            className="ppf-shop-tab"
            data-active={activeTab === tab.screen}
            aria-selected={activeTab === tab.screen}
            onClick={() => onScreenChange(tab.screen)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {screen === "create" ? (
        <div className="ppf-shop-screen">
          <button
            type="button"
            className="ppf-shop-back"
            onClick={() => onScreenChange("dashboard")}
          >
            ← {copy.dashboard.backToDashboard}
          </button>
          {children}
        </div>
      ) : screen === "settings" ? (
        <SellerSettingsScreen
          copy={copy}
          locale={locale}
          seller={seller}
          displayNameInput={displayNameInput}
          onDisplayNameChange={onDisplayNameChange}
          settingsSaveStatus={settingsSaveStatus}
          onSaveSettings={onSaveSettings}
          publicLinkCopied={publicLinkCopied}
          onCopyPublicLink={onCopyPublicLink}
          isBusy={isBusy}
        />
      ) : screen === "files" ? (
        <div className="ppf-shop-screen">
          <SellerFilesList
            copy={copy}
            locale={locale}
            files={files}
            filesStatus={filesStatus}
          />
        </div>
      ) : (
        <div className="ppf-shop-screen">
          <SellerReceivingCard copy={copy} seller={seller} />
          {newSellerAccessKey ? null : (
            <div className="ppf-shop-reminder" role="note">
              <p className="eyebrow">{copy.dashboard.accessKeyReminderTitle}</p>
              <p>{copy.dashboard.accessKeyReminderBody}</p>
            </div>
          )}
          <SellerFilesList
            copy={copy}
            locale={locale}
            files={files}
            filesStatus={filesStatus}
          />
        </div>
      )}
    </section>
  );
}

function SellerReceivingCard({
  copy,
  seller,
}: {
  copy: PaidPrivateFileCopy;
  seller: SellerProfile;
}) {
  const fingerprint = seller.ufvkFingerprint
    ? `${seller.ufvkFingerprint.slice(0, 8)}…`
    : null;
  const network = seller.network ?? "main";
  return (
    <div className="ppf-receiving-card">
      <div className="ppf-receiving-head">
        <p className="eyebrow">{copy.dashboard.receivingTitle}</p>
      </div>
      <dl className="ppf-receiving-grid">
        <div>
          <dt>{copy.dashboard.receivingAccountLabel}</dt>
          <dd>
            <code className="ppf-receiving-address">
              {seller.defaultPayoutAddress}
            </code>
          </dd>
        </div>
        <div>
          <dt>{copy.dashboard.viewingKeyLabel}</dt>
          <dd className="ppf-receiving-key">
            {fingerprint ? (
              <>
                <code>{fingerprint}</code>
                <span className="ppf-tag ppf-tag-ok">
                  {copy.dashboard.viewingKeyHeldBy}
                </span>
              </>
            ) : (
              <span className="ppf-muted">{copy.dashboard.viewingKeyNone}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{copy.dashboard.networkLabel}</dt>
          <dd>{network}</dd>
        </div>
      </dl>
      <p className="ppf-receiving-helper">{copy.dashboard.receivingHelper}</p>
    </div>
  );
}

function SellerFilesList({
  copy,
  locale,
  files,
  filesStatus,
}: {
  copy: PaidPrivateFileCopy;
  locale: ProductLocale;
  files: SellerFile[];
  filesStatus: "idle" | "loading" | "ready" | "error";
}) {
  return (
    <div className="ppf-files">
      <p className="eyebrow">{copy.dashboard.filesTitle}</p>
      {filesStatus === "loading" && files.length === 0 ? (
        <p className="ppf-muted">{copy.dashboard.filesLoading}</p>
      ) : files.length === 0 ? (
        <div className="ppf-files-empty">
          <p className="ppf-files-empty-title">
            {copy.dashboard.filesEmptyTitle}
          </p>
          <p className="ppf-muted">{copy.dashboard.filesEmptyBody}</p>
        </div>
      ) : (
        <ul className="ppf-files-list">
          {files.map((file) => (
            <li key={file.orderId} className="ppf-file-row">
              <div className="ppf-file-main">
                <span className="ppf-file-name">{file.fileName}</span>
                <span className="ppf-file-price">{file.displayZec} ZEC</span>
              </div>
              <div className="ppf-file-side">
                <span className="ppf-status-badge" data-status={file.status}>
                  {formatFileStatus(file.status, copy)}
                </span>
                <a
                  className="ppf-file-open"
                  href={withProductLocale(file.sharePath, locale)}
                >
                  {copy.dashboard.fileOpenLabel}
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SellerSettingsScreen({
  copy,
  locale,
  seller,
  displayNameInput,
  onDisplayNameChange,
  settingsSaveStatus,
  onSaveSettings,
  publicLinkCopied,
  onCopyPublicLink,
  isBusy,
}: {
  copy: PaidPrivateFileCopy;
  locale: ProductLocale;
  seller: SellerProfile;
  displayNameInput: string;
  onDisplayNameChange: (value: string) => void;
  settingsSaveStatus: "idle" | "saving" | "saved";
  onSaveSettings: () => void;
  publicLinkCopied: boolean;
  onCopyPublicLink: () => void;
  isBusy: boolean;
}) {
  const saveLabel =
    settingsSaveStatus === "saving"
      ? copy.dashboard.settingsSavingLabel
      : settingsSaveStatus === "saved"
        ? copy.dashboard.settingsSavedLabel
        : copy.dashboard.settingsSaveLabel;
  return (
    <div className="ppf-shop-screen">
      <section className="ppf-settings-block">
        <p className="eyebrow">{copy.dashboard.settingsIdentityTitle}</p>
        <label className="zk-hub-form-field">
          <span className="zk-hub-form-label">
            {copy.seller.publicRouteLabel}
          </span>
          <input value={`@${seller.handle}`} readOnly disabled />
        </label>
        <label className="zk-hub-form-field">
          <span className="zk-hub-form-label">
            {copy.dashboard.settingsDisplayNameLabel}
          </span>
          <input
            value={displayNameInput}
            onChange={(event) => onDisplayNameChange(event.target.value)}
            disabled={isBusy}
          />
        </label>
        <button
          type="button"
          className="button-secondary"
          onClick={onSaveSettings}
          disabled={isBusy || settingsSaveStatus === "saving"}
        >
          {saveLabel}
        </button>
      </section>

      <section className="ppf-settings-block">
        <p className="eyebrow">{copy.dashboard.settingsReceivingTitle}</p>
        <SellerReceivingCard copy={copy} seller={seller} />
      </section>

      <section className="ppf-settings-block">
        <p className="eyebrow">{copy.dashboard.settingsPublicLinkTitle}</p>
        <code className="ppf-receiving-address">
          {withProductLocale(seller.publicPath, locale)}
        </code>
        <button
          type="button"
          className="button-secondary"
          onClick={onCopyPublicLink}
        >
          {publicLinkCopied
            ? copy.dashboard.settingsPublicLinkCopied
            : copy.dashboard.settingsPublicLinkCopy}
        </button>
      </section>
    </div>
  );
}

function formatFileStatus(
  status: TransferPublicOrder["status"],
  copy: PaidPrivateFileCopy,
): string {
  switch (status) {
    case "payment_pending":
      return copy.dashboard.statusPaymentPending;
    case "paid":
      return copy.dashboard.statusPaid;
    case "claimed":
      return copy.dashboard.statusClaimed;
    case "created":
    default:
      return copy.dashboard.statusCreated;
  }
}

function BrandRail({ copy }: { copy: PaidPrivateFileCopy }) {
  return (
    <div className="zectime-brand-rail" aria-label={copy.brand.railLabel}>
      <BrandMark kind="zcash" label={copy.brand.zcash} />
      <div className="zectime-brand-connector" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <BrandMark kind="nym" label={copy.brand.nym} />
      <p>{copy.brand.railBody}</p>
    </div>
  );
}

function SellerShopArt({
  copy,
  authMode,
}: {
  copy: PaidPrivateFileCopy;
  authMode: SellerAuthMode;
}) {
  const primaryLabel =
    authMode === "create" ? copy.seller.createTab : copy.seller.loginTab;
  const secondaryLabel =
    authMode === "create"
      ? copy.send.payoutAddressLabel
      : copy.seller.accessKeyLabel;

  return (
    <div className="zectime-shop-art" data-mode={authMode}>
      <div className="zectime-shop-art-logos" aria-label={copy.brand.railLabel}>
        <BrandMark kind="zcash" label={copy.brand.zcash} />
        <div className="zectime-shop-art-line" aria-hidden="true">
          <span />
          <span />
        </div>
        <BrandMark kind="nym" label={copy.brand.nym} />
      </div>

      <div className="zectime-shop-art-canvas" aria-hidden="true">
        <div className="zectime-shop-route-card" />
        <div className="zectime-shop-file-stack">
          <span />
          <span />
          <span />
        </div>
        <div className="zectime-shop-vault">
          <span />
        </div>
      </div>

      <div className="zectime-shop-art-footer">
        <span>{primaryLabel}</span>
        <strong>{copy.seller.publicRouteLabel}</strong>
        <em>{secondaryLabel}</em>
      </div>
    </div>
  );
}

function BrandMark({ kind, label }: { kind: "zcash" | "nym"; label: string }) {
  return (
    <span className={`zectime-brand-mark zectime-brand-mark-${kind}`}>
      {kind === "zcash" ? (
        <img src="/brand/zcash-brandmark-yellow.svg" alt="" />
      ) : (
        <img src="/brand/nym-app-icon.svg" alt="" />
      )}
      <span>{label}</span>
    </span>
  );
}

function TransferMotion({
  copy,
  stage,
}: {
  copy: PaidPrivateFileCopy;
  stage: FlowMotionStage;
}) {
  const steps: Array<{ stage: FlowMotionStage; label: string }> = [
    { stage: "transfer", label: copy.motion.transferLabel },
    { stage: "payment", label: copy.motion.paymentLabel },
    { stage: "done", label: copy.motion.doneLabel },
  ];
  const activeIndex = steps.findIndex((step) => step.stage === stage);

  // Compact, static stage strip (no card / orbit / animation): a slim row that
  // sits above the menu and reflects the current flow stage.
  return (
    <ol
      className="zectime-flow-strip"
      data-stage={stage}
      aria-label={copy.motion.title}
    >
      {steps.map((step, index) => {
        const state =
          index < activeIndex
            ? "done"
            : index === activeIndex
              ? "active"
              : "pending";
        return (
          <li key={step.stage} data-state={state}>
            <span className="zectime-flow-dot" aria-hidden="true" />
            <span>{step.label}</span>
          </li>
        );
      })}
    </ol>
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
      {order.seller ? (
        <div>
          <dt>{copy.seller.publicRouteLabel}</dt>
          <dd>@{order.seller.handle}</dd>
        </div>
      ) : null}
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
    </dl>
  );
}

function getFlowMotionStage({
  busyAction,
  createdOrder,
  loadedOrder,
  payment,
  downloadUrl,
  nymStatus,
}: {
  busyAction: BusyAction;
  createdOrder: TransferPublicOrder | null;
  loadedOrder: TransferPublicOrder | null;
  payment: TransferPayment | null;
  downloadUrl: string;
  nymStatus: BrowserNymStatus;
}): FlowMotionStage {
  if (downloadUrl || loadedOrder?.status === "claimed") {
    return "done";
  }
  if (
    busyAction === "encrypting" ||
    busyAction === "unlocking" ||
    busyAction === "nym" ||
    nymStatus === "waiting" ||
    payment?.status === "paid" ||
    loadedOrder?.payment?.status === "paid"
  ) {
    return "transfer";
  }
  if (createdOrder || loadedOrder || payment) {
    return "payment";
  }
  return "transfer";
}

function PaymentDetails({
  payment,
  priceZec,
  copy,
}: {
  payment: TransferPayment;
  priceZec: string;
  copy: PaidPrivateFileCopy;
}) {
  return (
    <dl className="zectime-paid-details zectime-paid-payment-details">
      <div>
        <dt>{copy.details.invoice}</dt>
        <dd>{payment.invoiceId}</dd>
      </div>
      {payment.paymentAddress ? (
        <div className="zectime-paid-details-wide zectime-paid-payaddress">
          <dt>{copy.details.paymentAddress}</dt>
          <dd>{payment.paymentAddress}</dd>
          <PaymentQr
            address={payment.paymentAddress}
            priceZec={priceZec}
            copy={copy}
          />
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

// Render a scannable QR encoding the Zcash payment URI. The data URL is
// generated CLIENT-SIDE in an effect keyed on address + amount so it never runs
// during SSR (qrcode.toDataURL is async + browser-friendly), and the CSP allows
// `img-src data:` so the resulting data URL renders inline.
function PaymentQr({
  address,
  priceZec,
  copy,
}: {
  address: string;
  priceZec: string;
  copy: PaidPrivateFileCopy;
}) {
  const uri = useMemo(
    () => buildZcashPaymentUri(address, priceZec),
    [address, priceZec],
  );
  const [dataUrl, setDataUrl] = useState("");

  useEffect(() => {
    if (!uri) {
      setDataUrl("");
      return;
    }
    let active = true;
    void QRCode.toDataURL(uri, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 192,
      color: { dark: "#0f7048", light: "#ffffff" },
    })
      .then((url) => {
        if (active) {
          setDataUrl(url);
        }
      })
      .catch(() => {
        if (active) {
          setDataUrl("");
        }
      });
    return () => {
      active = false;
    };
  }, [uri]);

  if (!dataUrl) {
    return null;
  }

  const caption = copy.details.qrCaption.replace("{price}", priceZec);
  return (
    <figure className="zectime-paid-qr">
      <img src={dataUrl} alt={copy.details.qrAlt} width={192} height={192} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function SellerReleasePanel({
  order,
  locale,
  busy,
  releaseMessage,
  buyerCode,
  codeConfirmed,
  onConfirmCodeChange,
  onRevealCode,
  onRelease,
  disabled,
}: {
  order: TransferPublicOrder;
  locale: ProductLocale;
  busy: boolean;
  releaseMessage: string;
  buyerCode: string;
  codeConfirmed: boolean;
  onConfirmCodeChange: (confirmed: boolean) => void;
  onRevealCode: () => void;
  onRelease: () => void;
  disabled: boolean;
}) {
  const pt = locale === "pt";
  const released = order.release?.status === "ready";
  const paymentPaid =
    order.payment?.status === "paid" ||
    order.status === "paid" ||
    order.status === "claimed";

  const statusLine = released
    ? formatReleaseStatus("released", locale)
    : paymentPaid
      ? formatReleaseStatus("ready_to_release", locale)
      : order.payment
        ? formatReleaseStatus("waiting_for_payment", locale)
        : formatReleaseStatus("waiting_for_buyer", locale);

  return (
    <div className="zectime-key-vault">
      <div>
        <p className="eyebrow">
          {pt ? "Custodia do vendedor" : "Seller-held key custody"}
        </p>
        <p>
          {pt
            ? "A chave do arquivo fica neste navegador e e embrulhada para o comprador aqui; o servidor nao a recebe diretamente. Mantenha esta aba aberta: a chave e liberada automaticamente quando o pagamento for confirmado."
            : "The file key stays in this browser and is wrapped for the buyer here; the server is not given it directly. Keep this tab open: the key is released automatically once payment is confirmed."}
        </p>
      </div>
      <p className="zk-hub-form-hint">{releaseMessage || statusLine}</p>
      {!released ? (
        <p className="zk-hub-form-hint">
          {pt
            ? "Liberacao automatica confia na chave informada pelo servidor; para verificacao forte, libere manualmente conferindo o codigo."
            : "Auto-release trusts the server-provided buyer key; for strong verification, release manually after confirming the code."}
        </p>
      ) : null}
      {!released && paymentPaid && buyerCode ? (
        <div className="zectime-verification-code">
          <p className="eyebrow">{pt ? "Codigo do comprador" : "Buyer code"}</p>
          <code>{buyerCode}</code>
          <p className="zk-hub-form-hint">
            {pt
              ? "Codigo do comprador acima. Confirme que e igual ao codigo que o comprador te passou (protege contra um servidor malicioso trocar a chave)."
              : "Buyer code above. Confirm it matches the code the buyer gave you (protects against a malicious server swapping the key)."}
          </p>
          <label className="zectime-key-confirm">
            <input
              type="checkbox"
              checked={codeConfirmed}
              onChange={(event) => onConfirmCodeChange(event.target.checked)}
            />
            <span>
              {pt
                ? "Conferi este codigo com o comprador"
                : "I verified this code with the buyer"}
            </span>
          </label>
        </div>
      ) : null}
      {!released ? (
        <div className="zectime-paid-actions">
          {buyerCode ? (
            <button
              type="button"
              className="button-secondary"
              onClick={onRelease}
              disabled={disabled || busy || !paymentPaid || !codeConfirmed}
            >
              {busy
                ? pt
                  ? "Liberando chave..."
                  : "Releasing key..."
                : pt
                  ? "Liberar chave"
                  : "Release key"}
            </button>
          ) : (
            <button
              type="button"
              className="button-secondary"
              onClick={onRevealCode}
              disabled={disabled || busy || !paymentPaid}
            >
              {busy
                ? pt
                  ? "Carregando codigo..."
                  : "Loading code..."
                : pt
                  ? "Conferir codigo e liberar"
                  : "Verify code and release"}
            </button>
          )}
        </div>
      ) : null}
    </div>
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

function formatReleaseStatus(
  status:
    | "waiting_for_payment"
    | "waiting_for_buyer"
    | "ready_to_release"
    | "released",
  locale: ProductLocale,
): string {
  const pt = locale === "pt";
  switch (status) {
    case "released":
      return pt
        ? "Chave liberada. O comprador ja pode abrir o arquivo."
        : "Key released. The buyer can now open the file.";
    case "ready_to_release":
      return pt
        ? "Pagamento confirmado. Liberando a chave para o comprador."
        : "Payment confirmed. Releasing the key to the buyer.";
    case "waiting_for_payment":
      return pt
        ? "Aguardando confirmacao do pagamento antes de liberar a chave."
        : "Waiting for payment confirmation before the key can be released.";
    case "waiting_for_buyer":
    default:
      return pt
        ? "Aguardando o comprador iniciar o pagamento."
        : "Waiting for the buyer to start the payment.";
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

function parseNymClaimPayload(value: string): NymClaimPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schema !== "paidprivatefile.nym.claim.v1") {
    return null;
  }
  if (typeof parsed.orderId !== "string") {
    return null;
  }
  if (!isRecord(parsed.manifest) || !isRecord(parsed.keyEnvelope)) {
    return null;
  }
  const manifest = parsed.manifest;
  if (
    typeof manifest.orderId !== "string" ||
    manifest.orderId !== parsed.orderId ||
    typeof manifest.fileName !== "string" ||
    typeof manifest.mimeType !== "string" ||
    typeof manifest.encryptedFileSha256 !== "string" ||
    typeof manifest.encryptionIv !== "string"
  ) {
    return null;
  }

  const encryptedFileDownload = parseNymFileDownload(
    parsed.encryptedFileDownload,
  );
  const devHttpFallback = parseNymFileDownload(parsed.devHttpFallback);
  return {
    schema: "paidprivatefile.nym.claim.v1",
    orderId: parsed.orderId,
    manifest: {
      orderId: manifest.orderId,
      fileName: manifest.fileName,
      mimeType: manifest.mimeType,
      encryptedFileSha256: manifest.encryptedFileSha256,
      encryptionIv: manifest.encryptionIv,
    },
    keyEnvelope: parsed.keyEnvelope as unknown as PaidLinkKeyEnvelope,
    ...(encryptedFileDownload ? { encryptedFileDownload } : {}),
    ...(devHttpFallback ? { devHttpFallback } : {}),
  };
}

// Browser-direct Nym payload: { schema, orderId, keyEnvelope } only. The buyer
// supplies the manifest + file URL from its own loaded order and claim response.
function parseNymKeyOnlyPayload(
  value: string,
): { orderId: string; keyEnvelope: PaidLinkKeyEnvelope } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schema !== "paidprivatefile.nym.claim.v1") {
    return null;
  }
  if (typeof parsed.orderId !== "string" || !isRecord(parsed.keyEnvelope)) {
    return null;
  }
  return {
    orderId: parsed.orderId,
    keyEnvelope: parsed.keyEnvelope as unknown as PaidLinkKeyEnvelope,
  };
}

function parseNymFileDownload(
  value: unknown,
): NymClaimPayload["encryptedFileDownload"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.url !== "string" || typeof value.expiresAt !== "string") {
    return undefined;
  }
  return {
    url: value.url,
    expiresAt: value.expiresAt,
  };
}

function getStoredBrowserNymClientId(): string | null {
  return window.localStorage.getItem(BUYER_NYM_CLIENT_ID_STORAGE_KEY);
}

function persistBrowserNymClientId(clientId: string): void {
  window.localStorage.setItem(BUYER_NYM_CLIENT_ID_STORAGE_KEY, clientId);
}

// Number of fresh-client attempts the bootstrap makes before giving up. Each
// attempt rotates to a new SDK-selected gateway (see bootstrapBrowserNymClient).
const BROWSER_NYM_GATEWAY_ATTEMPTS = 3;
// Per-attempt selfAddress() poll budget, in 1s ticks. Kept short so a dead
// gateway is abandoned quickly and the next attempt can rotate to a new one.
const BROWSER_NYM_ADDRESS_POLLS = 40;

// Minimal surface the address poll depends on, so it can be exercised in a unit
// test without standing up the full SDK client or any React state.
export interface StartableNymClient {
  client: {
    start: (opts?: Record<string, unknown>) => Promise<void>;
    selfAddress: () => Promise<string | undefined>;
  };
}

// One bootstrap attempt: start the client, then poll selfAddress() until the
// gateway handshake yields an address or the per-attempt budget runs out.
// Returns "" when the gateway never produced an address (the caller then
// rotates to a fresh client).
export async function startAndAwaitNymAddress(
  nym: StartableNymClient,
  options: {
    clientId: string;
    maxPolls?: number;
    waitMs?: (ms: number) => Promise<void>;
  },
): Promise<string> {
  const maxPolls = options.maxPolls ?? BROWSER_NYM_ADDRESS_POLLS;
  const waitMs =
    options.waitMs ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  await nym.client.start({
    clientId: options.clientId,
    nymApiUrl:
      process.env.NEXT_PUBLIC_NYM_API_URL ??
      "https://validator.nymtech.net/api",
    forceTls: process.env.NEXT_PUBLIC_NYM_FORCE_TLS !== "0",
  });

  // selfAddress() can be empty until the gateway handshake completes, so poll
  // for the address instead of reading it once right after start.
  let address = (await nym.client.selfAddress()) ?? "";
  for (let attempt = 0; attempt < maxPolls && !address; attempt += 1) {
    await waitMs(1000);
    address = (await nym.client.selfAddress()) ?? "";
  }
  return address;
}

// Tear down an abandoned client without ever throwing: cleanup must not mask the
// real failure or block the next gateway-rotation attempt.
async function stopBrowserNymClientQuietly(
  nym: BrowserNymClient,
): Promise<void> {
  try {
    await nym.client.stop();
  } catch {
    // Ignore: the client may already be half-open or unstartable.
  }
}

// Frente B: when on, the SELLER browser sends the wrapped key envelope over the
// Nym mixnet directly to the buyer (the server no longer relays it over Nym).
function browserNymDeliveryEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PPF_BROWSER_NYM === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

// Build a Zcash payment URI (ZIP-321 style) the buyer can scan to pay the
// per-order PAYMENT ADDRESS: `zcash:<address>?amount=<ZEC decimal>`. The amount
// is the existing display price string (e.g. "0.0001"); we do not invent
// precision. Returns null when the address is missing so callers can skip the
// QR entirely. Exported for unit testing the URI format.
export function buildZcashPaymentUri(
  address: string | null | undefined,
  amountZec: string | null | undefined,
): string | null {
  const cleanedAddress = (address ?? "").trim();
  if (!cleanedAddress) {
    return null;
  }
  const cleanedAmount = (amountZec ?? "").trim();
  const base = `zcash:${cleanedAddress}`;
  if (!cleanedAmount) {
    return base;
  }
  return `${base}?amount=${encodeURIComponent(cleanedAmount)}`;
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
