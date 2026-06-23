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
  loadProductReleaseDraft,
  loadSellerReleaseDraft,
  saveBuyerKeyPair,
  saveProductReleaseDraft,
  saveSellerReleaseDraft,
  wrapPaidLinkFileKeyForBuyer,
  type PaidLinkBuyerKeyPair,
  type PaidLinkKeyEnvelope,
  type PaidLinkSellerReleaseDraft,
} from "../../../lib/paid-link-client-crypto";
import { selectNextPurchaseToDeliver } from "../../../lib/product-delivery-queue";
import {
  computePurchaseCounts,
  formatPurchaseSummary,
} from "../../../lib/purchase-summary";
import { extractServerErrorMessage } from "../../../lib/server-error-message";
import {
  computeNymReceiveTimeoutMs,
  createNymFileReceiver,
  decodePacket,
  startNymFileSender,
  type NymFileReceiver,
  type TransferMetrics,
} from "../../../lib/nym-file-transfer";
import { createClientTimestampDraft } from "../../../lib/timestamp-client-crypto";
import {
  deleteSellerCiphertext,
  getProductCiphertext,
  getSellerCiphertext,
  putProductCiphertext,
  putSellerCiphertext,
} from "../../../lib/seller-ciphertext-store";
import type { ProductLocale } from "../../../lib/types";
import { withProductLocale } from "../../../lib/locale";
import type { PaidPrivateFileCopy } from "../../../lib/paid-private-file-copy";

interface PaidPrivateFilePanelProps {
  locale: ProductLocale;
  copy: PaidPrivateFileCopy;
  initialOrderId?: string | null;
  // Multi-buyer "product" model (Phase 3b): when set (and productsEnabled()), the
  // panel opens in the PRODUCT-BUYER view for this catalog product — the buyer
  // sees the listing + a Buy button, and a purchase spawns a fresh per-buyer
  // order that drives the EXISTING receive flow. Ignored when the flag is off, so
  // the single-use flow is unchanged.
  initialProductId?: string | null;
  initialSeller?: SellerProfile | null;
  backHref?: string;
  backLabel?: string;
}

// Multi-buyer "product" model (Phase 3b): the buyer-facing listing returned by
// GET /api/products/[id] (secret-stripped PublicProduct). The buyer view reads
// the file name, price, and supply/sold-out state before purchasing.
interface PublicProductListing {
  productId: string;
  status: "open" | "sold_out" | "closed";
  file: {
    fileName: string;
    originalSizeBytes: number;
  };
  price: {
    asset: "ZEC";
    amountZats: number;
    displayZec: string;
  };
  seller: SellerProfile | null;
  supply: { mode: "open" } | { mode: "limited"; max: number };
  salesCount: number;
  remainingSupply: number;
  soldOut: boolean;
}

interface TransferPublicOrder {
  orderId: string;
  status: "created" | "payment_pending" | "paid" | "claimed";
  // Multi-buyer "product" model (Phase 3b): the source product id when this order
  // is a purchase spawned from a catalog product, else null for a single-use
  // order. Mirrors the server TransferPublicOrder.productId. Drives the seller's
  // per-purchase delivery (product release draft + ciphertext) vs. the single-use
  // per-order path.
  productId: string | null;
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
      status:
        | "waiting_for_payment"
        | "ready_for_delivery"
        | "queued"
        | "delivered";
      createdAt: string;
      updatedAt: string;
      lastDelivery?: {
        deliveryId: string;
        transport: "nym-claim-v1" | "nym-transfer-v1";
        status: "queued_local_outbox" | "sent_nym_client" | "delivered";
        queuedAt: string;
        deliveredAt?: string;
      };
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
  // 0-conf "Payment detected": set the first time the scanner reports an
  // unconfirmed mempool sighting. onchain carries the txid/confirmations once a
  // deposit is seen. Neither implies paid (status === "paid" is the gate).
  detectedAt?: string | null;
  onchain?: {
    txid: string;
    amountZats: number;
    confirmations: number;
    paidAt: string;
  } | null;
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
  // Multi-buyer "product" model (Phase 3b): source product id when this order is
  // a purchase of a catalog product, else null for a single-use order. Drives the
  // dashboard grouping of purchases under their product AND the delivery source
  // (a purchase uses the PRODUCT release draft + ciphertext, not a per-order one).
  productId?: string | null;
  // Pure-Nym delivery state for this order. Drives the honest file badge: only a
  // "delivered" ack means "Delivered"; before that a claimed/released order is
  // still "Delivering"/"Awaiting delivery". Optional so older API responses (and
  // orders with no session yet) degrade to the bare status label.
  nymSessionStatus?: string | null;
  // Provenance of a completed delivery: how this order's file reached the buyer.
  // "nym" = streamed over the mixnet; "https" = the Nym fallback fetch; null for
  // orders delivered before the field existed (degrades to a bare "Delivered").
  deliveredVia?: "nym" | "https" | null;
  createdAt: string;
  sharePath: string;
}

interface SellerFilesResponse {
  files: SellerFile[];
}

// Multi-buyer "product" model (Phase 3a): a seller's catalog product as the
// dashboard list summary. Mirrors SellerFile but carries supply/sales instead of
// the single-use delivery status (a product has many purchases, surfaced in 3b).
interface SellerProductSummary {
  productId: string;
  fileName: string;
  displayZec: string;
  status: "open" | "sold_out" | "closed";
  supply: { mode: "open" } | { mode: "limited"; max: number };
  salesCount: number;
  // null for an open (unlimited) product; remaining units for a limited one.
  remainingSupply: number | null;
  soldOut: boolean;
  createdAt: string;
  sharePath: string;
}

interface SellerProductsResponse {
  products: SellerProductSummary[];
}

interface CreateProductResponse {
  product: {
    productId: string;
    file: { fileName: string };
    price: { displayZec: string };
  };
  sharePath: string;
}

// Supply control on the create-product form. "open" = unlimited; "limited" needs
// a positive-integer max.
type ProductSupplyMode = "open" | "limited";

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
    // Binary send used for the chunked file transfer. The SDK delivers these to
    // the recipient's subscribeToRawMessageReceivedEvent untouched.
    rawSend: (args: {
      payload: Uint8Array;
      recipient: string;
      replySurbs?: number;
    }) => Promise<void>;
  };
  events: {
    subscribeToTextMessageReceivedEvent: (
      handler: (event: { args: { payload: string } }) => void | Promise<void>,
    ) => () => void;
    // Inbound raw (binary) messages — the file-transfer chunks.
    subscribeToRawMessageReceivedEvent: (
      handler: (event: {
        args: { payload: Uint8Array };
      }) => void | Promise<void>,
    ) => () => void;
  };
}

type Mode = "send" | "receive";
type SellerAuthMode = "create" | "login";
type SellerScreen = "files" | "settings" | "create" | "manage";
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

// Robust pure-Nym re-send-until-acked loop (seller manage screen): re-emit the
// wrapped key every RESEND_INTERVAL_MS until the buyer ACKs, capped at
// RESEND_MAX_ATTEMPTS (~6s × 20 ≈ 2 min).
const RESEND_INTERVAL_MS = 6000;
const RESEND_MAX_ATTEMPTS = 20;

// Multi-buyer "product" model (Phase 3c): how often the buyer-listing view
// re-fetches a LIMITED product so it flips to sold-out without a manual reload.
// Light interval (7s) — only runs while the buyer is on the listing and has not
// started a purchase yet.
const PRODUCT_LISTING_POLL_INTERVAL_MS = 7000;

const SELLER_PAYOUT_STORAGE_KEY = "paidprivatefile_seller_payout_address";
const SELLER_PRICE_STORAGE_KEY = "paidprivatefile_seller_price_zec";
const BUYER_NYM_CLIENT_ID_STORAGE_KEY = "paidprivatefile_buyer_nym_client_id";

export function PaidPrivateFilePanel({
  locale,
  copy,
  initialOrderId,
  initialProductId,
  initialSeller,
  backHref = "/",
  backLabel,
}: PaidPrivateFilePanelProps) {
  // Multi-buyer "product" model (Phase 3b): only honor initialProductId when the
  // flag is on. With the flag off a product link falls through to the ordinary
  // start screen, so the single-use flow is byte-for-byte unchanged.
  const productBuyerId =
    initialProductId && productsEnabled() ? initialProductId : null;
  // The product-buyer view is a buyer ("receive") surface: it shows a listing +
  // pay/receive, never the seller dashboard. An order link still wins (a buyer
  // who already purchased re-opens their order).
  const [mode, setMode] = useState<Mode>(
    initialOrderId || productBuyerId ? "receive" : "send",
  );
  const [busyAction, setBusyAction] = useState<BusyAction>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [priceZec, setPriceZec] = useState("0.05");
  const [sellerPayoutAddress, setSellerPayoutAddress] = useState("");
  const [sellerNote, setSellerNote] = useState("");
  const [seller, setSeller] = useState<SellerProfile | null>(
    initialSeller ?? null,
  );
  // The page resolves the session server-side (from the cookie) and passes
  // initialSeller — the seller, or null when logged out. When that happened we
  // already know the auth state on the first paint, so the dashboard/start
  // screen renders directly with NO loading splash and no flash on refresh. The
  // splash + client-side check is only a fallback for when the prop is omitted.
  const [sellerSessionChecked, setSellerSessionChecked] = useState(
    initialSeller !== undefined,
  );
  const [sellerAuthMode, setSellerAuthMode] =
    useState<SellerAuthMode>("create");
  // Seller shop: one screen at a time (no stacking). Two tabs — Files and
  // Settings. Defaults to the Files (YOUR FILES) working view whenever a seller
  // is logged in.
  const [sellerScreen, setSellerScreen] = useState<SellerScreen>("files");
  const [sellerFiles, setSellerFiles] = useState<SellerFile[]>([]);
  const [sellerFilesStatus, setSellerFilesStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  // Multi-buyer "product" model (Phase 3a, flag-gated). The seller's catalog
  // products + the create-form supply control + the product success state. All of
  // this is only reachable when productsEnabled() is true; with the flag off none
  // of it renders and the single-use create/dashboard are byte-for-byte unchanged.
  const [sellerProducts, setSellerProducts] = useState<SellerProductSummary[]>(
    [],
  );
  const [sellerProductsStatus, setSellerProductsStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [supplyMode, setSupplyMode] = useState<ProductSupplyMode>("open");
  const [supplyMax, setSupplyMax] = useState("");
  const [createdProduct, setCreatedProduct] =
    useState<CreateProductResponse | null>(null);
  const [productShareUrl, setProductShareUrl] = useState("");
  // Manage/release screen: a single file opened from the dashboard list. We hold
  // the full order (GET /api/transfers/:id) so SellerReleasePanel can read
  // release.status, and a load status so the screen can show loading/error.
  const [manageOrderId, setManageOrderId] = useState<string | null>(null);
  const [manageOrder, setManageOrder] = useState<TransferPublicOrder | null>(
    null,
  );
  const [manageStatus, setManageStatus] = useState<
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
  // Multi-buyer "product" model (Phase 3b): the product-buyer view. The listing
  // is fetched from GET /api/products/[id]; productStatus drives the loading /
  // sold-out / error states; productBuying tracks the in-flight purchase POST.
  // Once a purchase succeeds we set loadedOrder and the EXISTING BuyerCheckout
  // takes over, so none of the pay/receive UI is duplicated.
  const [productListing, setProductListing] =
    useState<PublicProductListing | null>(null);
  const [productStatus, setProductStatus] = useState<
    "idle" | "loading" | "ready" | "error" | "soldout"
  >(productBuyerId ? "loading" : "idle");
  const [productBuying, setProductBuying] = useState(false);
  const [loadedOrder, setLoadedOrder] = useState<TransferPublicOrder | null>(
    null,
  );
  const [payment, setPayment] = useState<TransferPayment | null>(null);
  const [buyerNymAddress, setBuyerNymAddress] = useState("");
  const [showManualNymAddress, setShowManualNymAddress] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadFileName, setDownloadFileName] = useState("");
  // Provenance of the buyer's completed download: which path actually delivered
  // the file. Set the moment the file is decrypted + opened — "nym" when the
  // in-browser Nym file receiver reassembled it over the mixnet, "https" when
  // the HTTPS fallback fetched it. Drives the badge on the "YOUR FILE ARRIVED"
  // card and is propagated to the seller via the delivery ack.
  const [receivedVia, setReceivedVia] = useState<"nym" | "https" | null>(null);
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
  const [sellerBuyerCode, setSellerBuyerCode] = useState("");
  const [sellerCodeConfirmed, setSellerCodeConfirmed] = useState(false);
  // Robust pure-Nym re-send: while the manage screen is open for a released order
  // that the buyer has NOT yet ACKed (nymSession !== "delivered"), the seller
  // browser (which holds the release secret) re-emits the wrapped key every ~6s
  // up to a cap. resendAttempt drives the "Re-sending over Nym… (n)" label.
  const [resending, setResending] = useState(false);
  const [resendAttempt, setResendAttempt] = useState(0);
  // Guards against double-firing the auto re-send tick (a slow send must not
  // overlap the next interval) and tracks the orderId the loop is bound to.
  const resendInFlightRef = useRef(false);
  // Guards the live dashboard files poll: skips a tick while the previous quiet
  // fetch is still running so slow responses never stack overlapping requests.
  const sellerFilesPollInFlightRef = useRef(false);
  const [addressCopied, setAddressCopied] = useState(false);
  // Count of Nym envelopes this receiver has decoded this session — a visible
  // signal in the "Receiving your file…" card that envelopes are actually
  // landing (vs. the receiver never hearing anything). Incremented for every
  // inbound text message the buyer handler is invoked with.
  const [nymEnvelopesReceived, setNymEnvelopesReceived] = useState(0);
  // True once the buyer has the decryption key in hand this session. Drives a
  // calmer receiver status ("key received, receiving file") and freezes the
  // envelope counter so the seller's pre-ack key re-sends don't keep climbing a
  // scary number after the key already arrived. Ref mirrors it for the inbound
  // handler closure (pinned at subscribe); state drives the diagnostic re-render.
  const [buyerKeyReceived, setBuyerKeyReceived] = useState(false);
  const buyerKeyReceivedRef = useRef(false);
  const browserNymClientRef = useRef<BrowserNymClient | null>(null);
  const browserNymUnsubscribeRef = useRef<(() => void) | null>(null);
  // Unsubscribe handle for the inbound RAW (binary) file-chunk subscription,
  // kept separate from the text-envelope subscription above so each can be
  // (re)wired independently when the client (re)bootstraps.
  const browserNymRawUnsubscribeRef = useRef<(() => void) | null>(null);
  // No-rotate guard for an active browser-to-browser FILE transfer. The buyer
  // heartbeat and seller re-send loops re-bootstrap the Nym client and can
  // rotate to a fresh gateway/address; doing that mid-transfer would orphan the
  // in-flight chunks. While this is true, the bootstrap reuses the live client
  // instead of rotating, and the heartbeat skips re-registering the address.
  const transferInProgressRef = useRef(false);
  // In-memory ciphertext for the order being sold from THIS browser this session
  // (kept from encryptPaidLinkFile at create time). Acceptable for MVP: the
  // seller is already required to be online with the creating browser to release
  // the key. Lost on reload — the buyer's HTTPS fallback still works because the
  // ciphertext is also uploaded.
  const sellerCiphertextRef = useRef<Map<string, Uint8Array>>(new Map());
  // Orders whose file is currently being streamed over Nym from this browser, so
  // the per-tick re-send loops do not start a second concurrent transfer for the
  // same order. Cleared when a send settles (so a failed send can be retried).
  const sellerFileSendInFlightRef = useRef<Set<string>>(new Set());
  // Orders for which this seller browser has sent the key envelope at least once
  // this session. Lets the re-send loop PAUSE the key send while the file is
  // streaming (no self-competition on the single Nym gateway, no climbing buyer
  // counter) while still guaranteeing the first key send always goes out.
  const sellerKeySentOnceRef = useRef<Set<string>>(new Set());
  // The active in-browser file receiver (buyer side). Inbound raw chunks are
  // routed here; on complete it resolves the verified ciphertext.
  const nymFileReceiverRef = useRef<NymFileReceiver | null>(null);
  // Buyer side: the P-256 ECDH key envelope received over the Nym TEXT channel,
  // kept by order so the FILE receiver (raw channel) can decrypt the reassembled
  // ciphertext with the same key. The key still arrives over Nym exactly as
  // today; we just stash it instead of immediately fetching over HTTPS.
  const nymKeyEnvelopeRef = useRef<Map<string, PaidLinkKeyEnvelope>>(new Map());
  // Buyer side: ciphertext fully reassembled + SHA-verified over Nym but not yet
  // decrypted because the key envelope had not arrived. Decrypted the moment the
  // key lands (handleNymTextMessage) — removes the file-before-key race.
  const nymReassembledRef = useRef<Map<string, Uint8Array>>(new Map());
  // Buyer side: per-order timer that triggers the HTTPS fallback if the Nym file
  // transfer STALLS (no receive progress) for a generous bound. It is a
  // no-progress stall timer, NOT a fixed wall-clock: a healthy slow transfer of
  // a large file keeps re-arming the timer (see armBuyerHttpsFallback) so it
  // never gets yanked off the Nym path mid-flight.
  const buyerFallbackTimerRef = useRef<Map<string, number>>(new Map());
  // Buyer side: per-order timestamp (Date.now()) of the most recent receive
  // progress, plus the latest received/total so the fallback timer can tell a
  // healthy-but-slow transfer (still progressing, not yet complete) apart from a
  // genuine stall. Browser-only code, so Date.now() is fine here.
  const buyerProgressRef = useRef<
    Map<string, { lastProgressAt: number; received: number; total: number }>
  >(new Map());
  // Orders whose file we have already received (or are actively receiving) over
  // Nym this session, so a duplicate Offer never starts a second receiver.
  const nymFileHandledRef = useRef<Set<string>>(new Set());
  // Screen Wake Lock held during an active seller send so the OS does not sleep
  // the tab mid-transfer (mobile especially). Released when the send ends.
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  // Seller-side file-send progress (0..100) for the "Sending over Nym… N%" UI.
  // null = not sending.
  const [sellerSendProgress, setSellerSendProgress] = useState<number | null>(
    null,
  );
  // Buyer-side file-receive progress (0..100) for the "Receiving over Nym… N%"
  // UI. null = not receiving over Nym (still on the spinner / HTTPS path).
  const [buyerReceiveProgress, setBuyerReceiveProgress] = useState<
    number | null
  >(null);
  // Additive perf instrumentation: the last completed Nym transfer metrics for
  // each side, surfaced in the (dev/diagnostic) readouts. null until the first
  // transfer completes. The primary data channel is the PPF-PERF console line.
  const [buyerTransferMetrics, setBuyerTransferMetrics] =
    useState<TransferMetrics | null>(null);
  const [sellerTransferMetrics, setSellerTransferMetrics] =
    useState<TransferMetrics | null>(null);
  // Guards the buyer heartbeat so a slow (re)bootstrap / re-register tick cannot
  // overlap the next interval and double-start the Nym client.
  const buyerHeartbeatInFlightRef = useRef(false);
  const autoReleaseRef = useRef(false);
  const buyerAutoClaimRef = useRef(false);
  // Idempotency for the Nym receive handler: the seller re-sends the same key
  // envelope until the buyer ACKs, so once this buyer has opened the file we must
  // ignore further envelopes. The Nym subscription closure captures stale state,
  // so the guard reads this ref (kept current by an effect) instead.
  const buyerReceivedRef = useRef(false);
  // The raw/text Nym subscriptions are wired once when the client bootstraps and
  // are NOT re-subscribed when the client is reused (bootstrap returns early on
  // an existing client). So the handler closures capture whatever loadedOrder /
  // downloadUrl existed at wiring time and would drop inbound packets after an
  // order reload / Nym reconnect. These refs (kept current by the effects below)
  // give the handlers LIVE access to that state without re-wiring the
  // subscription. Same pattern as buyerReceivedRef above.
  const loadedOrderRef = useRef<TransferPublicOrder | null>(null);
  const downloadUrlRef = useRef<string>("");
  // Dashboard auto-release: orders this browser has already fired a silent
  // release for, so the periodic dashboard scan never re-releases the same order.
  const dashboardReleasedRef = useRef<Set<string>>(new Set());
  // Dashboard auto re-send-until-acked: the SAME robust pure-Nym loop the Manage
  // screen runs, but driven by the dashboard/files poll so delivery completes
  // with the seller just sitting on the dashboard (no Manage screen needed).
  // dashboardResendInFlightRef guards per-order against a slow send overlapping
  // the next tick; dashboardDelivering powers the subtle "Delivering over Nym…"
  // indicator on the affected file rows.
  const dashboardResendInFlightRef = useRef<Set<string>>(new Set());
  const [dashboardDelivering, setDashboardDelivering] = useState<Set<string>>(
    () => new Set(),
  );
  // Multi-buyer "product" model (Phase 3b): the SEQUENTIAL per-purchase delivery
  // queue. All product purchases share one ~46 KiB/s Nym gateway, so we deliver
  // at most ONE at a time: this holds the orderId of the purchase currently being
  // delivered; the queue starts the next purchase only after this one settles
  // (ack / fail / timeout). Single-use orders use the independent per-order loops
  // above and are never placed in this queue.
  const productDeliveryInFlightRef = useRef<string | null>(null);
  // Buyer auto-download: the object URL we have already auto-saved, so the
  // happy-path programmatic download fires exactly once per decrypted file (a
  // re-render must not re-trigger it). The "Save file" button is always a manual
  // fallback for browsers that block the programmatic click (Safari can be strict).
  const buyerAutoDownloadedRef = useRef<string>("");

  // Multi-buyer "product" model (Phase 3c): guards the buyer-page listing poll so
  // a slow request never stacks with the next interval tick (skip while a fetch
  // is in flight). Plain ref — no re-render needed.
  const productListingFetchingRef = useRef(false);

  useEffect(() => {
    if (!initialOrderId) {
      return;
    }
    void loadOrder(initialOrderId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOrderId]);

  // Multi-buyer "product" model (Phase 3b): when the product-buyer view opens,
  // fetch the listing so the buyer sees the file name, price, and supply before
  // buying. Only runs when productBuyerId is set (flag on + initialProductId), so
  // the single-use buyer flow never hits this endpoint.
  useEffect(() => {
    if (!productBuyerId) {
      return;
    }
    void loadProductListing(productBuyerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productBuyerId]);

  // Multi-buyer "product" model (Phase 3c): while the buyer is still on the
  // listing (no order started yet), poll the product on a light interval so a
  // LIMITED product that just sold its last unit elsewhere flips to sold-out
  // WITHOUT a manual reload — the Buy button disappears on its own. The poll is
  // silent (no loading splash, survives a dropped tick) and the in-flight guard
  // prevents stacked fetches. It stops the moment a purchase starts (loadedOrder
  // set) or the component unmounts (interval cleared). Open products never sell
  // out, so we only poll limited listings — there is nothing for an open product
  // to flip to, so polling it would be pure churn.
  useEffect(() => {
    if (!productBuyerId || loadedOrder) {
      return;
    }
    // Nothing to watch for once it is already sold out, errored, or open supply.
    if (
      productStatus === "soldout" ||
      productStatus === "error" ||
      productListing?.supply.mode !== "limited"
    ) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void loadProductListing(productBuyerId, true);
    }, PRODUCT_LISTING_POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productBuyerId, loadedOrder, productStatus, productListing?.supply.mode]);

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

  // Keep the live mirrors of loadedOrder / downloadUrl current so the pinned Nym
  // raw/text handler closures (wired once at client bootstrap) always read the
  // current order + download state instead of a stale snapshot.
  useEffect(() => {
    loadedOrderRef.current = loadedOrder;
  }, [loadedOrder]);

  useEffect(() => {
    downloadUrlRef.current = downloadUrl;
  }, [downloadUrl]);

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
    if (initialSeller === undefined) {
      void loadSellerSession();
    }

    return () => {
      browserNymUnsubscribeRef.current?.();
      browserNymUnsubscribeRef.current = null;
      browserNymRawUnsubscribeRef.current?.();
      browserNymRawUnsubscribeRef.current = null;
      nymFileReceiverRef.current?.abort("panel unmounted");
      nymFileReceiverRef.current = null;
      void releaseWakeLock();
      const client = browserNymClientRef.current;
      browserNymClientRef.current = null;
      void client?.client.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    } finally {
      setSellerSessionChecked(true);
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

  // Multi-buyer "product" model (Phase 3a): load the seller's catalog products
  // for the dashboard list. Only called when productsEnabled() is true, so the
  // single-use dashboard never hits this endpoint when the flag is off.
  async function loadSellerProducts() {
    setSellerProductsStatus("loading");
    try {
      const body = await postJson<SellerProductsResponse>(
        "/api/sellers/me/products",
        { method: "GET" },
      );
      setSellerProducts(body.products);
      setSellerProductsStatus("ready");
    } catch {
      // Non-fatal: the dashboard still renders without the products list.
      setSellerProductsStatus("error");
    }
  }

  // Seller shop: refresh the files list when the Files screen becomes active for
  // a logged-in seller (mount + screen switch + after a new file is created,
  // which routes back to the Files tab).
  useEffect(() => {
    if (!seller) {
      return;
    }
    if (sellerScreen !== "files") {
      return;
    }
    void loadSellerFiles();
    // Multi-buyer "product" model (Phase 3a): also refresh the products list when
    // the flag is on. With the flag off this branch is skipped, so the dashboard
    // never fetches products and behaves exactly like the single-use dashboard.
    if (productsEnabled()) {
      void loadSellerProducts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seller?.sellerId, sellerScreen]);

  // Live seller dashboard updates (no F5): while the Files screen is
  // mounted for an authenticated seller, silently re-fetch the files list every
  // ~5s so paid→delivered status badges update on their own. This complements
  // (does NOT replace) the mount/screen-switch refresh above and the per-action
  // refreshes; it never touches sellerFilesStatus, so the list never flickers
  // back to "loading" on a poll. Resilience:
  //  - one interval per active screen (cleared on unmount/screen change) so
  //    intervals never stack;
  //  - sellerFilesPollInFlightRef skips a tick while a fetch is still running;
  //  - it only reads /api/sellers/me/files, so it is fully independent of the
  //    manage-screen poll + the auto re-send-until-acked loops.
  useEffect(() => {
    if (!seller) {
      return;
    }
    if (sellerScreen !== "files") {
      return;
    }
    let active = true;
    const interval = window.setInterval(() => {
      if (sellerFilesPollInFlightRef.current) {
        return;
      }
      sellerFilesPollInFlightRef.current = true;
      void (async () => {
        try {
          const body = await postJson<SellerFilesResponse>(
            "/api/sellers/me/files",
            { method: "GET" },
          );
          if (active) {
            setSellerFiles(body.files);
            setSellerFilesStatus("ready");
          }
          // Multi-buyer "product" model (Phase 3c): also re-fetch the products on
          // the same live tick (flag-gated) so a product that just sold its last
          // unit flips to its sold-out row + disables Copy WITHOUT a manual
          // refresh. Silent — never touches sellerProductsStatus, so the list
          // never flickers to "loading"; a transient failure leaves the last good
          // products in place. With the flag off this branch is skipped, so the
          // dashboard never fetches products and is byte-for-byte unchanged.
          if (active && productsEnabled()) {
            try {
              const productsBody = await postJson<SellerProductsResponse>(
                "/api/sellers/me/products",
                { method: "GET" },
              );
              if (active) {
                setSellerProducts(productsBody.products);
              }
            } catch {
              // Non-fatal: leave the last good products list untouched.
            }
          }
        } catch {
          // Transient polling failures are non-fatal; retry on the next tick and
          // leave the last good list (and its status) untouched.
        } finally {
          sellerFilesPollInFlightRef.current = false;
        }
      })();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seller?.sellerId, sellerScreen]);

  // Open a single file's manage/release screen from the dashboard list. The files
  // summary does NOT carry release.status, so we fetch the full order here and
  // hand it to SellerReleasePanel (the same machinery used in create-success).
  async function loadManageOrder(orderId: string) {
    setManageStatus("loading");
    setManageOrder(null);
    setReleaseMessage("");
    setSellerBuyerCode("");
    setSellerCodeConfirmed(false);
    try {
      const body = await postJson<{ order: TransferPublicOrder }>(
        `/api/transfers/${encodeURIComponent(orderId)}`,
        { method: "GET" },
      );
      setManageOrder(body.order);
      setManageStatus("ready");
      // No explicit re-send here: the auto re-send-until-acked loop (keyed on the
      // manage screen + a released, undelivered order) fires its first tick as
      // soon as this manageOrder is set, so a buyer who missed the one-shot
      // delivery gets it without a redundant double-send on open.
    } catch {
      setManageStatus("error");
    }
  }

  function onOpenManage(orderId: string) {
    setManageOrderId(orderId);
    setSellerScreen("manage");
    void loadManageOrder(orderId);
  }

  // Manage screen state writes flow through the shared release helpers, which call
  // applyOrderState (it updates createdOrder/loadedOrder). Mirror the released
  // order into manageOrder so the open manage screen reflects the new release
  // status immediately after a manual release.
  useEffect(() => {
    if (sellerScreen !== "manage" || !manageOrderId) {
      return;
    }
    const released =
      loadedOrder?.orderId === manageOrderId ? loadedOrder : null;
    if (released) {
      setManageOrder(released);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedOrder, sellerScreen, manageOrderId]);

  // Manage-screen order poll (~5s): while a single file's manage screen is open,
  // refresh the full order so the seller stepper + delivery status reflect the
  // buyer's pure-Nym ack (nymSession.status flips to "delivered"). This is what
  // lets the auto re-send loop below STOP once the buyer confirms receipt. Stops
  // once delivered.
  useEffect(() => {
    if (sellerScreen !== "manage" || !manageOrderId) {
      return;
    }
    if (manageOrder?.delivery.nymSession?.status === "delivered") {
      return;
    }
    const orderId = manageOrderId;
    let active = true;
    const interval = window.setInterval(() => {
      void (async () => {
        try {
          const body = await postJson<{ order: TransferPublicOrder }>(
            `/api/transfers/${encodeURIComponent(orderId)}`,
            { method: "GET" },
          );
          if (active) {
            setManageOrder(body.order);
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
  }, [sellerScreen, manageOrderId, manageOrder?.delivery.nymSession?.status]);

  // Auto re-send-until-acked (~6s, up to RESEND_MAX_ATTEMPTS ≈ 2 min): while the
  // manage screen is open for a RELEASED order the buyer has not yet ACKed, and
  // THIS browser holds the release secret, re-emit the wrapped key over Nym so a
  // buyer who is now listening (but missed the one-shot delivery) finally gets
  // it. Stops the instant the manage poll above reports nymSession "delivered".
  // resendInFlightRef guards against a slow send overlapping the next tick.
  useEffect(() => {
    const order = manageOrder;
    if (
      sellerScreen !== "manage" ||
      !order ||
      order.orderId !== manageOrderId
    ) {
      setResending(false);
      setResendAttempt(0);
      return;
    }
    const released = order.release?.status === "ready";
    const delivered = order.delivery.nymSession?.status === "delivered";
    const hasSecret = Boolean(loadSellerReleaseDraft(order.orderId));
    if (!released || delivered || !hasSecret) {
      setResending(false);
      setResendAttempt(0);
      return;
    }

    const resendOrder: TransferPublicOrder = order;
    let active = true;
    let attempts = 0;
    setResending(true);
    setResendAttempt(0);

    async function resendTick() {
      if (!active || resendInFlightRef.current) {
        return;
      }
      if (attempts >= RESEND_MAX_ATTEMPTS) {
        setResending(false);
        return;
      }
      resendInFlightRef.current = true;
      attempts += 1;
      setResendAttempt(attempts);
      try {
        await onResendKeyOverNym(resendOrder, { silent: true });
      } finally {
        resendInFlightRef.current = false;
      }
    }

    void resendTick();
    const interval = window.setInterval(() => {
      void resendTick();
    }, RESEND_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sellerScreen,
    manageOrderId,
    manageOrder?.orderId,
    manageOrder?.release?.status,
    manageOrder?.delivery.nymSession?.status,
  ]);

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
          body: JSON.stringify({ accessKey: sellerAccessKey }),
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
    setSellerScreen("files");
  }

  // Sign out: clear the server session cookie (best-effort) and wipe every
  // seller field locally so the start screen (Create shop / Log in) reappears.
  async function onLogout() {
    setErrorMessage("");
    try {
      await postJson<{ ok: boolean }>("/api/seller-session", {
        method: "DELETE",
      });
    } catch {
      // Best-effort: drop the local session even if the request fails.
    }
    setSeller(null);
    setSellerScreen("files");
    setSellerAuthMode("login");
    setSellerFiles([]);
    setSellerFilesStatus("idle");
    setNewSellerAccessKey("");
    setAccessKeyAcknowledged(false);
    setAccessKeyCopied(false);
    setSellerAccessKey("");
    setSellerHandle("");
    setSellerDisplayName("");
    setSellerPayoutAddress("");
    setSellerUfvk("");
    setUfvkAcknowledged(false);
    setUfvkConfirmation(null);
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
      // A 409 here means another seller already uses this public name. Show the
      // dedicated, prefix-free message instead of the generic "Paid link failed:"
      // wrapper so the user knows exactly what to change.
      if (error instanceof ApiError && error.status === 409) {
        setErrorMessage(copy.errors.displayNameTaken);
      } else {
        setErrorMessage(formatError(error, copy.errors.serverError));
      }
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

  // Recovery for a logged-in seller who lost their access key. Only the hash is
  // stored, so the only path is to ROTATE: the server mints a new key and
  // invalidates the old one. We surface the new key through the same prominent
  // "save it once" callout (Feature 1) by setting newSellerAccessKey and
  // un-acknowledging it.
  async function onRegenerateAccessKey() {
    if (!seller) {
      return;
    }
    setErrorMessage("");
    setBusyAction("seller");
    try {
      const body = await postJson<{ accessKey: string }>(
        "/api/sellers/me/access-key",
        { method: "POST" },
      );
      setNewSellerAccessKey(body.accessKey);
      setAccessKeyCopied(false);
      setAccessKeyAcknowledged(false);
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  async function onCreateLink(event: FormEvent<HTMLFormElement>) {
    // Multi-buyer "product" model (Phase 3a): when the flag is on, the seller's
    // "Create" publishes a PRODUCT instead of a single-use file. Delegate before
    // touching ANY single-use state so the flag-off path below is byte-for-byte
    // unchanged. With the flag off this branch is never taken.
    if (productsEnabled()) {
      await onCreateProduct(event);
      return;
    }

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
      // Keep the encrypted bytes in memory for THIS session so the seller can
      // stream the file to the buyer over Nym (browser-to-browser). Acceptable
      // for MVP: the seller is already required to be online with the creating
      // browser to release the key. If lost (reload), the buyer's HTTPS fallback
      // still works because the ciphertext is also uploaded.
      try {
        const encryptedBytes = new Uint8Array(
          await encrypted.encryptedFile.arrayBuffer(),
        );
        sellerCiphertextRef.current.set(body.order.orderId, encryptedBytes);
        // Also persist to IndexedDB (best-effort, never blocks create) so this
        // browser can still deliver the file over Nym after a reload / in a
        // later session. Any IndexedDB failure leaves the in-memory + HTTPS
        // fallback behavior unchanged.
        void putSellerCiphertext(body.order.orderId, encryptedBytes).catch(
          () => undefined,
        );
      } catch {
        // Non-fatal: without the in-memory bytes the buyer uses HTTPS.
      }
      const href = new URL(
        withProductLocale(body.sharePath, locale),
        window.location.origin,
      ).toString();
      setCreatedOrder(body.order);
      setShareUrl(href);
      setOrderInput(body.order.orderId);
      setLoadedOrder(body.order);
      // Seller shop: after a successful create, return to the Files tab so the
      // new file appears in "Your files" (the share link stays available via the
      // createdOrder/shareUrl state).
      if (seller) {
        setSellerScreen("files");
        void loadSellerFiles();
      }
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  // Multi-buyer "product" model (Phase 3a): create a PRODUCT (a catalog entry
  // many buyers can purchase) instead of a single-use file. This mirrors
  // onCreateLink's create path — encrypt in-browser, derive a seller-held release
  // draft (the AES fileKey never leaves this browser), POST the ciphertext +
  // multipart fields to /api/products — but adds the supply config and persists
  // the release draft + ciphertext keyed by PRODUCT id (not orderId), so the
  // seller can later deliver EVERY purchase of this product (Phase 3b). Only
  // invoked when productsEnabled() is true.
  async function onCreateProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");
    setCreatedProduct(null);
    setProductShareUrl("");

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

    // Supply: "open" is unlimited; "limited" requires a positive-integer max.
    let supplyMaxValue = 0;
    if (supplyMode === "limited") {
      supplyMaxValue = Number(supplyMax.trim());
      if (!Number.isSafeInteger(supplyMaxValue) || supplyMaxValue < 1) {
        setErrorMessage(copy.products.supplyMaxInvalid);
        return;
      }
    }

    setBusyAction("encrypting");
    try {
      const encrypted = await encryptPaidLinkFile(file);
      // Pure seller-held custody: the AES file key never leaves this browser. We
      // only upload the SHA-256 of a random release secret; the file key stays in
      // the local seller vault until the seller releases it per purchase.
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
      form.set("supplyMode", supplyMode);
      if (supplyMode === "limited") {
        form.set("supplyMax", String(supplyMaxValue));
      }

      const body = await postJson<CreateProductResponse>("/api/products", {
        method: "POST",
        body: form,
      });

      // Persist the product's release draft (the AES fileKey) keyed by PRODUCT id
      // — analogous to the per-order draft, but one product key serves every
      // purchase of this product (each spawned order carries the same
      // releaseSecretHash). Phase 3b loads it by productId to wrap the key for
      // each buyer.
      saveProductReleaseDraft(body.product.productId, releaseDraft);

      // Persist the product ciphertext to IndexedDB keyed by PRODUCT id
      // (best-effort, never blocks create), so this browser can deliver the file
      // over Nym for every purchase even after a reload. Any IndexedDB failure
      // leaves the HTTPS fallback (the server keeps its own copy) unchanged.
      try {
        const encryptedBytes = new Uint8Array(
          await encrypted.encryptedFile.arrayBuffer(),
        );
        void putProductCiphertext(body.product.productId, encryptedBytes).catch(
          () => undefined,
        );
      } catch {
        // Non-fatal: without the persisted bytes the buyer uses HTTPS.
      }

      const href = new URL(
        withProductLocale(body.sharePath, locale),
        window.location.origin,
      ).toString();
      setCreatedProduct(body);
      setProductShareUrl(href);
      // Reset the supply control to the default for the next product.
      setSupplyMode("open");
      setSupplyMax("");
      // Return to the Files tab so the new product appears in "Your products"
      // (the share link stays available via createdProduct/productShareUrl).
      if (seller) {
        setSellerScreen("files");
        void loadSellerProducts();
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

  // Multi-buyer "product" model (Phase 3b): fetch the buyer-facing product
  // listing. Maps a 404 / closed product to the error state and an exhausted
  // limited supply to the sold-out state so the view can hide the Buy button.
  //
  // Phase 3c: `silent` is set for the background poll — it skips the loading
  // splash AND leaves the current view in place on a transient fetch failure
  // (a dropped poll must not blank a working listing). The initial load and the
  // post-409 refresh stay loud (silent = false) so a real failure surfaces.
  async function loadProductListing(productId: string, silent = false) {
    if (productListingFetchingRef.current) {
      // A request is already in flight — never stack a second fetch.
      return;
    }
    productListingFetchingRef.current = true;
    if (!silent) {
      setErrorMessage("");
      setProductStatus("loading");
    }
    try {
      const res = await fetch(
        `/api/products/${encodeURIComponent(productId)}`,
        { method: "GET" },
      );
      if (!res.ok) {
        if (!silent) {
          setProductStatus("error");
        }
        return;
      }
      const body = (await res.json()) as { product: PublicProductListing };
      setProductListing(body.product);
      setProductStatus(
        body.product.soldOut || body.product.status !== "open"
          ? "soldout"
          : "ready",
      );
    } catch {
      if (!silent) {
        setProductStatus("error");
      }
    } finally {
      productListingFetchingRef.current = false;
    }
  }

  // Multi-buyer "product" model (Phase 3b): buy a product. POST the purchase to
  // spawn a FRESH per-buyer order, then DRIVE THE EXISTING receive flow against
  // it (loadOrder registers the Nym session + shows the pay QR + receives), so no
  // pay/receive UI is duplicated here. A sold-out 409 flips the view to sold-out
  // instead of erroring.
  async function onBuyProduct(productId: string) {
    setErrorMessage("");
    setProductBuying(true);
    try {
      const res = await fetch(
        `/api/products/${encodeURIComponent(productId)}/purchase`,
        { method: "POST" },
      );
      if (res.status === 409) {
        // Sold out (or closed) between load and buy — refresh the listing so the
        // view shows the honest sold-out state rather than a raw error.
        setProductStatus("soldout");
        await loadProductListing(productId).catch(() => undefined);
        return;
      }
      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        setErrorMessage(
          extractServerErrorMessage(errorBody, copy.errors.serverError),
        );
        return;
      }
      const body = (await res.json()) as { order: TransferPublicOrder };
      // Hand off to the existing buyer receive path: loadOrder sets loadedOrder
      // + payment + the Nym session and shows the pay QR. The product listing is
      // cleared from the view (loadedOrder now drives BuyerCheckout).
      await loadOrder(body.order.orderId);
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setProductBuying(false);
    }
  }

  async function loadOrder(orderId: string) {
    setErrorMessage("");
    setBusyAction("loading");
    setDownloadUrl("");
    setDownloadFileName("");
    setReceivedVia(null);
    pendingDownloadRef.current = null;
    buyerReceivedRef.current = false;
    buyerAutoDownloadedRef.current = "";
    setNymEnvelopesReceived(0);
    buyerKeyReceivedRef.current = false;
    setBuyerKeyReceived(false);
    // Reset any in-flight browser-to-browser FILE transfer state from a prior
    // order so the receiver/key/fallback for THIS order start clean.
    nymFileReceiverRef.current?.abort("loading a new order");
    nymFileReceiverRef.current = null;
    nymFileHandledRef.current.clear();
    nymReassembledRef.current.clear();
    nymKeyEnvelopeRef.current.clear();
    buyerFallbackTimerRef.current.forEach((handle) =>
      window.clearTimeout(handle),
    );
    buyerFallbackTimerRef.current.clear();
    buyerProgressRef.current.clear();
    transferInProgressRef.current = false;
    setBuyerReceiveProgress(null);

    try {
      const body = await postJson<{ order: TransferPublicOrder }>(
        `/api/transfers/${encodeURIComponent(orderId)}`,
        { method: "GET" },
      );
      setLoadedOrder(body.order);
      setPayment(body.order.payment);
      setOrderInput(orderId);
      setMode("receive");
      // Auto-create the payment intent so the QR + address appear with NO
      // button. createPaymentIntentForOrder is idempotent server-side (it
      // returns the existing payment), so this is safe on every (re)load.
      // BUT never bind a payment when the logged-in SELLER is viewing their own
      // order — that would make the seller's browser the buyer and lock the real
      // buyer out. The seller should only copy the link and send it on.
      const viewingOwnOrder = Boolean(
        seller?.sellerId && body.order.seller?.sellerId === seller.sellerId,
      );
      if (
        !viewingOwnOrder &&
        !body.order.payment &&
        body.order.status !== "paid" &&
        body.order.status !== "claimed"
      ) {
        await createPaymentForOrder(body.order);
      }
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  // Auto-create the buyer payment intent for a loaded order. Decoupled from any
  // button: it runs the payment-intent FIRST so the payment address + QR show
  // immediately, then registers the Nym delivery session in the BACKGROUND (the
  // receiver is only needed for key delivery after payment, so its slow/flaky
  // bootstrap must NOT block showing where to pay). Idempotent server-side, so
  // it is safe to call on every (re)load. Callers own the busy state.
  async function createPaymentForOrder(
    order: TransferPublicOrder,
  ): Promise<void> {
    setBusyAction("payment");
    try {
      const keyPair = await getOrCreateBuyerKeyPair(order.orderId);
      const body = await postJson<PaymentIntentResponse>(
        `/api/transfers/${encodeURIComponent(order.orderId)}/payment-intent`,
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
      // Register the Nym delivery session in the background (needed before the
      // seller releases the key, not for the payment). A failed receiver
      // bootstrap leaves the payment address visible and is retried at claim.
      void registerBuyerNymSession(body.order, keyPair).catch(() => {
        setNymStatus("error");
        setNymMessage(copy.errors.nymUnavailable);
      });
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    } finally {
      setBusyAction("idle");
    }
  }

  async function registerBuyerNymSession(
    order: TransferPublicOrder,
    keyPair: PaidLinkBuyerKeyPair,
    // Optional explicit address: the heartbeat passes the address it just got
    // back from startBrowserNym() so re-registration uses the LIVE receiver
    // address without waiting for the buyerNymAddress state closure to refresh.
    explicitNymAddress?: string,
  ): Promise<void> {
    const nymAddress =
      explicitNymAddress?.trim() ||
      buyerNymAddress.trim() ||
      (await startBrowserNym());
    await postJson<{ order: TransferPublicOrder }>(
      `/api/transfers/${encodeURIComponent(order.orderId)}/nym-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buyerNymAddress: nymAddress,
          buyerPublicKeyJwk: keyPair.publicJwk,
          transport: order.delivery.requiredTransport,
        }),
      },
    );
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

    // No-rotate guard: never spin up a FRESH client (which draws a new gateway
    // and a new address) while a file transfer is in flight — rotating mid-
    // transfer changes our address and orphans the in-flight chunks/control
    // frames. If we have a live client, reuse it even if selfAddress() returns
    // empty momentarily. If we have NO client at all during a transfer, refuse
    // to bootstrap (which would rotate) rather than silently changing address.
    if (transferInProgressRef.current) {
      if (existing) {
        return {
          client: existing,
          address: (await existing.client.selfAddress()) ?? "",
        };
      }
      throw new Error(
        "Nym client unavailable mid-transfer (refusing to rotate gateway)",
      );
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
        // Inbound binary (file chunk) handler for the browser-to-browser file
        // transfer. Routed to handleNymRawMessage, which decodes the frame and
        // drives the active receiver. Resubscribed per (re)bootstrap.
        browserNymRawUnsubscribeRef.current?.();
        browserNymRawUnsubscribeRef.current =
          nym.events.subscribeToRawMessageReceivedEvent((event) => {
            handleNymRawMessage(event.args.payload);
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

  // Multi-buyer "product" model (Phase 3b): resolve the seller release draft for
  // an order. A PURCHASE (order.productId set) is delivered with the PRODUCT
  // release draft (one product key serves every purchase — they all share the
  // same releaseSecretHash), loaded by productId. A single-use order (no
  // productId) keeps using its per-order draft EXACTLY as before. This is the one
  // place the source diverges, so every release/re-send path stays unchanged for
  // single-use orders.
  function loadReleaseDraftForOrder(
    order: Pick<TransferPublicOrder, "orderId" | "productId">,
  ): PaidLinkSellerReleaseDraft | null {
    if (order.productId) {
      return loadProductReleaseDraft(order.productId);
    }
    return loadSellerReleaseDraft(order.orderId);
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

  // Best-effort Screen Wake Lock: keep the seller's tab awake during an active
  // send so the OS does not suspend the page mid-transfer (common on mobile).
  // Wrapped so a missing/denied API never throws.
  async function acquireWakeLock(): Promise<void> {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: {
          request: (
            type: "screen",
          ) => Promise<{ release: () => Promise<void> }>;
        };
      };
      if (!nav.wakeLock || wakeLockRef.current) {
        return;
      }
      wakeLockRef.current = await nav.wakeLock.request("screen");
    } catch {
      // Wake Lock unavailable/denied — not fatal; the send continues.
    }
  }

  async function releaseWakeLock(): Promise<void> {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    try {
      await lock?.release();
    } catch {
      // Already released or the page is gone.
    }
  }

  // Seller-side browser-to-browser FILE send over Nym. Streams the in-memory
  // ciphertext for this order to the buyer's Nym address using the clean-room
  // chunked sender (offer -> paced chunks -> done, ARQ on retransmit, resolve on
  // ack). Holds a no-rotate guard + wake lock for the duration and reports
  // progress. Returns true if the buyer acked, false if it could not run (no
  // ciphertext in this browser) — the caller then relies on the HTTPS fallback.
  async function sendFileOverNym(input: {
    orderId: string;
    buyerNymAddress: string;
    // Multi-buyer "product" model (Phase 3b): when set, the ciphertext is the
    // PRODUCT's (keyed by productId in IndexedDB), shared by every purchase. The
    // transfer id stays input.orderId so the buyer's per-order receiver matches.
    productId?: string | null;
  }): Promise<boolean> {
    let ciphertext = sellerCiphertextRef.current.get(input.orderId);
    if (!ciphertext) {
      // Not in memory. Source the bytes best-effort from IndexedDB: a PURCHASE
      // (productId set) reads the shared PRODUCT ciphertext; a single-use order
      // reads its per-order copy — exactly as before. Repopulate the in-memory
      // ref under the orderId so a re-send tick reuses it without another read.
      const persisted = input.productId
        ? await getProductCiphertext(input.productId).catch(() => null)
        : await getSellerCiphertext(input.orderId).catch(() => null);
      if (persisted) {
        sellerCiphertextRef.current.set(input.orderId, persisted);
        ciphertext = persisted;
      }
    }
    if (!ciphertext) {
      // This browser does not hold the ciphertext bytes (created elsewhere, or
      // reloaded without a persisted copy). The buyer's HTTPS fallback still
      // works.
      return false;
    }
    const { client } = await bootstrapBrowserNymClient({ subscribe: false });
    // The seller must hear the buyer's Retransmit/Ack control frames, which the
    // SDK delivers as RAW (binary) messages. The seller bootstrap does not
    // subscribe, so attach a dedicated raw subscription for THIS send's lifetime
    // and tear it down when the send settles.
    const senderAddress = (await client.client.selfAddress()) ?? "";
    transferInProgressRef.current = true;
    await acquireWakeLock();
    setSellerSendProgress(0);
    let aborted = false;
    let unsubscribeRaw: (() => void) | null = null;
    try {
      const sender = await startNymFileSender(
        input.orderId,
        ciphertext,
        (payload) =>
          client.client.rawSend({
            payload,
            recipient: input.buyerNymAddress,
          }),
        {
          senderAddress,
          onProgress: (sent, total) => {
            setSellerSendProgress(
              total > 0 ? Math.round((sent / total) * 100) : 100,
            );
          },
          // Additive perf instrumentation: surface + log send-side metrics on
          // ack. Does not affect the transfer (best-effort callback).
          onMetrics: (metrics) => {
            logTransferMetrics(metrics);
            setSellerTransferMetrics(metrics);
          },
          shouldAbort: () => aborted,
        },
      );
      // Route the buyer's inbound control frames into THIS sender for the ARQ +
      // ack latch. A non-transfer or other-order packet is ignored by the sender.
      unsubscribeRaw = client.events.subscribeToRawMessageReceivedEvent(
        (event) => {
          const packet = decodePacket(event.args.payload);
          if (packet) {
            sender.handlePacket(packet);
          }
        },
      );
      await sender.done();
      return true;
    } catch {
      aborted = true;
      return false;
    } finally {
      unsubscribeRaw?.();
      transferInProgressRef.current = false;
      setSellerSendProgress(null);
      void releaseWakeLock();
    }
  }

  // Single-flight wrapper around sendFileOverNym used by the release/re-send
  // paths so a per-~6s re-send tick never starts a second concurrent transfer
  // for the same order. Best-effort: a failed send clears the guard so a later
  // tick retries; the buyer's HTTPS fallback covers a persistent failure.
  function maybeSendFileOverNym(input: {
    orderId: string;
    buyerNymAddress: string;
    // Multi-buyer "product" model (Phase 3b): present for a purchase. The shared
    // PRODUCT ciphertext is NEVER deleted on ack (other purchases still need it);
    // only a single-use order's per-order copy is freed.
    productId?: string | null;
  }): void {
    if (!browserNymFileTransferEnabled()) {
      return;
    }
    if (sellerFileSendInFlightRef.current.has(input.orderId)) {
      return;
    }
    // NOTE: we no longer early-return when the in-memory ref lacks the order —
    // the ciphertext may still be in IndexedDB from a previous session.
    // sendFileOverNym loads it just-in-time and returns false if neither source
    // has it (the buyer then falls back to HTTPS).
    sellerFileSendInFlightRef.current.add(input.orderId);
    void sendFileOverNym(input)
      .then((acked) => {
        // Free the in-memory ciphertext AND the persisted copy once the buyer has
        // confirmed receipt so neither is held longer than needed. A failed send
        // keeps both so a later re-send tick (this or a later session) can retry.
        // A PURCHASE keeps the shared PRODUCT ciphertext (every other purchase of
        // the product still needs it); we only drop the per-order in-memory copy.
        if (acked) {
          sellerCiphertextRef.current.delete(input.orderId);
          if (!input.productId) {
            void deleteSellerCiphertext(input.orderId).catch(() => undefined);
          }
        }
      })
      .finally(() => {
        sellerFileSendInFlightRef.current.delete(input.orderId);
      });
  }

  // Inbound RAW (binary) dispatch on the buyer's subscribed client: decode the
  // frame and route it to (or start) the file receiver for the loaded order. The
  // seller's send attaches its OWN raw subscription for control frames, so this
  // handler is purely the buyer-receive path.
  function handleNymRawMessage(payload: Uint8Array): void {
    const packet = decodePacket(payload);
    if (!packet) {
      return;
    }
    routeBuyerFilePacket(packet.orderId, packet);
  }

  // Buyer side: route a decoded file packet to the active receiver, starting one
  // on the first packet for the currently loaded, paid order. The receiver emits
  // its own Retransmit/Ack control frames back to the seller via rawSend.
  function routeBuyerFilePacket(
    packetOrderId: string,
    packet: ReturnType<typeof decodePacket>,
  ): void {
    if (!packet) {
      return;
    }
    // Read LIVE state from the ref (the subscription closure that calls this is
    // pinned at bootstrap and never re-wired, so the captured loadedOrder may be
    // stale/null after an order reload / Nym reconnect).
    const order = loadedOrderRef.current;
    // Only accept chunks for the order this buyer is actively receiving.
    if (!order || packetOrderId !== order.orderId) {
      return;
    }
    // Already have the file (HTTPS or a prior Nym receive) — ignore.
    if (buyerReceivedRef.current || downloadUrlRef.current) {
      return;
    }
    if (!nymFileReceiverRef.current) {
      // Only start a receiver for a paid order whose file has not arrived.
      if (!isOrderPaid(order) || nymFileHandledRef.current.has(order.orderId)) {
        return;
      }
      startBuyerFileReceiver(order);
    }
    nymFileReceiverRef.current?.handlePacket(packet);
  }

  // Stand up a clean-room file receiver for `order`. On completion it verifies
  // the SHA-256 against the order, then decrypts the reassembled ciphertext with
  // the key the buyer ALREADY received over the Nym text channel (or claims it),
  // reusing the exact same crypto path as the HTTPS openClaimPayload.
  function startBuyerFileReceiver(order: TransferPublicOrder): void {
    const client = browserNymClientRef.current;
    if (!client) {
      return;
    }
    nymFileHandledRef.current.add(order.orderId);
    transferInProgressRef.current = true;
    setBuyerReceiveProgress(0);
    // Seed the stall tracker so the progress-aware fallback measures "no progress
    // since the receiver started", not "since the key arrived".
    buyerProgressRef.current.set(order.orderId, {
      lastProgressAt: Date.now(),
      received: 0,
      total: 0,
    });
    const receiver = createNymFileReceiver(
      order.orderId,
      (payload, recipient) =>
        client.client.rawSend({ payload, recipient }).catch(() => undefined),
      {
        expectedSha256: order.file.encryptedFileSha256,
        // With HTTPS fallback OFF (current default), let the transfer finish in
        // its own time over Nym — a very long bound, NOT the size-aware fallback
        // cap, so a slow large file is never aborted. When the fallback is later
        // re-enabled (behind buyer consent), the size-aware cap decides when to
        // offer HTTPS instead.
        overallTimeoutMs: BROWSER_NYM_HTTPS_FALLBACK_ENABLED
          ? computeNymReceiveTimeoutMs(order.file.encryptedSizeBytes)
          : NYM_RECEIVE_NO_FALLBACK_TIMEOUT_MS,
        onProgress: (received, total) => {
          // Record forward progress for the stall-aware fallback timer: stamp the
          // time + latest counts so a healthy slow transfer keeps re-arming the
          // timer instead of being yanked off the Nym path mid-flight.
          const prev = buyerProgressRef.current.get(order.orderId);
          if (!prev || received > prev.received || total !== prev.total) {
            buyerProgressRef.current.set(order.orderId, {
              lastProgressAt: Date.now(),
              received,
              total,
            });
          }
          setBuyerReceiveProgress(
            total > 0 ? Math.round((received / total) * 100) : 0,
          );
        },
        // Additive perf instrumentation: surface + log receive-side metrics on
        // verified completion. Does not affect the transfer (best-effort).
        onMetrics: (metrics) => {
          logTransferMetrics(metrics);
          setBuyerTransferMetrics(metrics);
        },
      },
    );
    nymFileReceiverRef.current = receiver;
    void receiver
      .done()
      .then(async (ciphertext) => {
        await openReassembledCiphertext(order, ciphertext);
      })
      .catch(() => {
        // Nym file transfer failed/timed out: fall back to the HTTPS fetch path,
        // which still works because the ciphertext is also uploaded.
        nymFileHandledRef.current.delete(order.orderId);
        void buyerHttpsFallback(order);
      })
      .finally(() => {
        if (nymFileReceiverRef.current === receiver) {
          nymFileReceiverRef.current = null;
        }
        transferInProgressRef.current = false;
        setBuyerReceiveProgress(null);
        buyerProgressRef.current.delete(order.orderId);
      });
  }

  // Decrypt + open the ciphertext reassembled over Nym. Mirrors openClaimPayload
  // but takes the bytes in hand (already SHA-verified by the receiver) instead of
  // fetching them over HTTPS. The AES key still comes from the P-256 ECDH key
  // envelope delivered over the Nym text channel.
  async function openReassembledCiphertext(
    order: TransferPublicOrder,
    ciphertext: Uint8Array,
  ): Promise<void> {
    const keyPair = loadBuyerKeyPair(order.orderId);
    const envelope = nymKeyEnvelopeRef.current.get(order.orderId);
    if (!keyPair) {
      // No buyer keypair on this device — only HTTPS (with its own claim) helps.
      void buyerHttpsFallback(order);
      return;
    }
    if (!envelope) {
      // File bytes are verified and in hand, but the key envelope (Nym text
      // channel) has not landed yet. Buffer the ciphertext; the key-arrival
      // handler decrypts it the moment the envelope shows up. Arm the HTTPS
      // fallback so a key that never arrives over Nym still resolves (the
      // fallback claims the key + ciphertext together over HTTPS).
      nymReassembledRef.current.set(order.orderId, ciphertext);
      armBuyerHttpsFallback(order);
      return;
    }
    buyerReceivedRef.current = true;
    try {
      const fileKey = await decryptPaidLinkFileKey(
        envelope,
        keyPair.privateJwk,
      );
      const ab = ciphertext.buffer.slice(
        ciphertext.byteOffset,
        ciphertext.byteOffset + ciphertext.byteLength,
      ) as ArrayBuffer;
      const opened = await decryptPaidLinkFile(
        ab,
        fileKey,
        order.file.encryptionIv,
        order.file.mimeType,
      );
      const objectUrl = window.URL.createObjectURL(opened);
      setDownloadUrl(objectUrl);
      setDownloadFileName(order.file.fileName);
      // Provenance: the in-browser Nym receiver reassembled + decrypted these
      // bytes over the mixnet — this is the pure-Nym happy path.
      setReceivedVia("nym");
      setNymStatus("ready");
      setNymMessage(copy.receive.nymReadyLabel);
      if (buyerAutoDownloadedRef.current !== objectUrl) {
        buyerAutoDownloadedRef.current = objectUrl;
        triggerBrowserDownload(objectUrl, order.file.fileName);
      }
      clearBuyerHttpsFallback(order.orderId);
      void acknowledgeDelivery(order.orderId, keyPair, "nym");
    } catch {
      buyerReceivedRef.current = false;
      // Decrypt failed (rare) — let HTTPS take over.
      void buyerHttpsFallback(order);
    }
  }

  // Arm (once per order) the generous HTTPS fallback timer. If the Nym file
  // transfer has not delivered the file within the bound after the key arrived,
  // we abandon the Nym receiver and fetch over HTTPS. Re-arming is a no-op so a
  // burst of re-sent key envelopes does not stack timers.
  function armBuyerHttpsFallback(order: TransferPublicOrder): void {
    // HTTPS fallback is OFF for now (100% Nym; never expose the buyer IP). Do not
    // arm the stall timer — let the receiver keep asking for missing chunks until
    // the transfer completes in its own time.
    if (!BROWSER_NYM_HTTPS_FALLBACK_ENABLED) {
      return;
    }
    if (buyerFallbackTimerRef.current.has(order.orderId)) {
      return;
    }
    scheduleBuyerHttpsFallbackTimer(order);
  }

  // (Re)schedule the progress-aware stall timer for one order. Always sets a
  // fresh handle (callers either guard against double-arm in armBuyerHttpsFallback
  // or are the timer itself re-arming). When it fires it only aborts to HTTPS on a
  // TRUE no-progress stall: if the receiver is still making forward progress AND
  // the transfer is genuinely in-flight (received < total, not yet errored), it
  // re-arms instead so a healthy slow transfer of a large file completes over Nym.
  function scheduleBuyerHttpsFallbackTimer(order: TransferPublicOrder): void {
    const handle = window.setTimeout(() => {
      buyerFallbackTimerRef.current.delete(order.orderId);
      // Already have the file (Nym or a prior HTTPS) — nothing to fall back to.
      if (buyerReceivedRef.current || downloadUrlRef.current) {
        return;
      }
      const progress = buyerProgressRef.current.get(order.orderId);
      const receiverActive = nymFileReceiverRef.current !== null;
      const inFlight =
        receiverActive &&
        progress !== undefined &&
        // total === 0 means the Offer/first chunk has not landed yet — treat as
        // in-flight only while progress is still being stamped (below).
        (progress.total === 0 || progress.received < progress.total);
      const sinceProgress = progress
        ? Date.now() - progress.lastProgressAt
        : Number.POSITIVE_INFINITY;
      // Healthy slow transfer: still progressing within the no-progress window AND
      // in-flight — re-arm rather than abort. The receiver's own error/600s
      // ceiling still covers a transfer that never completes.
      if (inFlight && sinceProgress < BROWSER_NYM_FILE_FALLBACK_MS) {
        scheduleBuyerHttpsFallbackTimer(order);
        return;
      }
      // True stall (or the key never arrived / no receiver running) — abort the
      // Nym receiver and fall back to the HTTPS fetch.
      nymFileReceiverRef.current?.abort("https fallback");
      nymFileReceiverRef.current = null;
      void buyerHttpsFallback(order);
    }, BROWSER_NYM_FILE_FALLBACK_MS);
    buyerFallbackTimerRef.current.set(order.orderId, handle);
  }

  function clearBuyerHttpsFallback(orderId: string): void {
    const handle = buyerFallbackTimerRef.current.get(orderId);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      buyerFallbackTimerRef.current.delete(orderId);
    }
  }

  // HTTPS safety net: claim the key + signed ciphertext URL and open it via the
  // existing openClaimPayload path. Used when the Nym file transfer fails/times
  // out or the key is not yet in hand. No-op once the file has arrived.
  async function buyerHttpsFallback(order: TransferPublicOrder): Promise<void> {
    clearBuyerHttpsFallback(order.orderId);
    // HTTPS fallback is OFF for now: stay 100% on the Nym mixnet so the buyer's
    // IP is never exposed to the server. A large/slow transfer is allowed to
    // finish in its own time (the receiver runs with a very long bound and keeps
    // asking for missing chunks). Re-enable later behind explicit buyer consent.
    if (!BROWSER_NYM_HTTPS_FALLBACK_ENABLED) {
      return;
    }
    if (buyerReceivedRef.current || downloadUrl) {
      return;
    }
    const keyPair = loadBuyerKeyPair(order.orderId);
    if (!keyPair) {
      return;
    }
    try {
      const claim = await postJson<ClaimResponse>(
        `/api/transfers/${encodeURIComponent(order.orderId)}/claim`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ buyerPublicKeyJwk: keyPair.publicJwk }),
        },
      );
      setLoadedOrder(claim.order);
      setPayment(claim.order.payment);
      const envelope =
        claim.keyEnvelope ?? nymKeyEnvelopeRef.current.get(order.orderId);
      const download =
        claim.download ?? pendingDownloadRef.current ?? undefined;
      if (!envelope || !download) {
        return;
      }
      buyerReceivedRef.current = true;
      try {
        await openClaimPayload(
          {
            schema: "paidprivatefile.nym.claim.v1",
            orderId: order.orderId,
            manifest: {
              orderId: order.orderId,
              fileName: order.file.fileName,
              mimeType: order.file.mimeType,
              encryptedFileSha256: order.file.encryptedFileSha256,
              encryptionIv: order.file.encryptionIv,
            },
            keyEnvelope: envelope,
            encryptedFileDownload: download,
          },
          keyPair,
        );
      } catch (error) {
        buyerReceivedRef.current = false;
        pendingDownloadRef.current = null;
        setErrorMessage(formatError(error, copy.errors.serverError));
      }
    } catch (error) {
      setErrorMessage(formatError(error, copy.errors.serverError));
    }
  }

  async function handleNymTextMessage(payload: string): Promise<void> {
    // Read LIVE state from the refs: this handler runs inside the text-message
    // subscription closure pinned at client bootstrap, so the captured
    // loadedOrder / downloadUrl can be stale/null after an order reload or Nym
    // reconnect (which would silently drop every inbound key envelope). The refs
    // are kept current by the effects above.
    const loadedOrder = loadedOrderRef.current;
    const downloadUrl = downloadUrlRef.current;
    // Diagnostic: count inbound envelopes so the "Receiving your file…" card can
    // show envelopes are actually reaching this receiver — proving the listener
    // is wired up. FREEZE once the key is in hand: further envelopes are just the
    // seller's pre-ack re-sends of a key we already have, and a climbing number
    // after "key received" only worries the buyer.
    if (!buyerKeyReceivedRef.current) {
      setNymEnvelopesReceived((count) => count + 1);
    }

    // Idempotency: the seller re-sends the same envelope until the buyer ACKs.
    // Ignore further envelopes ONLY once the file is actually in hand this
    // session (downloadUrl / buyerReceivedRef) or the ack confirmed receipt
    // (nymSession "delivered"). NOT on "claimed" — that is set at claim, before
    // the key arrives, so blocking on it stops a reloaded buyer (downloadUrl
    // lost) from ever re-receiving.
    if (
      buyerReceivedRef.current ||
      downloadUrl ||
      loadedOrder?.delivery.nymSession?.status === "delivered"
    ) {
      return;
    }

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
      // Commit: a matching, decryptable envelope. Block re-sends now so a burst
      // arriving back-to-back cannot each start a decrypt before downloadUrl is
      // set. If opening fails, release the guard so a later re-send can retry.
      buyerReceivedRef.current = true;
      buyerKeyReceivedRef.current = true;
      setBuyerKeyReceived(true);
      try {
        // The KEY + manifest arrived over the Nym text channel, but
        // openClaimPayload fetches the FILE bytes over HTTPS (the signed
        // ciphertext URL). The badge reflects how the FILE was received, so this
        // is an HTTPS delivery even though the key drop rode the mixnet.
        await openClaimPayload(parsed, keyPair, "https");
      } catch (error) {
        buyerReceivedRef.current = false;
        setErrorMessage(formatError(error, copy.errors.serverError));
      }
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

    // Browser-to-browser FILE transfer: stash the key envelope so the in-browser
    // FILE receiver (raw channel) can decrypt the reassembled ciphertext, and
    // arm a generous HTTPS fallback. We do NOT immediately fetch over HTTPS — the
    // happy path is 100% Nym; the timer is the safety net. If the FILE bytes
    // already arrived (receiver waiting on the key), decrypt them now.
    if (browserNymFileTransferEnabled()) {
      nymKeyEnvelopeRef.current.set(keyOnly.orderId, keyOnly.keyEnvelope);
      // Key is in hand: calm the receiver status + freeze the envelope counter so
      // the seller's pre-ack re-sends don't keep worrying the buyer.
      buyerKeyReceivedRef.current = true;
      setBuyerKeyReceived(true);
      armBuyerHttpsFallback(loadedOrder);
      // If the FILE bytes already arrived (receiver reassembled + verified them
      // while waiting for this key), decrypt + open them now.
      const buffered = nymReassembledRef.current.get(keyOnly.orderId);
      if (buffered) {
        nymReassembledRef.current.delete(keyOnly.orderId);
        await openReassembledCiphertext(loadedOrder, buffered);
      }
      return;
    }

    // Commit before the await-heavy claim/decrypt below so concurrent re-sends
    // (the seller fires every ~6s) cannot each kick off a download.
    buyerReceivedRef.current = true;
    // Key is in hand in the key-over-Nym + file-over-HTTPS config too: calm the
    // receiver status and freeze the envelope counter, matching the flag-ON path.
    buyerKeyReceivedRef.current = true;
    setBuyerKeyReceived(true);
    // The seller's envelope can arrive over the mixnet BEFORE this buyer ran its
    // own claim (the claim is what stashes the signed ciphertext URL). If the URL
    // is missing, claim NOW to fetch it, then decrypt with the envelope we just
    // received over Nym. This removes the send-before-buyer-ready race.
    let download = pendingDownloadRef.current;
    if (!download) {
      try {
        const claim = await postJson<ClaimResponse>(
          `/api/transfers/${encodeURIComponent(keyOnly.orderId)}/claim`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ buyerPublicKeyJwk: keyPair.publicJwk }),
          },
        );
        setLoadedOrder(claim.order);
        setPayment(claim.order.payment);
        if (claim.download) {
          pendingDownloadRef.current = claim.download;
          download = claim.download;
        }
      } catch (error) {
        // Claim failed: allow a later re-send to retry this buyer.
        buyerReceivedRef.current = false;
        setErrorMessage(formatError(error, copy.errors.serverError));
        return;
      }
    }
    if (!download) {
      buyerReceivedRef.current = false;
      setErrorMessage(copy.errors.paymentRequired);
      return;
    }
    try {
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
        // The key envelope arrived over the Nym text channel, but the FILE bytes
        // are fetched over HTTPS via the signed ciphertext URL here. The badge is
        // about how the FILE was received, so this is an HTTPS delivery. Only the
        // openReassembledCiphertext path (file reassembled over the mixnet) is
        // classified "nym".
        "https",
      );
    } catch (error) {
      buyerReceivedRef.current = false;
      // The stashed signed download URL/token may be stale/expired (10-min TTL),
      // which would make EVERY re-sent envelope fail on the same dead URL. Drop it
      // so the next envelope re-claims a fresh URL+token before decrypting.
      pendingDownloadRef.current = null;
      setErrorMessage(formatError(error, copy.errors.serverError));
    }
  }

  async function openClaimPayload(
    payload: NymClaimPayload,
    keyPair: PaidLinkBuyerKeyPair,
    // Which path got us here. The legacy Nym text-channel callers pass "nym"
    // (key + manifest arrived over the mixnet); the HTTPS fallback + manual
    // unlock pass "https" (the file is fetched over HTTPS here). Drives the
    // provenance badge + the seller-facing delivery-path flag.
    via: "nym" | "https" = "https",
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
    // Provenance: stamp the path that delivered this file (the caller knows
    // whether the bytes came over the mixnet or the HTTPS fallback fetch).
    setReceivedVia(via);
    setNymStatus("ready");
    setNymMessage(copy.receive.nymReadyLabel);

    // Dead-simple buyer: the instant the decrypted file is ready, AUTO-TRIGGER
    // the download so the file saves WITHOUT a click in the happy path. Guard on
    // the object URL so a re-render never re-fires. The inline preview + the
    // "Save file" button (rendered in the done card) are the fallbacks for
    // browsers that block the programmatic click (Safari can be strict).
    if (buyerAutoDownloadedRef.current !== objectUrl) {
      buyerAutoDownloadedRef.current = objectUrl;
      triggerBrowserDownload(objectUrl, payload.manifest.fileName);
    }

    // Pure-Nym delivery ack (status only, no key material): tell the server the
    // buyer actually received + opened the file so the seller's re-send loop can
    // stop. Best-effort — a failed ack must not break the buyer's download. The
    // path flag rides along so the seller dashboard can show how it was delivered.
    void acknowledgeDelivery(payload.orderId, keyPair, via);
  }

  // POST the status-only delivery acknowledgement. The body carries ONLY the
  // buyer public key (same auth as claim) plus the optional delivery-path
  // provenance flag; no key material is sent. Silently ignores failures so the
  // buyer flow never depends on the ack.
  async function acknowledgeDelivery(
    orderId: string,
    keyPair: PaidLinkBuyerKeyPair,
    via?: "nym" | "https",
  ): Promise<void> {
    // RETRY until the server confirms "delivered" — a single best-effort POST
    // left the seller stuck on "not delivered" forever if that one request
    // failed (transient/rate-limit). The seller's status only flips when this
    // ack lands, so it must be reliable. Bounded so it can't loop indefinitely.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const body = await postJson<{ order: TransferPublicOrder }>(
          `/api/transfers/${encodeURIComponent(orderId)}/delivered`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              buyerPublicKeyJwk: keyPair.publicJwk,
              ...(via ? { via } : {}),
            }),
          },
        );
        if (loadedOrder && body.order.orderId === loadedOrder.orderId) {
          setLoadedOrder(body.order);
          setPayment(body.order.payment);
        }
        if (body.order.delivery?.nymSession?.status === "delivered") {
          return;
        }
      } catch {
        // transient/rate-limited — wait and retry below.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
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

  // Verified manual release: fetch the key-release challenge (status only) so
  // the seller can SEE the buyer-key fingerprint and compare it out-of-band with
  // the code the buyer reads. A mismatch exposes a server key substitution.
  async function onRevealBuyerCode(order: TransferPublicOrder): Promise<void> {
    setErrorMessage("");
    setReleaseMessage("");
    setBusyAction("release");
    try {
      const draft = loadReleaseDraftForOrder(order);
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
      const draft = loadReleaseDraftForOrder(order);
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
          // Record that the key has gone out at least once so the re-send loop can
          // safely pause further key sends while the file streams.
          sellerKeySentOnceRef.current.add(order.orderId);
          // Browser-to-browser FILE delivery: also stream the encrypted file
          // bytes to the buyer over Nym (single-flight; HTTPS is the fallback).
          // A purchase passes its productId so the shared PRODUCT ciphertext is
          // used (and never deleted on ack); a single-use order omits it.
          maybeSendFileOverNym({
            orderId: order.orderId,
            buyerNymAddress: challenge.release.buyerNymAddress,
            productId: order.productId,
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

  // Re-send the wrapped key over Nym for an ALREADY-released order. The seller's
  // browser still holds the file-key secret, so it re-wraps for the buyer (read
  // from the release challenge) and re-emits over the mixnet. Used when the
  // one-shot delivery did not reach a buyer who is now listening ("queued").
  //
  // The manual button calls this directly (busy state + a status message). The
  // auto re-send-until-acked loop calls it with { silent: true }, so each ~6s
  // tick does NOT churn busyAction (which would lock the manual button) or spam
  // a per-tick message — the stepper + "Re-sending… (n)" counter carry status.
  async function onResendKeyOverNym(
    order: TransferPublicOrder,
    options?: { silent?: boolean },
  ): Promise<void> {
    const silent = options?.silent ?? false;
    if (!silent) {
      setErrorMessage("");
      setBusyAction("release");
    }
    try {
      const draft = loadReleaseDraftForOrder(order);
      if (!draft) {
        throw new Error(
          locale === "pt"
            ? "Esta maquina nao tem o segredo local do vendedor para este arquivo."
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
      if (
        !challenge.release.buyerPublicKeyJwk ||
        !challenge.release.buyerNymAddress
      ) {
        throw new Error(
          locale === "pt"
            ? "O comprador ainda nao registrou a sessao Nym para receber."
            : "The buyer has not registered a Nym session to receive yet.",
        );
      }
      // Pause the KEY re-send while THIS order's file is actively streaming from
      // this browser: the single Nym client would otherwise compete with itself
      // (delaying file chunks) and pointlessly re-send a key the buyer already has,
      // climbing the buyer's "envelopes" counter. Always send at least once; if the
      // buyer reloads, the file send fails and clears the in-flight flag, so the
      // re-send naturally resumes and a fresh buyer still gets the key.
      const fileStreaming = sellerFileSendInFlightRef.current.has(
        order.orderId,
      );
      const keyAlreadySent = sellerKeySentOnceRef.current.has(order.orderId);
      if (!fileStreaming || !keyAlreadySent) {
        const keyEnvelope = await wrapPaidLinkFileKeyForBuyer(
          draft.fileKey,
          challenge.release.buyerPublicKeyJwk,
        );
        await sendKeyEnvelopeOverNym({
          orderId: order.orderId,
          keyEnvelope,
          buyerNymAddress: challenge.release.buyerNymAddress,
        });
        sellerKeySentOnceRef.current.add(order.orderId);
      }
      // Browser-to-browser FILE delivery alongside the key re-send. Single-flight
      // guarded, so the ~6s re-send loop never starts a second transfer for the
      // same order; the buyer's HTTPS fallback covers a persistent failure. A
      // purchase passes its productId so the shared PRODUCT ciphertext is used.
      maybeSendFileOverNym({
        orderId: order.orderId,
        buyerNymAddress: challenge.release.buyerNymAddress,
        productId: order.productId,
      });
      if (!silent) {
        setReleaseMessage(
          locale === "pt"
            ? "Chave reenviada pela Nym. O comprador (aba aberta) deve receber em segundos."
            : "Key re-sent over Nym. The buyer (tab open) should receive it shortly.",
        );
      }
    } catch (error) {
      if (!silent) {
        setReleaseMessage(formatError(error, copy.errors.serverError));
      }
      // Silent (auto-loop) failures are swallowed: the next ~6s tick retries.
    } finally {
      if (!silent) {
        setBusyAction("idle");
      }
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

  // Files-screen auto-release: while a logged-in seller has the Files screen open,
  // periodically (~8s) fetch the full order for every "paid" file in the list and
  // auto-release the key for any that are still seller_pending AND whose local
  // release secret lives in THIS browser. This is what unblocks an existing paid
  // order without the seller having to do anything — and it never fires for files
  // created on another device (loadSellerReleaseDraft returns null there).
  useEffect(() => {
    if (mode !== "send" || !seller) {
      return;
    }
    if (sellerScreen !== "files") {
      return;
    }
    // Candidate orders: paid SINGLE-USE summaries whose per-order release secret
    // is on this browser. Purchases (file.productId set) are excluded here — they
    // are delivered by the sequential product-delivery loop using the PRODUCT
    // draft, so the single-use path is byte-for-byte unchanged.
    const candidates = sellerFiles
      .filter((file) => file.status === "paid" && !file.productId)
      .map((file) => file.orderId)
      .filter((orderId) => Boolean(loadSellerReleaseDraft(orderId)));
    if (candidates.length === 0) {
      return;
    }

    let active = true;
    async function scanOnce() {
      for (const orderId of candidates) {
        if (!active) {
          return;
        }
        if (dashboardReleasedRef.current.has(orderId)) {
          continue;
        }
        try {
          const body = await postJson<{ order: TransferPublicOrder }>(
            `/api/transfers/${encodeURIComponent(orderId)}`,
            { method: "GET" },
          );
          if (!active) {
            return;
          }
          const order = body.order;
          if (
            order.release?.status === "seller_pending" &&
            isOrderPaid(order) &&
            loadSellerReleaseDraft(orderId)
          ) {
            // Guard before awaiting so a slow release can't double-fire.
            dashboardReleasedRef.current.add(orderId);
            await onReleaseSellerKey(order, { silent: true });
          } else if (order.release?.status === "ready") {
            dashboardReleasedRef.current.add(orderId);
          }
        } catch {
          // Transient failures are non-fatal; retry on the next tick.
        }
      }
    }

    void scanOnce();
    const interval = window.setInterval(() => {
      void scanOnce();
    }, 8000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, seller?.sellerId, sellerScreen, sellerFiles]);

  // Files-screen auto re-send-until-acked (~6s): the SAME robust pure-Nym loop the
  // Manage screen runs, but driven by the Files poll. While a logged-in seller
  // sits on the Files screen, for each "paid" file whose release secret lives in
  // THIS browser, re-fetch the full order and (once it is released, not yet
  // delivered, and the secret is held) re-emit the wrapped key over Nym via the
  // existing onResendKeyOverNym, until nymSession.status === "delivered". So
  // delivery completes with the seller just sitting on the Files screen — no
  // Manage screen needed. dashboardResendInFlightRef guards each order against a
  // slow send overlapping the next tick; dashboardDelivering drives the subtle
  // "Delivering over Nym…" indicator on the affected rows.
  useEffect(() => {
    if (mode !== "send" || !seller) {
      return;
    }
    if (sellerScreen !== "files") {
      return;
    }
    // Single-use orders only: a purchase (file.productId set) is delivered by the
    // sequential product-delivery loop, never this per-order re-send loop, so the
    // single-use behavior is unchanged.
    const candidates = sellerFiles
      .filter(
        (file) =>
          (file.status === "paid" || file.status === "claimed") &&
          !file.productId,
      )
      .map((file) => file.orderId)
      .filter((orderId) => Boolean(loadSellerReleaseDraft(orderId)));
    if (candidates.length === 0) {
      return;
    }

    let active = true;
    const inFlight = dashboardResendInFlightRef.current;

    async function resendScan() {
      for (const orderId of candidates) {
        if (!active || inFlight.has(orderId)) {
          continue;
        }
        try {
          const body = await postJson<{ order: TransferPublicOrder }>(
            `/api/transfers/${encodeURIComponent(orderId)}`,
            { method: "GET" },
          );
          if (!active) {
            return;
          }
          const order = body.order;
          const released = order.release?.status === "ready";
          const delivered = order.delivery.nymSession?.status === "delivered";
          if (delivered || !released || !loadSellerReleaseDraft(orderId)) {
            // Stop tracking this order the moment the buyer ACKs (or it is not
            // re-sendable from this browser yet).
            setDashboardDelivering((current) => {
              if (!current.has(orderId)) {
                return current;
              }
              const next = new Set(current);
              next.delete(orderId);
              return next;
            });
            continue;
          }
          setDashboardDelivering((current) => {
            if (current.has(orderId)) {
              return current;
            }
            const next = new Set(current);
            next.add(orderId);
            return next;
          });
          inFlight.add(orderId);
          try {
            await onResendKeyOverNym(order, { silent: true });
          } finally {
            inFlight.delete(orderId);
          }
        } catch {
          // Transient failures are non-fatal; the next ~6s tick retries.
          inFlight.delete(orderId);
        }
      }
    }

    void resendScan();
    const interval = window.setInterval(() => {
      void resendScan();
    }, RESEND_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, seller?.sellerId, sellerScreen, sellerFiles]);

  // Multi-buyer "product" model (Phase 3b): the SEQUENTIAL per-purchase delivery
  // loop. While a logged-in seller sits on the Files screen (flag on), it delivers
  // the seller's PRODUCT purchases — the orders whose productId matches a product
  // whose release draft lives in THIS browser — one at a time. All sends share
  // the same ~46 KiB/s Nym gateway, so running several at once would stall them;
  // selectNextPurchaseToDeliver enforces one-in-flight and only advances once the
  // current purchase is acked (or fails/timeouts). Per purchase it reuses the same
  // release/re-send machinery as single-use orders (onReleaseSellerKey /
  // onResendKeyOverNym, now product-aware), so the re-send-until-acked behavior is
  // preserved. Single-use orders are handled by the loops above and never enter
  // this queue (they have no productId).
  useEffect(() => {
    if (!productsEnabled() || mode !== "send" || !seller) {
      return;
    }
    if (sellerScreen !== "files") {
      return;
    }
    // Cheap pre-check: nothing to do unless at least one purchase exists whose
    // product draft is on this browser. Avoids spinning an interval otherwise.
    const hasDeliverablePurchase = sellerFiles.some(
      (file) =>
        Boolean(file.productId) &&
        Boolean(loadProductReleaseDraft(file.productId as string)),
    );
    if (!hasDeliverablePurchase) {
      return;
    }

    let active = true;

    async function deliverNext() {
      // Pick the single next purchase to deliver (null when one is in flight or
      // nothing is deliverable). hasReleaseDraft is the localStorage probe.
      const next = selectNextPurchaseToDeliver({
        summaries: sellerFiles,
        inFlightOrderId: productDeliveryInFlightRef.current,
        hasReleaseDraft: (productId) =>
          Boolean(loadProductReleaseDraft(productId)),
      });
      if (!next || !active) {
        return;
      }
      productDeliveryInFlightRef.current = next.orderId;
      setDashboardDelivering((current) => {
        if (current.has(next.orderId)) {
          return current;
        }
        const updated = new Set(current);
        updated.add(next.orderId);
        return updated;
      });
      try {
        // Fetch the full order so release.status / buyer key / Nym address are
        // available (the files summary lacks them).
        const body = await postJson<{ order: TransferPublicOrder }>(
          `/api/transfers/${encodeURIComponent(next.orderId)}`,
          { method: "GET" },
        );
        const order = body.order;
        if (order.delivery.nymSession?.status === "delivered") {
          // Already acked between the poll and now — clear and let the next tick
          // pick the following purchase.
          stopDeliveringIndicator(next.orderId);
          return;
        }
        if (order.release?.status === "seller_pending" && isOrderPaid(order)) {
          // Not released yet: release (which also fires key + file over Nym).
          await onReleaseSellerKey(order, { silent: true });
        } else if (order.release?.status === "ready") {
          // Released but not acked: re-emit the key + file over Nym.
          await onResendKeyOverNym(order, { silent: true });
        }
      } catch {
        // Transient failure: the next tick retries this same purchase (it stays
        // first in the deterministic queue order).
      } finally {
        // Free the in-flight slot so the NEXT tick can advance the queue (to this
        // purchase again if not yet acked, or the following one once it is).
        if (productDeliveryInFlightRef.current === next.orderId) {
          productDeliveryInFlightRef.current = null;
        }
        if (next.nymSessionStatus === "delivered") {
          stopDeliveringIndicator(next.orderId);
        }
      }
    }

    function stopDeliveringIndicator(orderId: string) {
      setDashboardDelivering((current) => {
        if (!current.has(orderId)) {
          return current;
        }
        const updated = new Set(current);
        updated.delete(orderId);
        return updated;
      });
    }

    void deliverNext();
    const interval = window.setInterval(() => {
      void deliverNext();
    }, RESEND_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, seller?.sellerId, sellerScreen, sellerFiles]);

  // Buyer-side polling: while a buyer order is loaded and not yet downloaded,
  // poll the public order status so the flow advances on its own (waiting to
  // pay -> in transit -> confirmed). Stops once the file is opened locally
  // (downloadUrl set). Kept separate from the seller-online poll above (which is
  // gated on mode === "send"), so the two never interfere.
  useEffect(() => {
    if (mode !== "receive" || !loadedOrder) {
      return;
    }
    if (downloadUrl) {
      return;
    }
    const orderId = loadedOrder.orderId;
    let active = true;
    const interval = window.setInterval(() => {
      void (async () => {
        try {
          const body = await postJson<{ order: TransferPublicOrder }>(
            `/api/transfers/${encodeURIComponent(orderId)}`,
            { method: "GET" },
          );
          if (active) {
            setLoadedOrder(body.order);
            setPayment(body.order.payment);
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
  }, [mode, loadedOrder?.orderId, downloadUrl]);

  // BUYER HEARTBEAT — the robust pure-Nym self-heal. The likely failure mode is
  // ADDRESS DRIFT: the seller re-reads order.delivery.nymSession.buyerNymAddress
  // on every re-send, but the buyer's receiver can rotate to a new gateway/
  // address (or never finish bootstrapping), so the seller keeps sending to a
  // stale address while the live receiver listens elsewhere. While the order is
  // paid-but-not-done, every ~8s we (a) ensure the receiver is alive and
  // (b) RE-REGISTER the buyer's CURRENT live Nym address with the order so the
  // seller's next re-send lands. Bounded by a single in-flight guard; tears down
  // the moment the file is in hand (downloadUrl) or the buyer acked
  // (nymSession "delivered"). Claim-on-demand, ack-retry and the idempotency
  // gate (downloadUrl / buyerReceivedRef / nymSession delivered) are untouched.
  useEffect(() => {
    if (mode !== "receive" || !loadedOrder) {
      return;
    }
    const paid = isOrderPaid(loadedOrder);
    const delivered = loadedOrder.delivery.nymSession?.status === "delivered";
    // Only run for a paid order whose file has NOT arrived and is NOT acked.
    if (!paid || downloadUrl || delivered) {
      return;
    }
    // Capture a non-null reference so the async closure does not have to re-narrow
    // loadedOrder (it can flip to null on unmount between ticks).
    const order = loadedOrder;
    const orderId = order.orderId;
    let active = true;

    async function heartbeat() {
      if (!active || buyerHeartbeatInFlightRef.current) {
        return;
      }
      // Re-check the live latches: a download/ack may have landed between ticks.
      if (downloadUrl || buyerReceivedRef.current) {
        return;
      }
      buyerHeartbeatInFlightRef.current = true;
      try {
        // (a) Ensure the receiver is alive. If we have no client at all, or the
        // last bootstrap errored / never started, (re)bootstrap it. startBrowserNym
        // subscribes the inbound handler and updates buyerNymAddress + nymStatus,
        // and returns the LIVE receiver address.
        let liveAddress = "";
        if (
          !browserNymClientRef.current ||
          nymStatus === "error" ||
          nymStatus === "idle"
        ) {
          liveAddress = await startBrowserNym();
        }
        if (!active) {
          return;
        }
        // (b) Re-register the buyer's CURRENT live Nym address with the order so
        // order.delivery.nymSession.buyerNymAddress always equals the address
        // this receiver is actually listening on. Passing the just-bootstrapped
        // address avoids a stale-state closure registering an old address. This
        // is the address-drift fix: the seller re-reads this on every re-send.
        const keyPair = loadBuyerKeyPair(orderId);
        if (keyPair) {
          await registerBuyerNymSession(
            order,
            keyPair,
            liveAddress || undefined,
          );
        }
      } catch {
        // Transient bootstrap/registration failures are non-fatal; the next tick
        // retries. The visible receiver status surfaces a persistent failure.
      } finally {
        buyerHeartbeatInFlightRef.current = false;
      }
    }

    // Fire once immediately so a freshly-paid order re-registers without waiting
    // a full interval, then every ~8s.
    void heartbeat();
    const interval = window.setInterval(() => {
      void heartbeat();
    }, 8000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    loadedOrder?.orderId,
    loadedOrder?.payment?.status,
    loadedOrder?.status,
    loadedOrder?.delivery.nymSession?.status,
    downloadUrl,
    nymStatus,
  ]);

  // Buyer auto-claim: once the seller releases the key (release "ready") for a
  // paid order, fetch + decrypt + auto-download automatically so the buyer never
  // touches a button — this is the dead-simple happy path. openClaimPayload sets
  // downloadUrl AND fires the programmatic save; the inline preview + "Save file"
  // button are the only fallbacks. Fires once; resets when no longer paid+ready.
  useEffect(() => {
    if (mode !== "receive" || !loadedOrder) {
      return;
    }
    const ready =
      isOrderPaid(loadedOrder) && loadedOrder.release?.status === "ready";
    if (!ready || downloadUrl || loadedOrder.status === "claimed") {
      buyerAutoClaimRef.current = false;
      return;
    }
    if (buyerAutoClaimRef.current || busyAction !== "idle") {
      return;
    }
    buyerAutoClaimRef.current = true;
    void onUnlockFile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mode,
    loadedOrder?.orderId,
    loadedOrder?.release?.status,
    loadedOrder?.payment?.status,
    loadedOrder?.status,
    downloadUrl,
    busyAction,
  ]);

  // Keep the Nym-receive idempotency ref current. Mark "received" ONLY when the
  // file is actually opened locally (downloadUrl) or the buyer's ack confirmed
  // receipt (nymSession "delivered"). NOT on "claimed": that is set at claim,
  // BEFORE the key arrives, so it would wrongly drop the re-sent envelope after a
  // reload (downloadUrl lost) and leave the buyer unable to re-receive the file.
  useEffect(() => {
    if (
      downloadUrl ||
      loadedOrder?.delivery.nymSession?.status === "delivered"
    ) {
      buyerReceivedRef.current = true;
    }
  }, [downloadUrl, loadedOrder?.delivery.nymSession?.status]);

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
      <div
        className="zectime-side-logo zectime-side-logo--zcash"
        aria-hidden="true"
      />
      <div
        className="zectime-side-logo zectime-side-logo--nym"
        aria-hidden="true"
      />

      <div className="zk-hub-body zectime-paid-body">
        <section
          className={`frame zectime-paid-hero surface-reveal${
            mode === "receive" ? " zectime-paid-hero--compact" : ""
          }`}
        >
          <div>
            <p className="eyebrow">{copy.shell.eyebrow}</p>
            <h1>{copy.shell.title}</h1>
          </div>
          {mode === "receive" ? null : (
            <>
              <p className="hero-copy">{copy.shell.body}</p>
              <TransferMotion copy={copy} stage={flowMotionStage} />
            </>
          )}
        </section>

        {errorMessage ? (
          <p className="zk-hub-form-feedback zk-hub-form-feedback-error">
            {errorMessage}
          </p>
        ) : null}

        {mode === "send" && sellerSendProgress !== null ? (
          <p
            className="zk-hub-form-feedback ppf-nym-send-progress"
            role="status"
          >
            {copy.sellerStatus.sendingOverNym.replace(
              "{percent}",
              String(sellerSendProgress),
            )}
          </p>
        ) : null}

        {/* Additive perf instrumentation: compact send metrics after a file is
            delivered over Nym (hidden while a new send is in progress). */}
        {mode === "send" &&
        sellerSendProgress === null &&
        sellerTransferMetrics ? (
          <p
            className="zk-hub-form-feedback ppf-nym-send-metrics"
            role="status"
          >
            {copy.sellerStatus.transferMetricsLabel}:{" "}
            {formatTransferMetrics(sellerTransferMetrics)}
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
            productsEnabled={productsEnabled()}
            products={sellerProducts}
            productsStatus={sellerProductsStatus}
            onOpenManage={onOpenManage}
            manageOrder={manageOrder}
            manageStatus={manageStatus}
            onReloadManage={() =>
              manageOrderId ? void loadManageOrder(manageOrderId) : undefined
            }
            releaseMessage={releaseMessage}
            buyerCode={sellerBuyerCode}
            codeConfirmed={sellerCodeConfirmed}
            onConfirmCodeChange={setSellerCodeConfirmed}
            onRevealCode={(order) => void onRevealBuyerCode(order)}
            onRelease={(order) => void onReleaseSellerKey(order)}
            onResend={(order) => void onResendKeyOverNym(order)}
            resending={resending}
            resendAttempt={resendAttempt}
            deliveringOrderIds={dashboardDelivering}
            releaseBusy={busyAction === "release"}
            newSellerAccessKey={newSellerAccessKey}
            accessKeyCopied={accessKeyCopied}
            accessKeyAcknowledged={accessKeyAcknowledged}
            onCopyAccessKey={() => void onCopyNewSellerAccessKey()}
            onAcknowledgeAccessKey={() => setAccessKeyAcknowledged(true)}
            onRegenerateAccessKey={() => void onRegenerateAccessKey()}
            displayNameInput={sellerDisplayName}
            onDisplayNameChange={setSellerDisplayName}
            settingsSaveStatus={settingsSaveStatus}
            onSaveSettings={() => void onSaveSettings()}
            publicLinkCopied={publicLinkCopied}
            onCopyPublicLink={() => void onCopyPublicLink()}
            onLogout={() => void onLogout()}
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

                    {/* Multi-buyer "product" model (Phase 3a): the supply
                        control only renders when the flag is on. With the flag
                        off this block is skipped and the form is identical to
                        the single-use create form. */}
                    {productsEnabled() ? (
                      <fieldset className="zk-hub-form-field">
                        <span className="zk-hub-form-label">
                          {copy.products.supplyLabel}
                        </span>
                        {/* Premium supply selector: two large, fully-clickable
                            option cards (not a tiny radio dot). Accessible as a
                            radiogroup — each card is role=radio with roving
                            tabindex + arrow/space/enter keyboard support, and the
                            whole card is the click target. Same underlying state
                            (open vs limited) as the old radios. */}
                        <SupplySelector
                          value={supplyMode}
                          onChange={setSupplyMode}
                          copy={copy}
                          disabled={isBusy}
                        />
                        {supplyMode === "limited" ? (
                          <input
                            className="ppf-supply-max"
                            value={supplyMax}
                            onChange={(event) =>
                              setSupplyMax(event.target.value)
                            }
                            inputMode="numeric"
                            placeholder={copy.products.supplyMaxPlaceholder}
                            aria-label={copy.products.supplyMaxLabel}
                            disabled={isBusy}
                          />
                        ) : null}
                        <span className="zk-hub-form-hint">
                          {copy.products.supplyHint}
                        </span>
                      </fieldset>
                    ) : null}

                    <button
                      className="button-primary"
                      type="submit"
                      disabled={isBusy}
                    >
                      {busyAction === "encrypting"
                        ? productsEnabled()
                          ? copy.products.busyLabel
                          : copy.send.busyLabel
                        : productsEnabled()
                          ? copy.products.submitLabel
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
                    <div className="zectime-paid-warning">
                      <p className="eyebrow">{copy.send.shareWarningTitle}</p>
                      <p>{copy.send.shareWarningBody}</p>
                    </div>
                    <code>{shareUrl}</code>
                    <div className="zectime-paid-actions">
                      <button
                        type="button"
                        className="button-primary"
                        onClick={() =>
                          void navigator.clipboard.writeText(shareUrl)
                        }
                      >
                        {copy.send.copyLinkLabel}
                      </button>
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

                {/* Multi-buyer "product" model (Phase 3a): the product success
                    state. Only reachable when the flag is on (onCreateProduct
                    sets createdProduct, never createdOrder), so the single-use
                    success block above is untouched when the flag is off. The
                    access-key callout rules still apply via the dashboard's
                    shared callout (rendered by SellerDashboard). */}
                {createdProduct && productShareUrl ? (
                  <div className="zectime-paid-result">
                    <div>
                      <p className="eyebrow">{copy.products.successTitle}</p>
                      <p>{copy.products.successBody}</p>
                    </div>
                    <div className="zectime-paid-warning">
                      <p className="eyebrow">{copy.send.shareWarningTitle}</p>
                      <p>{copy.send.shareWarningBody}</p>
                    </div>
                    <code>{productShareUrl}</code>
                    <div className="zectime-paid-actions">
                      <button
                        type="button"
                        className="button-primary"
                        onClick={() =>
                          void navigator.clipboard.writeText(productShareUrl)
                        }
                      >
                        {copy.products.copyLinkLabel}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </SellerDashboard>
        ) : mode === "send" && !sellerSessionChecked ? (
          <section
            className="frame zectime-paid-panel surface-reveal"
            aria-busy="true"
          >
            <div className="zectime-paid-panel-copy">
              <p className="eyebrow">{copy.shell.eyebrow}</p>
              <span className="ppf-buyer-spinner" aria-hidden="true" />
            </div>
          </section>
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
                        <p className="zk-hub-form-hint">
                          {copy.seller.loginHint}
                        </p>
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
        ) : productBuyerId && !loadedOrder ? (
          // Multi-buyer "product" model (Phase 3b): the product-buyer view. Shows
          // the listing + a Buy button until a purchase succeeds; loadOrder then
          // sets loadedOrder and the BuyerCheckout below takes over the existing
          // pay/receive flow (no duplicated pay/receive UI).
          <ProductBuyPanel
            copy={copy}
            productStatus={productStatus}
            listing={productListing}
            buying={productBuying}
            onBuy={() => void onBuyProduct(productBuyerId)}
          />
        ) : (
          <BuyerCheckout
            copy={copy}
            locale={locale}
            orderInput={orderInput}
            onOrderInputChange={setOrderInput}
            onLoadOrder={onLoadOrder}
            loadedOrder={loadedOrder}
            payment={payment}
            downloadUrl={downloadUrl}
            downloadFileName={downloadFileName}
            receivedVia={receivedVia}
            busyAction={busyAction}
            isBusy={isBusy}
            nymMessage={nymMessage}
            nymStatus={nymStatus}
            nymEnvelopesReceived={nymEnvelopesReceived}
            buyerKeyReceived={buyerKeyReceived}
            buyerReceiveProgress={buyerReceiveProgress}
            buyerTransferMetrics={buyerTransferMetrics}
            onReconnectNym={() => void startBrowserNym()}
            buyerNymAddress={buyerNymAddress}
            onBuyerNymAddressChange={setBuyerNymAddress}
            showManualNymAddress={showManualNymAddress}
            onToggleManualNymAddress={() =>
              setShowManualNymAddress((current) => !current)
            }
            addressCopied={addressCopied}
            onCopyAddress={() => void onCopyPaymentAddress()}
            onDevPay={() => void onDevPay()}
          />
        )}
      </div>
    </main>
  );

  async function onCopyPaymentAddress(): Promise<void> {
    const address = payment?.paymentAddress;
    if (!address) {
      return;
    }
    await navigator.clipboard.writeText(address);
    setAddressCopied(true);
  }
}

// Dead-simple buyer checkout. The buyer pastes/loads a code (or arrives via the
// ?order= link), the QR + address appear automatically, and the flow advances on
// its own via polling: awaiting payment -> in transit -> (modal) -> done. There
// is NO "create payment" button and NO verification-code block; the QR is the
// hero of the screen.
function BuyerCheckout({
  copy,
  locale,
  orderInput,
  onOrderInputChange,
  onLoadOrder,
  loadedOrder,
  payment,
  downloadUrl,
  downloadFileName,
  receivedVia,
  busyAction,
  isBusy,
  nymMessage,
  nymStatus,
  nymEnvelopesReceived,
  buyerKeyReceived,
  buyerReceiveProgress,
  buyerTransferMetrics,
  onReconnectNym,
  buyerNymAddress,
  onBuyerNymAddressChange,
  showManualNymAddress,
  onToggleManualNymAddress,
  addressCopied,
  onCopyAddress,
  onDevPay,
}: {
  copy: PaidPrivateFileCopy;
  locale: ProductLocale;
  orderInput: string;
  onOrderInputChange: (value: string) => void;
  onLoadOrder: (event: FormEvent<HTMLFormElement>) => void;
  loadedOrder: TransferPublicOrder | null;
  payment: TransferPayment | null;
  downloadUrl: string;
  downloadFileName: string;
  receivedVia: "nym" | "https" | null;
  busyAction: BusyAction;
  isBusy: boolean;
  nymMessage: string;
  nymStatus: BrowserNymStatus;
  nymEnvelopesReceived: number;
  buyerKeyReceived: boolean;
  buyerReceiveProgress: number | null;
  buyerTransferMetrics: TransferMetrics | null;
  onReconnectNym: () => void;
  buyerNymAddress: string;
  onBuyerNymAddressChange: (value: string) => void;
  showManualNymAddress: boolean;
  onToggleManualNymAddress: () => void;
  addressCopied: boolean;
  onCopyAddress: () => void;
  onDevPay: () => void;
}) {
  const phase = getBuyerFlowPhase({
    order: loadedOrder,
    payment,
    downloadUrl,
  });

  return (
    <section className="frame zectime-paid-panel surface-reveal">
      <div className="zectime-paid-panel-copy">
        <p className="eyebrow">{copy.tabs.receive}</p>
        <h2>{copy.receive.title}</h2>
        <p>{copy.receive.body}</p>
        <BrandRail copy={copy} />
      </div>

      <div className="ppf-buyer">
        {!loadedOrder ? (
          <form className="zk-hub-form ppf-buyer-load" onSubmit={onLoadOrder}>
            <label className="zk-hub-form-field">
              <span className="zk-hub-form-label">
                {copy.receive.orderLabel}
              </span>
              <input
                value={orderInput}
                onChange={(event) => onOrderInputChange(event.target.value)}
                placeholder={copy.receive.orderPlaceholder}
                disabled={isBusy}
              />
            </label>
            <button className="button-primary" type="submit" disabled={isBusy}>
              {busyAction === "loading"
                ? `${copy.receive.loadLabel}...`
                : copy.receive.loadLabel}
            </button>
          </form>
        ) : (
          <div className="ppf-buyer-stage">
            <OrderDetails order={loadedOrder} copy={copy} />

            {phase === "done" ? (
              // The decrypted file is in hand. The download was already
              // AUTO-TRIGGERED in openClaimPayload (saves without a click); we
              // show the file inline (image/*) so the buyer sees it immediately,
              // and keep a single "Save file" button as the fallback for
              // browsers that block the programmatic download (Safari).
              <div className="ppf-buyer-done" role="status">
                <p className="eyebrow">{copy.receive.arrivedTitle}</p>
                <p>{copy.receive.arrivedBody}</p>
                {receivedVia ? (
                  // Provenance badge: proves which path actually delivered the
                  // file (pure-Nym happy path vs. the HTTPS fallback).
                  <span className="ppf-received-via" data-via={receivedVia}>
                    {receivedVia === "nym"
                      ? copy.receive.receivedViaNym
                      : copy.receive.receivedViaHttps}
                  </span>
                ) : null}
                {downloadUrl &&
                loadedOrder.file.mimeType.startsWith("image/") ? (
                  <img
                    className="ppf-buyer-file-preview"
                    src={downloadUrl}
                    alt={downloadFileName}
                  />
                ) : null}
                {downloadUrl ? (
                  <a
                    className="button-primary zectime-paid-download"
                    href={downloadUrl}
                    download={downloadFileName}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {copy.receive.saveFileLabel}
                  </a>
                ) : null}
              </div>
            ) : phase === "detected" ? (
              // 0-conf: we saw the payment in the mempool but it is NOT
              // confirmed yet. Show "Payment detected / confirming" — the file
              // stays locked until the confirmed paid transition.
              <div
                className="ppf-buyer-status"
                data-tone="transit"
                role="status"
              >
                <span className="ppf-buyer-spinner" aria-hidden="true" />
                <div>
                  <p className="eyebrow">{copy.receive.detectedTitle}</p>
                  <p>{copy.receive.detectedBody}</p>
                </div>
              </div>
            ) : phase === "in-transit" ? (
              // Dead-simple buyer: payment is confirmed and the file has NOT
              // arrived yet. A single "Receiving your file…" spinner card, plus
              // an ALWAYS-VISIBLE compact Nym receiver diagnostic so the buyer
              // (and support) can SEE whether the in-browser receiver is live and
              // on which address — and reconnect it. The auto-claim + auto-
              // download still fire on their own once the package lands over Nym.
              <div className="ppf-buyer-receiving">
                <div
                  className="ppf-buyer-status"
                  data-tone="transit"
                  role="status"
                >
                  <span className="ppf-buyer-spinner" aria-hidden="true" />
                  <div>
                    <p className="eyebrow">{copy.receive.receivingTitle}</p>
                    <p>{copy.receive.receivingBody}</p>
                    {buyerReceiveProgress !== null ? (
                      <p className="ppf-buyer-nym-progress">
                        {copy.receive.receivingOverNym.replace(
                          "{percent}",
                          String(buyerReceiveProgress),
                        )}
                      </p>
                    ) : null}
                  </div>
                </div>
                <NymReceiverDiagnostic
                  copy={copy}
                  nymStatus={nymStatus}
                  buyerNymAddress={buyerNymAddress}
                  nymEnvelopesReceived={nymEnvelopesReceived}
                  buyerKeyReceived={buyerKeyReceived}
                  transferMetrics={buyerTransferMetrics}
                  onReconnectNym={onReconnectNym}
                  isBusy={isBusy}
                />
              </div>
            ) : phase === "awaiting-payment" && payment?.paymentAddress ? (
              <div className="ppf-buyer-pay">
                <div className="ppf-buyer-pay-head">
                  <p className="eyebrow">{copy.receive.payHeadline}</p>
                  <p className="zk-hub-form-hint">{copy.receive.payHelper}</p>
                </div>
                <PaymentQr
                  address={payment.paymentAddress}
                  priceZec={loadedOrder.price.displayZec}
                  copy={copy}
                />
                <div className="ppf-buyer-address">
                  <span className="ppf-buyer-address-label">
                    {copy.details.paymentAddress}
                  </span>
                  <code>{payment.paymentAddress}</code>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={onCopyAddress}
                  >
                    {addressCopied
                      ? copy.receive.copyAddressDoneLabel
                      : copy.receive.copyAddressLabel}
                  </button>
                </div>
                {payment.provider === "dev" ? (
                  <button
                    type="button"
                    className="button-secondary ppf-buyer-devpay"
                    onClick={onDevPay}
                    disabled={isBusy}
                  >
                    {copy.receive.devPayLabel}
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="ppf-buyer-status" role="status">
                <span className="ppf-buyer-spinner" aria-hidden="true" />
                <p>{copy.receive.preparingPaymentLabel}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// Multi-buyer "product" model (Phase 3b): the product-buyer listing + Buy
// button. Shown when a buyer opens a product link (flag on) before they purchase.
// On Buy the parent POSTs the purchase and drives the EXISTING receive flow, so
// this panel never renders pay/receive UI — it is replaced by BuyerCheckout the
// moment loadedOrder is set. Sold-out / closed products hide the Buy button.
function ProductBuyPanel({
  copy,
  productStatus,
  listing,
  buying,
  onBuy,
}: {
  copy: PaidPrivateFileCopy;
  productStatus: "idle" | "loading" | "ready" | "error" | "soldout";
  listing: PublicProductListing | null;
  buying: boolean;
  onBuy: () => void;
}) {
  const supplySummary = listing
    ? listing.supply.mode === "limited"
      ? copy.productBuy.supplyLimited.replace(
          "{left}",
          String(Math.max(0, listing.remainingSupply)),
        )
      : copy.productBuy.supplyOpen
    : "";

  return (
    <section className="frame zectime-paid-panel surface-reveal">
      <div className="zectime-paid-panel-copy">
        <p className="eyebrow">{copy.productBuy.eyebrow}</p>
        <h2>{copy.productBuy.title}</h2>
        <p>{copy.productBuy.body}</p>
        <BrandRail copy={copy} />
      </div>

      <div className="ppf-buyer ppf-product-buy">
        {productStatus === "loading" ? (
          <div className="ppf-buyer-status" role="status">
            <span className="ppf-buyer-spinner" aria-hidden="true" />
            <p>{copy.productBuy.loading}</p>
          </div>
        ) : productStatus === "error" || !listing ? (
          <div className="ppf-files-empty">
            <p className="ppf-files-empty-title">
              {copy.productBuy.errorTitle}
            </p>
            <p className="ppf-muted">{copy.productBuy.errorBody}</p>
          </div>
        ) : (
          <div className="ppf-buyer-stage">
            <div className="ppf-product-listing">
              <p className="ppf-file-name">{listing.file.fileName}</p>
              <p className="ppf-file-price">{listing.price.displayZec} ZEC</p>
              <p className="ppf-muted">
                {productStatus === "soldout"
                  ? copy.productBuy.soldOut
                  : supplySummary}
              </p>
            </div>
            {productStatus === "soldout" ? (
              <div
                className="zectime-paid-warning"
                role="note"
                data-tone="warning"
              >
                <p className="eyebrow">{copy.productBuy.soldOutTitle}</p>
                <p>{copy.productBuy.soldOutBody}</p>
              </div>
            ) : (
              <button
                type="button"
                className="button-primary"
                onClick={onBuy}
                disabled={buying}
              >
                {buying
                  ? copy.productBuy.buyingLabel
                  : copy.productBuy.buyLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// Compact, ALWAYS-VISIBLE Nym receiver diagnostic for the "Receiving your file…"
// card. Shows whether the in-browser receiver is connected (mapped from the
// BrowserNymStatus state), the buyer's short live Nym address, the count of
// envelopes seen this session, and a Reconnect button. This is what makes the
// receiver state observable in a screenshot — if delivery stalls, the buyer can
// SEE whether the receiver is even connecting.
function NymReceiverDiagnostic({
  copy,
  nymStatus,
  buyerNymAddress,
  nymEnvelopesReceived,
  buyerKeyReceived,
  transferMetrics,
  onReconnectNym,
  isBusy,
}: {
  copy: PaidPrivateFileCopy;
  nymStatus: BrowserNymStatus;
  buyerNymAddress: string;
  nymEnvelopesReceived: number;
  buyerKeyReceived: boolean;
  // Additive perf instrumentation: the last completed Nym receive metrics, shown
  // as a compact numeric line in this (dev/diagnostic) row. null until done.
  transferMetrics: TransferMetrics | null;
  onReconnectNym: () => void;
  isBusy: boolean;
}) {
  // Map the raw receiver state to a layperson connection state + a tone for the
  // status dot. "ready"/"waiting" = connected; "starting" = connecting;
  // "idle"/"error" = not connected.
  const connectionState: "connected" | "connecting" | "down" =
    nymStatus === "ready" || nymStatus === "waiting"
      ? "connected"
      : nymStatus === "starting"
        ? "connecting"
        : "down";
  const stateLabel =
    connectionState === "connected"
      ? buyerKeyReceived
        ? copy.buyerStatus.nymKeyReceived
        : copy.buyerStatus.nymConnected
      : connectionState === "connecting"
        ? copy.buyerStatus.nymConnecting
        : copy.buyerStatus.nymNotConnected;
  const address = buyerNymAddress.trim();
  const shortAddress = address
    ? shortNymAddress(address)
    : copy.buyerStatus.receiverAddressEmpty;

  return (
    <div className="ppf-nym-diag" data-state={connectionState} role="status">
      <div className="ppf-nym-diag-row">
        <span className="ppf-nym-diag-dot" aria-hidden="true" />
        <span className="ppf-nym-diag-state">
          {copy.buyerStatus.receiverStatusLabel}: {stateLabel}
        </span>
        <button
          type="button"
          className="ppf-nym-diag-reconnect"
          onClick={onReconnectNym}
          disabled={isBusy}
        >
          {copy.buyerStatus.reconnectNymLabel}
        </button>
      </div>
      <dl className="ppf-nym-diag-meta">
        <div>
          <dt>{copy.buyerStatus.nymAddressLabel}</dt>
          <dd>
            <code>{shortAddress}</code>
          </dd>
        </div>
        <div>
          <dt>{copy.buyerStatus.receiverEnvelopesLabel}</dt>
          <dd>{nymEnvelopesReceived}</dd>
        </div>
      </dl>
      {transferMetrics ? (
        <p className="ppf-nym-diag-metrics">
          {copy.buyerStatus.transferMetricsLabel}:{" "}
          {formatTransferMetrics(transferMetrics)}
        </p>
      ) : null}
    </div>
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
  productsEnabled: productsFlag,
  products,
  productsStatus,
  onOpenManage,
  manageOrder,
  manageStatus,
  onReloadManage,
  releaseMessage,
  buyerCode,
  codeConfirmed,
  onConfirmCodeChange,
  onRevealCode,
  onRelease,
  onResend,
  resending,
  resendAttempt,
  deliveringOrderIds,
  releaseBusy,
  newSellerAccessKey,
  accessKeyCopied,
  accessKeyAcknowledged,
  onCopyAccessKey,
  onAcknowledgeAccessKey,
  onRegenerateAccessKey,
  displayNameInput,
  onDisplayNameChange,
  settingsSaveStatus,
  onSaveSettings,
  publicLinkCopied,
  onCopyPublicLink,
  onLogout,
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
  productsEnabled: boolean;
  products: SellerProductSummary[];
  productsStatus: "idle" | "loading" | "ready" | "error";
  onOpenManage: (orderId: string) => void;
  manageOrder: TransferPublicOrder | null;
  manageStatus: "idle" | "loading" | "ready" | "error";
  onReloadManage: () => void;
  releaseMessage: string;
  buyerCode: string;
  codeConfirmed: boolean;
  onConfirmCodeChange: (confirmed: boolean) => void;
  onRevealCode: (order: TransferPublicOrder) => void;
  onRelease: (order: TransferPublicOrder) => void;
  onResend: (order: TransferPublicOrder) => void;
  resending: boolean;
  resendAttempt: number;
  deliveringOrderIds: Set<string>;
  releaseBusy: boolean;
  newSellerAccessKey: string;
  accessKeyCopied: boolean;
  accessKeyAcknowledged: boolean;
  onCopyAccessKey: () => void;
  onAcknowledgeAccessKey: () => void;
  onRegenerateAccessKey: () => void;
  displayNameInput: string;
  onDisplayNameChange: (value: string) => void;
  settingsSaveStatus: "idle" | "saving" | "saved";
  onSaveSettings: () => void;
  publicLinkCopied: boolean;
  onCopyPublicLink: () => void;
  onLogout: () => void;
  isBusy: boolean;
  children: ReactNode;
}) {
  const tabs: Array<{ screen: SellerScreen; label: string }> = [
    { screen: "files", label: copy.dashboard.tabFiles },
    { screen: "settings", label: copy.dashboard.tabSettings },
  ];
  // The create + manage sub-screens are reached from the Files tab, so they keep
  // the Files tab highlighted.
  const activeTab =
    screen === "create" || screen === "manage" ? "files" : screen;

  return (
    <section className="frame ppf-shop surface-reveal">
      <header className="ppf-shop-header">
        <div className="ppf-shop-identity">
          <h2>{seller.displayName}</h2>
          <p className="ppf-shop-handle">@{seller.handle}</p>
        </div>
        <div className="ppf-shop-actions">
          <button
            type="button"
            className="button-primary ppf-shop-cta"
            onClick={() => onScreenChange("create")}
          >
            {copy.dashboard.createFileCta}
          </button>
          <button
            type="button"
            className="button-secondary ppf-shop-signout"
            onClick={onLogout}
            disabled={isBusy}
          >
            {copy.dashboard.signOutLabel}
          </button>
        </div>
      </header>

      {newSellerAccessKey && !accessKeyAcknowledged ? (
        <div
          className="zectime-key-vault ppf-shop-access-key-callout"
          data-tone="warn"
          role="alert"
        >
          <div>
            <p className="eyebrow">{copy.seller.accessKeySavedTitle}</p>
            <p>{copy.seller.accessKeyCalloutBody}</p>
          </div>
          <code>{newSellerAccessKey}</code>
          <div className="zectime-paid-actions">
            <button
              type="button"
              className="button-secondary"
              onClick={onCopyAccessKey}
            >
              {accessKeyCopied
                ? copy.seller.accessKeyCopiedLabel
                : copy.seller.accessKeyCopyLabel}
            </button>
            <button
              type="button"
              className="button-primary"
              onClick={onAcknowledgeAccessKey}
            >
              {copy.seller.accessKeySavedAckLabel}
            </button>
          </div>
        </div>
      ) : null}

      <p className="ppf-keep-open-banner" role="note">
        {copy.dashboard.keepTabOpenBanner}
      </p>

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
            onClick={() => onScreenChange("files")}
          >
            ← {copy.dashboard.backToDashboard}
          </button>
          {children}
        </div>
      ) : screen === "manage" ? (
        <div className="ppf-shop-screen">
          <button
            type="button"
            className="ppf-shop-back"
            onClick={() => onScreenChange("files")}
          >
            ← {copy.dashboard.backToDashboard}
          </button>
          <SellerManageScreen
            copy={copy}
            locale={locale}
            order={manageOrder}
            status={manageStatus}
            onReload={onReloadManage}
            releaseMessage={releaseMessage}
            buyerCode={buyerCode}
            codeConfirmed={codeConfirmed}
            onConfirmCodeChange={onConfirmCodeChange}
            onRevealCode={onRevealCode}
            onRelease={onRelease}
            onResend={onResend}
            resending={resending}
            resendAttempt={resendAttempt}
            releaseBusy={releaseBusy}
            isBusy={isBusy}
          />
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
          newSellerAccessKey={newSellerAccessKey}
          onRegenerateAccessKey={onRegenerateAccessKey}
          isBusy={isBusy}
        />
      ) : (
        <div className="ppf-shop-screen">
          {/* Multi-buyer "product" model (Phase 3a): when the flag is on, the
              seller's products render above the single-use files (clearly
              labeled). With the flag off this block is skipped and only the
              files list shows — the dashboard is byte-for-byte unchanged. */}
          {productsFlag ? (
            <SellerProductsList
              copy={copy}
              locale={locale}
              products={products}
              productsStatus={productsStatus}
              files={files}
            />
          ) : null}
          <SellerFilesList
            copy={copy}
            locale={locale}
            files={files}
            filesStatus={filesStatus}
            onOpenManage={onOpenManage}
            deliveringOrderIds={deliveringOrderIds}
            productsEnabled={productsFlag}
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
  // Show the viewing-key fingerprint in FULL (no slice/ellipsis) so the seller
  // can read + verify it; long strings wrap via the ppf-receiving-address class.
  const fingerprint = seller.ufvkFingerprint ?? null;
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
                <code className="ppf-receiving-address">{fingerprint}</code>
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
  onOpenManage,
  deliveringOrderIds,
  productsEnabled: productsFlag,
}: {
  copy: PaidPrivateFileCopy;
  locale: ProductLocale;
  files: SellerFile[];
  filesStatus: "idle" | "loading" | "ready" | "error";
  onOpenManage: (orderId: string) => void;
  deliveringOrderIds: Set<string>;
  productsEnabled: boolean;
}) {
  // Resolve the "Your files" naming clash: with the multi-buyer "file" feature on,
  // the catalog list (SellerProductsList) is the primary "Your files", and THIS
  // legacy single-use list only holds OLD one-time orders (no productId). So when
  // the flag is on we (1) filter out product purchases — they already appear,
  // aggregated, under their file row — and (2) relabel the heading to the
  // secondary "Earlier one-time links". With the flag off nothing changes: the
  // full list renders under "Your files", byte-for-byte as before.
  const visibleFiles = productsFlag
    ? files.filter((file) => !file.productId)
    : files;
  const heading = productsFlag
    ? copy.dashboard.legacyFilesTitle
    : copy.dashboard.filesTitle;

  // With the flag on, an empty legacy list means the seller never used the old
  // single-use flow — there is nothing secondary to show, so hide the section
  // entirely rather than render a confusing second "no files yet" empty state.
  // (Flag off keeps the empty state so a brand-new seller sees the prompt.)
  if (productsFlag && filesStatus !== "loading" && visibleFiles.length === 0) {
    return null;
  }

  return (
    <div className="ppf-files">
      <p className="eyebrow">{heading}</p>
      {filesStatus === "loading" && visibleFiles.length === 0 ? (
        <p className="ppf-muted">{copy.dashboard.filesLoading}</p>
      ) : visibleFiles.length === 0 ? (
        <div className="ppf-files-empty">
          <p className="ppf-files-empty-title">
            {copy.dashboard.filesEmptyTitle}
          </p>
          <p className="ppf-muted">{copy.dashboard.filesEmptyBody}</p>
        </div>
      ) : (
        <ul className="ppf-files-list">
          {visibleFiles.map((file) => {
            // A paid summary is the seller's cue to deliver: surface a release
            // CTA. For any other status, "Manage" opens the same detail screen.
            const isPaid = file.status === "paid";
            const manageLabel = isPaid
              ? copy.dashboard.fileReleaseLabel
              : copy.dashboard.fileManageLabel;
            // Subtle indicator: this browser is actively re-sending the key over
            // Nym for this order (the dashboard auto re-send loop), so the seller
            // sees delivery in progress without opening Manage.
            const delivering = deliveringOrderIds.has(file.orderId);
            return (
              <li key={file.orderId} className="ppf-file-row">
                <div className="ppf-file-main">
                  <span className="ppf-file-name">{file.fileName}</span>
                  <span className="ppf-file-price">{file.displayZec} ZEC</span>
                  {delivering ? (
                    <span className="ppf-file-delivering" role="status">
                      <span
                        className="ppf-file-delivering-dot"
                        aria-hidden="true"
                      />
                      {copy.sellerStatus.autoResendingLabel}
                    </span>
                  ) : null}
                </div>
                <div className="ppf-file-side">
                  <span
                    className="ppf-status-badge"
                    data-status={file.status}
                    data-acked={
                      file.nymSessionStatus === "delivered" ? "true" : "false"
                    }
                  >
                    {formatFileStatus(
                      file.status,
                      copy,
                      file.nymSessionStatus,
                      file.deliveredVia,
                    )}
                  </span>
                  <button
                    type="button"
                    className={
                      isPaid
                        ? "ppf-file-manage ppf-file-manage-cta"
                        : "ppf-file-manage"
                    }
                    onClick={() => onOpenManage(file.orderId)}
                  >
                    {manageLabel}
                  </button>
                  <FileShareCopyButton
                    sharePath={file.sharePath}
                    locale={locale}
                    copy={copy}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Copy the buyer payment link to the clipboard. The seller must NEVER open this
// link in their own browser — doing so auto-creates a payment intent and binds
// the order's buyer slot to the seller's browser, so the real buyer can no longer
// claim. The seller's only action is to copy it and send it to the buyer.
function FileShareCopyButton({
  sharePath,
  locale,
  copy,
}: {
  sharePath: string;
  locale: ProductLocale;
  copy: PaidPrivateFileCopy;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ppf-file-open"
      onClick={() => {
        const url = new URL(
          withProductLocale(sharePath, locale),
          window.location.origin,
        ).toString();
        void navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied
        ? copy.dashboard.fileLinkCopiedLabel
        : copy.dashboard.fileCopyLinkLabel}
    </button>
  );
}

// Premium supply selector for the create-file form: two large option CARDS
// (segmented control) instead of fiddly radio dots. The whole card is the click
// target, with a clear selected state (accent border + check). Accessible as a
// WAI-ARIA radiogroup: roving tabindex (only the selected card is tab-focusable),
// Arrow/Home/End move + select, Space/Enter select the focused card. Same
// underlying open/limited state as the old radios, so create logic is unchanged.
const SUPPLY_ORDER: ProductSupplyMode[] = ["open", "limited"];

function SupplySelector({
  value,
  onChange,
  copy,
  disabled,
}: {
  value: ProductSupplyMode;
  onChange: (mode: ProductSupplyMode) => void;
  copy: PaidPrivateFileCopy;
  disabled: boolean;
}) {
  const options: Array<{
    mode: ProductSupplyMode;
    label: string;
    desc: string;
  }> = [
    {
      mode: "open",
      label: copy.products.supplyOpenLabel,
      desc: copy.products.supplyOpenDesc,
    },
    {
      mode: "limited",
      label: copy.products.supplyLimitedLabel,
      desc: copy.products.supplyLimitedDesc,
    },
  ];

  const groupRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // APG radiogroup: focus must follow selection. When the selection changes while
  // the group already owns focus (keyboard nav), move browser focus to the newly
  // checked card so the focus ring and aria-checked never diverge. Guarded by
  // contains(activeElement) so we never steal focus on mount or external change.
  useEffect(() => {
    const group = groupRef.current;
    if (!group || !group.contains(document.activeElement)) {
      return;
    }
    optionRefs.current[SUPPLY_ORDER.indexOf(value)]?.focus();
  }, [value]);

  function moveSelection(delta: number) {
    if (disabled) {
      return;
    }
    const currentIndex = SUPPLY_ORDER.indexOf(value);
    const nextIndex =
      (currentIndex + delta + SUPPLY_ORDER.length) % SUPPLY_ORDER.length;
    onChange(SUPPLY_ORDER[nextIndex]);
  }

  return (
    <div
      ref={groupRef}
      className="ppf-supply-options"
      role="radiogroup"
      aria-label={copy.products.supplyLabel}
    >
      {options.map((option, index) => {
        const selected = value === option.mode;
        return (
          <button
            key={option.mode}
            ref={(el) => {
              optionRefs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className="ppf-supply-option"
            data-selected={selected ? "true" : "false"}
            disabled={disabled}
            onClick={() => onChange(option.mode)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                moveSelection(1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                moveSelection(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                if (!disabled) onChange(SUPPLY_ORDER[0]);
              } else if (event.key === "End") {
                event.preventDefault();
                if (!disabled) onChange(SUPPLY_ORDER[SUPPLY_ORDER.length - 1]);
              } else if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                onChange(option.mode);
              }
            }}
          >
            <span className="ppf-supply-option-indicator" aria-hidden="true" />
            <span className="ppf-supply-option-text">
              <span className="ppf-supply-option-label">{option.label}</span>
              <span className="ppf-supply-option-desc">{option.desc}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Multi-buyer "file" model: the seller's catalog files in the dashboard — the
// PRIMARY "Your files" list. Each row shows a supply badge (Unlimited / Limited),
// the file name + price, a COMPACT purchases aggregate ("2/3 delivered · 1 in
// progress"), a supply/sold-out status badge, and a Copy-link button. Delivery is
// automatic (the sequential product-delivery loop); the aggregate just surfaces
// the rolled-up delivered/in-progress counts, never one row per purchase.
function SellerProductsList({
  copy,
  locale,
  products,
  productsStatus,
  files,
}: {
  copy: PaidPrivateFileCopy;
  locale: ProductLocale;
  products: SellerProductSummary[];
  productsStatus: "idle" | "loading" | "ready" | "error";
  files: SellerFile[];
}) {
  // Group the seller's purchases (orders carrying a productId) by product so each
  // product row can list its own purchases. Single-use files (no productId) are
  // ignored here — they render in SellerFilesList unchanged.
  const purchasesByProduct = new Map<string, SellerFile[]>();
  for (const file of files) {
    if (!file.productId) {
      continue;
    }
    const existing = purchasesByProduct.get(file.productId) ?? [];
    existing.push(file);
    purchasesByProduct.set(file.productId, existing);
  }

  return (
    <div className="ppf-files ppf-products">
      <p className="eyebrow">{copy.products.listTitle}</p>
      {productsStatus === "loading" && products.length === 0 ? (
        <p className="ppf-muted">{copy.products.listLoading}</p>
      ) : products.length === 0 ? (
        <div className="ppf-files-empty">
          <p className="ppf-files-empty-title">
            {copy.products.listEmptyTitle}
          </p>
          <p className="ppf-muted">{copy.products.listEmptyBody}</p>
        </div>
      ) : (
        <ul className="ppf-files-list">
          {products.map((product) => {
            const supplySummary =
              product.supply.mode === "limited"
                ? copy.products.supplyLimitedSummary
                    .replace("{sold}", String(product.salesCount))
                    .replace("{max}", String(product.supply.max))
                : copy.products.supplyOpenSummary;
            const purchases = purchasesByProduct.get(product.productId) ?? [];
            // The products list is now the primary "Your files": label each row
            // with its SUPPLY (Unlimited / Limited) instead of a generic
            // "Product" badge, so the seller sees the file's supply at a glance.
            const supplyBadge =
              product.supply.mode === "limited"
                ? copy.products.supplyBadgeLimited
                : copy.products.supplyBadgeOpen;
            return (
              <li key={product.productId} className="ppf-file-row">
                <div className="ppf-file-main">
                  <span
                    className="ppf-supply-badge"
                    data-supply={product.supply.mode}
                  >
                    {supplyBadge}
                  </span>
                  <span className="ppf-file-name">{product.fileName}</span>
                  <span className="ppf-file-price">
                    {product.displayZec} ZEC
                  </span>
                  <ProductPurchasesSummary copy={copy} purchases={purchases} />
                </div>
                <div className="ppf-file-side">
                  <span
                    className="ppf-status-badge"
                    data-status={product.status}
                  >
                    {product.soldOut
                      ? copy.products.soldOutLabel
                      : supplySummary}
                  </span>
                  <ProductShareCopyButton
                    sharePath={product.sharePath}
                    locale={locale}
                    copy={copy}
                    soldOut={product.soldOut}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Multi-buyer "file" model: a COMPACT aggregate of a file's purchases (no
// row-per-purchase). Renders one quiet line — "{delivered}/{total} delivered"
// plus an optional " · {inProgress} in progress" clause for paid/claimed
// purchases the buyer has not yet acked. "Delivered" follows the same honest rule
// as formatFileStatus: it means the buyer ACKed over Nym. Counts come from the
// pure, unit-tested computePurchaseCounts/formatPurchaseSummary helpers. Renders
// nothing when there are no purchases yet (keeps an unsold file row clean).
function ProductPurchasesSummary({
  copy,
  purchases,
}: {
  copy: PaidPrivateFileCopy;
  purchases: SellerFile[];
}) {
  if (purchases.length === 0) {
    return null;
  }
  const counts = computePurchaseCounts(purchases);
  const summary = formatPurchaseSummary(counts, {
    deliveredSummary: copy.purchases.deliveredSummary,
    inProgressSuffix: copy.purchases.inProgressSuffix,
  });
  return (
    <span
      className="ppf-product-purchases-summary"
      data-in-progress={counts.inProgress > 0 ? "true" : "false"}
      role="status"
    >
      {summary}
    </span>
  );
}

// Copy the PRODUCT share link to the clipboard. Unlike the single-use file link,
// a product link is safe to open by many buyers (each purchase spawns its own
// order), but the seller still copies-and-sends it rather than opening it.
//
// Phase 3c: once the product is SOLD OUT the link is dead — opening it can only
// ever show the sold-out state, never a purchase — so the Copy button is disabled
// and relabeled. Open and not-yet-sold-out limited products keep the working
// button. Mirrors lib/server isProductLinkShareable on the client.
function ProductShareCopyButton({
  sharePath,
  locale,
  copy,
  soldOut,
}: {
  sharePath: string;
  locale: ProductLocale;
  copy: PaidPrivateFileCopy;
  soldOut: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (soldOut) {
    return (
      <button
        type="button"
        className="ppf-file-open"
        disabled
        title={copy.products.copyLinkSoldOutHint}
      >
        {copy.products.copyLinkSoldOutLabel}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="ppf-file-open"
      onClick={() => {
        const url = new URL(
          withProductLocale(sharePath, locale),
          window.location.origin,
        ).toString();
        void navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? copy.products.linkCopiedLabel : copy.products.copyLinkLabel}
    </button>
  );
}

// Per-file manage / release detail. Loads the full order (the files summary lacks
// release.status), shows the status, and either renders SellerReleasePanel (the
// shared manual-release machinery) or — when this browser does not hold the local
// release secret — a clear "secret on another device" callout, since seller-held
// custody means the key can only be released from the creating browser.
function SellerManageScreen({
  copy,
  locale,
  order,
  status,
  onReload,
  releaseMessage,
  buyerCode,
  codeConfirmed,
  onConfirmCodeChange,
  onRevealCode,
  onRelease,
  onResend,
  resending,
  resendAttempt,
  releaseBusy,
  isBusy,
}: {
  copy: PaidPrivateFileCopy;
  locale: ProductLocale;
  order: TransferPublicOrder | null;
  status: "idle" | "loading" | "ready" | "error";
  onReload: () => void;
  releaseMessage: string;
  buyerCode: string;
  codeConfirmed: boolean;
  onConfirmCodeChange: (confirmed: boolean) => void;
  onRevealCode: (order: TransferPublicOrder) => void;
  onRelease: (order: TransferPublicOrder) => void;
  onResend: (order: TransferPublicOrder) => void;
  resending: boolean;
  resendAttempt: number;
  releaseBusy: boolean;
  isBusy: boolean;
}) {
  if (status === "loading" || (status === "idle" && !order)) {
    return <p className="ppf-muted">{copy.dashboard.manageLoading}</p>;
  }
  if (status === "error" || !order) {
    return (
      <div className="ppf-files-empty">
        <p className="ppf-files-empty-title">{copy.dashboard.manageError}</p>
        <button type="button" className="button-secondary" onClick={onReload}>
          {copy.dashboard.fileManageLabel}
        </button>
      </div>
    );
  }

  // Seller-held custody: the wrap secret lives only in the browser that created
  // the file. If it is absent here, no release is possible from this device.
  const hasSecret = Boolean(loadSellerReleaseDraft(order.orderId));
  const released = order.release?.status === "ready";
  const delivered = order.delivery.nymSession?.status === "delivered";

  return (
    <div className="ppf-manage">
      <div className="ppf-manage-head">
        <p className="eyebrow">{copy.dashboard.manageTitle}</p>
        <p className="ppf-file-name">{order.file.fileName}</p>
        <p className="ppf-file-price">{order.price.displayZec} ZEC</p>
      </div>
      <div className="ppf-manage-status">
        <span className="ppf-muted">{copy.dashboard.manageStatusLabel}</span>
        <span
          className="ppf-status-badge"
          data-status={order.status}
          data-acked={delivered ? "true" : "false"}
        >
          {formatFileStatus(
            order.status,
            copy,
            order.delivery.nymSession?.status,
          )}
        </span>
      </div>

      <SellerStatusStepper copy={copy} order={order} />

      {hasSecret ? (
        <>
          <SellerReleasePanel
            order={order}
            locale={locale}
            busy={releaseBusy}
            releaseMessage={releaseMessage}
            buyerCode={buyerCode}
            codeConfirmed={codeConfirmed}
            onConfirmCodeChange={onConfirmCodeChange}
            onRevealCode={() => onRevealCode(order)}
            onRelease={() => onRelease(order)}
            disabled={isBusy}
          />

          {/* Robust pure-Nym delivery: an always-visible re-send button plus an
              auto re-send-until-acked loop. Shown only once the key is released
              (there is nothing to send before that). */}
          {released ? (
            <div
              className="ppf-resend"
              data-tone={delivered ? "ok" : "pending"}
            >
              <p
                className="ppf-resend-status"
                data-delivered={delivered ? "true" : "false"}
              >
                {delivered
                  ? `${copy.sellerStatus.deliveredToBuyer} ✓`
                  : resending
                    ? `${copy.sellerStatus.autoResendingLabel} (${resendAttempt})`
                    : copy.sellerStatus.notDeliveredYet}
              </p>
              {!delivered ? (
                <>
                  <button
                    type="button"
                    className="button-secondary ppf-resend-button"
                    onClick={() => onResend(order)}
                    disabled={releaseBusy}
                  >
                    {releaseBusy
                      ? copy.sellerStatus.resendingLabel
                      : copy.sellerStatus.resendLabel}
                  </button>
                  <p className="zk-hub-form-hint">
                    {copy.sellerStatus.keepTabOpenHint}
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="ppf-shop-reminder" role="note" data-tone="warning">
          <p className="eyebrow">{copy.dashboard.secretMissingTitle}</p>
          <p>{copy.dashboard.secretMissingBody}</p>
        </div>
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
  newSellerAccessKey,
  onRegenerateAccessKey,
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
  newSellerAccessKey: string;
  onRegenerateAccessKey: () => void;
  isBusy: boolean;
}) {
  // Two-step inline confirm so a single misclick can't rotate (and invalidate)
  // the seller's access key. "Regenerate" reveals the confirm/cancel pair.
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
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
          className="button-primary ppf-settings-save"
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

      {newSellerAccessKey ? null : (
        <section className="ppf-settings-block">
          <div className="ppf-shop-reminder" role="note">
            <p className="eyebrow">{copy.dashboard.accessKeyReminderTitle}</p>
            <p>{copy.dashboard.accessKeyReminderBody}</p>
          </div>
          <div className="ppf-shop-reminder" data-tone="warn" role="note">
            <p className="eyebrow">{copy.dashboard.accessKeyRegenerateTitle}</p>
            <p>{copy.dashboard.accessKeyRegenerateWarning}</p>
            {confirmingRegenerate ? (
              <div className="zectime-paid-actions">
                <button
                  type="button"
                  className="button-primary"
                  onClick={() => {
                    setConfirmingRegenerate(false);
                    onRegenerateAccessKey();
                  }}
                  disabled={isBusy}
                >
                  {isBusy
                    ? copy.dashboard.accessKeyRegeneratingLabel
                    : copy.dashboard.accessKeyRegenerateConfirmLabel}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setConfirmingRegenerate(false)}
                  disabled={isBusy}
                >
                  {copy.dashboard.accessKeyRegenerateCancelLabel}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="button-secondary ppf-regenerate-cta"
                onClick={() => setConfirmingRegenerate(true)}
                disabled={isBusy}
              >
                {copy.dashboard.accessKeyRegenerateLabel}
              </button>
            )}
          </div>
        </section>
      )}

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

// Pure mapping of a file summary status to its dashboard label. Kept exported so
// it can be unit-tested without React; the dashboard "YOUR FILES" list and the
// manage screen both render off this. A paid file is the seller's cue to deliver,
// so it reads "ready to deliver" rather than a bare "Paid".
export function formatFileStatus(
  status: TransferPublicOrder["status"],
  copy: PaidPrivateFileCopy,
  nymSessionStatus?: string | null,
  deliveredVia?: "nym" | "https" | null,
): string {
  // Honest delivery label: "Delivered" must mean the BUYER actually ACKed the
  // file over Nym (nymSession.status === "delivered"). A "claimed" order only
  // means the buyer fetched the signed ciphertext URL — the key may still be in
  // flight and the buyer may not have opened anything. So a claimed/paid order
  // that has not been acked reads "Delivering" / "Awaiting delivery", and only
  // the delivered ack maps to "Delivered".
  const acked = nymSessionStatus === "delivered";
  // The seller's browser has released + started sending the key once the nym
  // session has advanced past its initial "waiting for payment" state.
  const releasedAndSending =
    nymSessionStatus === "ready_for_delivery" ||
    nymSessionStatus === "queued" ||
    nymSessionStatus === "sent_nym_client";
  // Delivered label + an optional delivery-path suffix (pitch value): once the
  // buyer has acked we know "Delivered"; if the buyer also reported the path,
  // append "· Nym" / "· HTTPS". Backward-compatible: a missing path leaves the
  // bare "Delivered" untouched.
  const deliveredLabel = `${copy.dashboard.statusClaimed}${deliveredViaSuffix(copy, deliveredVia)}`;
  switch (status) {
    case "payment_pending":
      return copy.dashboard.statusPaymentPending;
    case "paid":
      if (acked) {
        return deliveredLabel;
      }
      // Key released and being sent over Nym, but the buyer has not claimed yet:
      // it is in flight, not "ready to deliver" anymore.
      if (releasedAndSending) {
        return copy.dashboard.statusAwaitingDelivery;
      }
      // Not released yet: the seller's cue that the file is ready to deliver.
      return copy.dashboard.statusPaidReady;
    case "claimed":
      // Buyer ran their claim but has not yet acked: the key is in transit over
      // Nym, so show "Delivering" — not the misleading "Delivered".
      return acked ? deliveredLabel : copy.dashboard.statusDelivering;
    case "created":
    default:
      return copy.dashboard.statusCreated;
  }
}

// The delivery-path suffix appended to a Delivered label, e.g. " · Nym" /
// " · HTTPS". Empty string when the path is unknown (older orders) so the bare
// "Delivered" label is preserved.
function deliveredViaSuffix(
  copy: PaidPrivateFileCopy,
  deliveredVia?: "nym" | "https" | null,
): string {
  if (deliveredVia === "nym") {
    return copy.dashboard.deliveredViaNymSuffix;
  }
  if (deliveredVia === "https") {
    return copy.dashboard.deliveredViaHttpsSuffix;
  }
  return "";
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

// Minimal structural view of an order the buyer-flow helpers read. Kept narrow
// (status + the payment fields the flow needs) so the pure helpers can be
// unit-tested with tiny fixtures while real TransferPublicOrder values still
// satisfy it. detectedAt/onchain drive the 0-conf "Payment detected" signal.
export interface BuyerOrderStatusView {
  status: TransferPublicOrder["status"];
  payment: {
    status: TransferPayment["status"];
    detectedAt?: string | null;
    onchain?: { txid: string } | null;
  } | null;
}

// True once the scanner has reported an UNCONFIRMED mempool sighting for this
// order (detectedAt set, or an onchain sighting recorded) — the instant-UX
// "we saw your payment" signal. This does NOT imply paid: a 0-conf tx can be
// double-spent, so the key release stays gated on isOrderPaid.
export function isPaymentDetected(
  order: BuyerOrderStatusView | null | undefined,
): boolean {
  if (!order?.payment) {
    return false;
  }
  return Boolean(order.payment.detectedAt) || Boolean(order.payment.onchain);
}

// True once the order's payment is confirmed (paid), regardless of which field
// the server surfaces it on. Used to drive the buyer paid-modal + status.
export function isOrderPaid(
  order: BuyerOrderStatusView | null | undefined,
): boolean {
  if (!order) {
    return false;
  }
  return (
    order.payment?.status === "paid" ||
    order.status === "paid" ||
    order.status === "claimed"
  );
}

// The dead-simple buyer flow has these visible phases. This is a pure mapping of
// (order, payment, downloadUrl) -> phase so the receive UI stays declarative and
// the transitions can be unit-tested without React. "detected" is the 0-conf
// "we saw your payment, confirming" state that sits BETWEEN awaiting-payment and
// the confirmed paid (in-transit) state — it is NOT paid and never claimable.
export type BuyerFlowPhase =
  | "loading"
  | "awaiting-payment"
  | "detected"
  | "in-transit"
  | "done";

export function getBuyerFlowPhase(input: {
  order: BuyerOrderStatusView | null | undefined;
  payment: Pick<TransferPayment, "paymentAddress"> | null | undefined;
  downloadUrl: string;
}): BuyerFlowPhase {
  if (input.downloadUrl) {
    return "done";
  }
  if (isOrderPaid(input.order)) {
    return "in-transit";
  }
  // 0-conf: the scanner saw the payment in the mempool but it is not confirmed
  // yet. Show "Payment detected / confirming" instead of plain "awaiting".
  if (isPaymentDetected(input.order)) {
    return "detected";
  }
  // The QR can only render once a payment address exists; until then the buyer
  // sees a brief "preparing" state (the auto-create payment-intent is in flight).
  if (input.payment?.paymentAddress) {
    return "awaiting-payment";
  }
  return "loading";
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

// Seller status stepper: a 5-stage view of an order's delivery so the seller can
// SEE where it is (the owner reported no visibility). Stage 5 ("Delivered to
// buyer") only lights up on the buyer's pure-Nym ack (nymSession.status ===
// "delivered") — that is the honest terminal, replacing the old "Delivered" that
// only meant "sent". Reuses the .zectime-flow-strip dark-theme visual.
export type SellerStatusStageId =
  | "awaiting-payment"
  | "paid"
  | "released"
  | "sent"
  | "delivered";

// Pure mapping of an order's delivery state -> active stage index (0..4). Kept
// React-free for unit testing.
export function getSellerStatusStageIndex(input: {
  status: TransferPublicOrder["status"];
  payment: { status: TransferPayment["status"] } | null;
  release?: { status: "seller_pending" | "ready" } | null;
  nymSession?: { status: string } | null;
}): number {
  const nymStatus = input.nymSession?.status;
  if (nymStatus === "delivered") {
    return 4; // delivered to buyer (buyer ACKed over the status-only flag)
  }
  const released = input.release?.status === "ready";
  if (released) {
    // Once released, the seller browser sends over Nym (nymSession "queued"). The
    // re-send loop keeps firing until the buyer ACKs, so we sit on "sent" (3) —
    // not a terminal — until nymSession flips to "delivered" above.
    return 3;
  }
  if (isOrderPaid({ status: input.status, payment: input.payment ?? null })) {
    return 1; // paid, key not yet released
  }
  return 0; // awaiting payment
}

function SellerStatusStepper({
  copy,
  order,
}: {
  copy: PaidPrivateFileCopy;
  order: TransferPublicOrder;
}) {
  const activeIndex = getSellerStatusStageIndex({
    status: order.status,
    payment: order.payment,
    release: order.release,
    nymSession: order.delivery.nymSession,
  });
  const steps: Array<{ id: SellerStatusStageId; label: string }> = [
    { id: "awaiting-payment", label: copy.sellerStatus.stepAwaitingPayment },
    { id: "paid", label: copy.sellerStatus.stepPaid },
    { id: "released", label: copy.sellerStatus.stepReleased },
    { id: "sent", label: copy.sellerStatus.stepSent },
    { id: "delivered", label: copy.sellerStatus.stepDelivered },
  ];
  const delivered = order.delivery.nymSession?.status === "delivered";

  return (
    <div className="ppf-status-stepper" data-role="seller">
      <p className="eyebrow">{copy.sellerStatus.title}</p>
      <ol
        className="zectime-flow-strip"
        data-stage={steps[activeIndex].id}
        aria-label={copy.sellerStatus.title}
      >
        {steps.map((step, index) => {
          const state =
            index < activeIndex
              ? "done"
              : index === activeIndex
                ? "active"
                : "pending";
          return (
            <li key={step.id} data-state={state}>
              <span className="zectime-flow-dot" aria-hidden="true" />
              <span>
                {step.label}
                {step.id === "delivered" && delivered ? " ✓" : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
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
    // Latency-based gateway selection (SDK probes candidates, picks lowest-latency)
    // is DISABLED by default: enabling it coincided with a stuck transfer in prod
    // (buyer "Connected to Nym" but ENVELOPES 0 — the seller's packets never
    // landed, a new gateway/address that broke the seller↔buyer handshake). Needs
    // investigation of the gateway-rotation + address-registration interaction
    // before re-enabling. Opt in with NEXT_PUBLIC_NYM_LATENCY_SELECTION="1".
    latencyBasedSelection:
      process.env.NEXT_PUBLIC_NYM_LATENCY_SELECTION === "1",
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

// Multi-buyer "product" model (Phase 3a): when on, the seller's create form
// publishes a PRODUCT (one catalog entry many buyers can purchase) instead of a
// single-use file, and the dashboard lists those products. Default OFF (prod
// default) — with the flag off the create + dashboard behave byte-for-byte like
// today's single-use flow. Mirrors browserNymFileTransferEnabled's read style.
function productsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_PPF_PRODUCTS === "1";
}

// Browser-to-browser FILE transfer over Nym: when on, the seller streams the
// encrypted FILE bytes over the mixnet too (not just the key), and the buyer
// reassembles + decrypts them in-browser. HTTPS stays as the automatic fallback.
// Defaults ON when browser-direct Nym key delivery is enabled (the file path is
// the natural extension), unless explicitly disabled. Set to "0" to force the
// key-over-Nym + file-over-HTTPS behavior.
function browserNymFileTransferEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_PPF_BROWSER_NYM_FILE === "0") {
    return false;
  }
  return (
    process.env.NEXT_PUBLIC_PPF_BROWSER_NYM_FILE === "1" ||
    browserNymDeliveryEnabled()
  );
}

// Master switch for the HTTPS file fallback. OFF for now: the file is delivered
// 100% over the Nym mixnet so the buyer's IP is never exposed to the server
// (HTTPS would reveal who downloaded what, when — the file stays encrypted, but
// the network metadata leaks). A large/slow transfer is allowed to finish in its
// own time. When re-enabled it should be LAST-RESORT and behind explicit buyer
// consent (a clear notice that their IP becomes visible), never silent.
const BROWSER_NYM_HTTPS_FALLBACK_ENABLED = false;

// Overall receive bound when the HTTPS fallback is OFF: generous enough that even
// a slow large transfer (e.g. ~50 MB at a congested ~5 KiB/s ≈ 2.7 h) finishes on
// Nym rather than being aborted. Not a fallback trigger — just a sanity ceiling.
const NYM_RECEIVE_NO_FALLBACK_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 h

// No-PROGRESS stall window used ONLY when the HTTPS fallback is enabled: the buyer
// abandons the Nym transfer for the HTTPS fetch after this long with zero forward
// progress. Re-armed on every chunk (armBuyerHttpsFallback), so a healthy slow
// transfer never trips it — only a genuine stall does. Inert while the fallback
// is off (armBuyerHttpsFallback early-returns).
const BROWSER_NYM_FILE_FALLBACK_MS = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Nym addresses are long (gateway-suffixed). Show a compact head…tail so the
// buyer can sanity-check their receiver address without it dominating the UI.
export function shortNymAddress(value: string): string {
  const cleaned = value.trim();
  if (cleaned.length <= 24) {
    return cleaned;
  }
  return `${cleaned.slice(0, 12)}…${cleaned.slice(-8)}`;
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

// Programmatic download: create a temporary <a download={fileName} href={url}>,
// append it to the document body, click it, then remove it. This saves the file
// WITHOUT the buyer clicking. Best-effort and wrapped in try/catch — Safari can
// block a programmatic click, in which case the visible "Save file" button (a
// single user click) is the fallback, so a failure here must never throw.
// Exported for unit testing the anchor wiring (download attr + click + cleanup).
export function triggerBrowserDownload(url: string, fileName: string): void {
  if (typeof document === "undefined") {
    return;
  }
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } catch {
    // Programmatic download blocked: the buyer uses the "Save file" button.
  }
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

// Compact, mostly-numeric one-line readout for a completed Nym transfer, e.g.
// "1.0 MB · 21s · 48 KiB/s · first chunk 2.1s · 0 retransmits". Pure: takes the
// metrics computed by the transfer layer and formats them for the diagnostic
// surfaces. Does not affect the transfer.
function formatTransferMetrics(metrics: TransferMetrics): string {
  const size = formatBytes(metrics.bytes);
  const seconds = `${(metrics.durationMs / 1000).toFixed(1)}s`;
  const throughput = `${metrics.throughputKiBs.toFixed(1)} KiB/s`;
  const firstChunk =
    metrics.timeToFirstChunkMs === null
      ? "first chunk —"
      : `first chunk ${(metrics.timeToFirstChunkMs / 1000).toFixed(1)}s`;
  const retransmits = `${metrics.retransmits} retransmit${
    metrics.retransmits === 1 ? "" : "s"
  }`;
  return `${size} · ${seconds} · ${throughput} · ${firstChunk} · ${retransmits}`;
}

// Single structured console line per completed transfer, prefixed PPF-PERF, so
// the team can collect numbers across runs from the browser console. This is the
// PRIMARY data-collection channel for the throughput audit. Intentionally uses
// console.info (a dev/diagnostic surface) rather than a logger.
function logTransferMetrics(metrics: TransferMetrics): void {
  // eslint-disable-next-line no-console
  console.info(
    "PPF-PERF",
    JSON.stringify({
      side: metrics.side,
      bytes: metrics.bytes,
      durationMs: metrics.durationMs,
      throughputKiBs: Number(metrics.throughputKiBs.toFixed(2)),
      timeToFirstChunkMs: metrics.timeToFirstChunkMs,
      chunks: metrics.chunks,
      retransmits: metrics.retransmits,
      chunksResent: metrics.chunksResent,
    }),
  );
}
