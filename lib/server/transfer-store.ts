import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import {
  createCipherPayInvoice,
  type CipherPayInvoice,
  type CipherPayProvider,
} from "./cipherpay-client";
import { ServerError } from "./error-kinds";
import {
  queueNymDelivery,
  type NymDeliveryReceipt,
  type NymTransportMode,
} from "./nym-transport";
import { resolveWebRuntimeRoot } from "./web-session";

export type TransferStatus = "created" | "payment_pending" | "paid" | "claimed";

export interface TransferPaymentState {
  provider: CipherPayProvider;
  invoiceId: string;
  checkoutUrl: string | null;
  paymentAddress: string | null;
  memo: string | null;
  status: "pending" | "paid";
  buyerPublicKeyHash: string;
  buyerPublicKeyJwk: JsonWebKey;
  createdAt: string;
  confirmedAt: string | null;
  raw?: unknown;
}

export interface TransferNymSession {
  transport: NymTransportMode;
  buyerNymAddress: string;
  buyerPublicKeyHash: string;
  status: "waiting_for_payment" | "ready_for_delivery" | "queued";
  createdAt: string;
  updatedAt: string;
  lastDelivery?: NymDeliveryReceipt;
}

export interface TransferDeliveryState {
  requiredTransport: NymTransportMode;
  fallbackHttpDownload: false;
  nymSession: TransferNymSession | null;
}

export interface TransferReleaseState {
  mode: "seller-held";
  releaseSecretHash: string | null;
  keyEnvelope: TransferKeyEnvelope | null;
  buyerPublicKeyHash: string | null;
  releasedAt: string | null;
}

export interface TransferOrder {
  schema: "zectime.paid-link.order.v1";
  orderId: string;
  status: TransferStatus;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  mimeType: string;
  originalSizeBytes: number;
  encryptedSizeBytes: number;
  encryptedFileSha256: string;
  encryption: {
    scheme: "aes-256-gcm-v1";
    iv: string;
  };
  price: {
    asset: "ZEC";
    amountZats: number;
    displayZec: string;
  };
  sellerPayoutAddress: string;
  sellerNote: string | null;
  seller: TransferSeller | null;
  timestampReceipt: TransferTimestampReceipt | null;
  manifestRoot: string;
  payment: TransferPaymentState | null;
  delivery: TransferDeliveryState;
  release: TransferReleaseState;
  claims: Array<{
    claimedAt: string;
    buyerPublicKeyHash: string;
    tokenExpiresAt: string;
  }>;
}

export interface TransferTimestampReceipt {
  commitment_scheme?: string;
  commitment: string;
  block_height: number;
  nonce: string;
  doc_hash_lo: string;
  doc_hash_hi: string;
  doc_hash_sha256?: string;
}

export interface TransferPublicOrder {
  orderId: string;
  status: TransferStatus;
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
  price: TransferOrder["price"];
  sellerPayoutAddress: string;
  sellerNote: string | null;
  seller: TransferSeller | null;
  timestamp: {
    commitmentScheme: string | null;
    commitment: string;
    blockHeight: number;
  } | null;
  manifestRoot: string;
  payment: Omit<
    TransferPaymentState,
    "buyerPublicKeyHash" | "buyerPublicKeyJwk" | "raw"
  > | null;
  delivery: Omit<TransferDeliveryState, "nymSession"> & {
    nymSession: Omit<TransferNymSession, "buyerPublicKeyHash"> | null;
  };
  release: {
    mode: TransferReleaseState["mode"];
    status: "seller_pending" | "ready";
    releasedAt: string | null;
  };
}

export interface CreateTransferOrderInput {
  encryptedFile: Uint8Array;
  fileName: string;
  mimeType: string;
  originalSizeBytes: number;
  encryptedFileSha256: string;
  encryptionIv: string;
  releaseSecretHash: string;
  amountZats: number;
  sellerPayoutAddress: string;
  sellerNote?: string | null;
  seller?: TransferSeller | null;
  timestampReceipt?: TransferTimestampReceipt | null;
}

export interface TransferSeller {
  sellerId: string;
  handle: string;
  displayName: string;
}

export interface TransferClaim {
  order: TransferPublicOrder;
  manifest: TransferManifest;
  deliveryMode: "http-dev-fallback" | "nym";
  keyEnvelope?: TransferKeyEnvelope;
  download?: {
    token: string;
    url: string;
    expiresAt: string;
  };
  nymDelivery: NymDeliveryReceipt;
}

export interface TransferManifest {
  schema: "zectime.paid-link.manifest.v1";
  orderId: string;
  fileName: string;
  mimeType: string;
  originalSizeBytes: number;
  encryptedSizeBytes: number;
  encryptedFileSha256: string;
  encryptionScheme: "aes-256-gcm-v1";
  encryptionIv: string;
  price: TransferOrder["price"];
  sellerPayoutAddress: string;
  sellerNote: string | null;
  timestampReceipt: TransferTimestampReceipt | null;
  manifestRoot: string;
}

export interface TransferKeyEnvelope {
  scheme: "p256-ecdh-aes-gcm-v1";
  ephemeralPublicKeyJwk: JsonWebKey;
  iv: string;
  ciphertext: string;
}

export interface TransferReleaseChallenge {
  order: TransferPublicOrder;
  release: {
    status:
      | "waiting_for_payment"
      | "waiting_for_buyer"
      | "ready_to_release"
      | "released";
    buyerPublicKeyHash: string | null;
    buyerPublicKeyJwk: JsonWebKey | null;
    releasedAt: string | null;
  };
}

const ORDER_ID_PATTERN = /^pl_[a-f0-9]{24}$/u;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TOKEN_TTL_MS = 10 * 60 * 1000;
const locks = new Map<string, Promise<void>>();

export async function createTransferOrder(
  input: CreateTransferOrderInput,
): Promise<TransferPublicOrder> {
  validateCreateTransferInput(input);

  const orderId = createOrderId();
  const createdAt = new Date().toISOString();
  const fileName = normalizeFileName(input.fileName);
  const mimeType = normalizeMimeType(input.mimeType);
  const sellerPayoutAddress = normalizeZcashUnifiedAddress(
    input.sellerPayoutAddress,
  );
  const timestampReceipt = normalizeTimestampReceipt(input.timestampReceipt);
  const encryptedFileSha256 = sha256Hex(input.encryptedFile);
  if (encryptedFileSha256 !== input.encryptedFileSha256.toLowerCase()) {
    throw new ServerError(
      "validation",
      "Encrypted file digest did not match the uploaded payload",
    );
  }

  const manifestRoot = sha256Json({
    orderId,
    fileName,
    mimeType,
    originalSizeBytes: input.originalSizeBytes,
    encryptedSizeBytes: input.encryptedFile.byteLength,
    encryptedFileSha256,
    encryptionScheme: "aes-256-gcm-v1",
    encryptionIv: input.encryptionIv,
    timestampCommitment: timestampReceipt?.commitment ?? null,
    sellerPayoutAddress,
    amountZats: input.amountZats,
  });

  const order: TransferOrder = {
    schema: "zectime.paid-link.order.v1",
    orderId,
    status: "created",
    createdAt,
    updatedAt: createdAt,
    fileName,
    mimeType,
    originalSizeBytes: input.originalSizeBytes,
    encryptedSizeBytes: input.encryptedFile.byteLength,
    encryptedFileSha256,
    encryption: {
      scheme: "aes-256-gcm-v1",
      iv: input.encryptionIv,
    },
    price: {
      asset: "ZEC",
      amountZats: input.amountZats,
      displayZec: formatZec(input.amountZats),
    },
    sellerPayoutAddress,
    sellerNote: normalizeSellerNote(input.sellerNote),
    seller: normalizeSeller(input.seller),
    timestampReceipt,
    manifestRoot,
    payment: null,
    delivery: {
      requiredTransport: "nym-claim-v1",
      fallbackHttpDownload: false,
      nymSession: null,
    },
    release: {
      mode: "seller-held",
      releaseSecretHash: normalizeHex(
        input.releaseSecretHash,
        64,
        "seller release secret hash",
      ),
      keyEnvelope: null,
      buyerPublicKeyHash: null,
      releasedAt: null,
    },
    claims: [],
  };

  const dir = orderDir(orderId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(encryptedFilePath(orderId), input.encryptedFile, {
    mode: 0o600,
  });
  await writeOrder(order);

  return publicOrder(order);
}

export async function getTransferPublicOrder(
  orderId: string,
): Promise<TransferPublicOrder> {
  return publicOrder(await readOrder(orderId));
}

export async function listSellerTransferPublicOrders(
  sellerHandle: string,
): Promise<TransferPublicOrder[]> {
  const ordersRoot = join(transferRoot(), "orders");
  let entries: string[];
  try {
    entries = await readdir(ordersRoot);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const orders = await Promise.all(
    entries
      .filter((entry) => ORDER_ID_PATTERN.test(entry))
      .map(async (orderId) => {
        try {
          return await readOrder(orderId);
        } catch (error) {
          if (isMissingFileError(error)) {
            return null;
          }
          throw error;
        }
      }),
  );

  return orders
    .filter((order): order is TransferOrder => {
      return order?.seller?.handle === sellerHandle;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(publicOrder);
}

export async function createPaymentIntentForOrder(
  orderId: string,
  buyerPublicKeyJwk: JsonWebKey,
  successUrl?: string,
): Promise<{ order: TransferPublicOrder; payment: CipherPayInvoice }> {
  validateBuyerPublicKeyJwk(buyerPublicKeyJwk);
  const buyerPublicKeyHash = hashBuyerPublicKey(buyerPublicKeyJwk);

  return withOrderLock(orderId, async () => {
    const order = await readOrder(orderId);
    if (order.payment) {
      if (order.payment.buyerPublicKeyHash !== buyerPublicKeyHash) {
        throw new ServerError(
          "flow_conflict",
          "This paid link already has a payment session for another buyer key",
        );
      }

      return {
        order: publicOrder(order),
        payment: {
          provider: order.payment.provider,
          invoiceId: order.payment.invoiceId,
          checkoutUrl: order.payment.checkoutUrl,
          paymentAddress: order.payment.paymentAddress,
          memo: order.payment.memo,
          status: order.payment.status,
        },
      };
    }

    const invoice = await createCipherPayInvoice({
      orderId,
      amountZats: order.price.amountZats,
      sellerPayoutAddress: order.sellerPayoutAddress,
      buyerPublicKeyHash,
      manifestRoot: order.manifestRoot,
      successUrl,
    });
    const now = new Date().toISOString();

    order.status = "payment_pending";
    order.updatedAt = now;
    order.payment = {
      provider: invoice.provider,
      invoiceId: invoice.invoiceId,
      checkoutUrl: invoice.checkoutUrl,
      paymentAddress: invoice.paymentAddress,
      memo: invoice.memo,
      status: "pending",
      buyerPublicKeyHash,
      buyerPublicKeyJwk,
      createdAt: now,
      confirmedAt: null,
      raw: invoice.raw,
    };

    await writeOrder(order);
    await writeInvoiceIndex(invoice.invoiceId, order.orderId);

    return { order: publicOrder(order), payment: invoice };
  });
}

export async function registerNymSessionForOrder(
  orderId: string,
  input: {
    buyerNymAddress: string;
    transport?: NymTransportMode;
    buyerPublicKeyJwk: JsonWebKey;
  },
): Promise<{
  order: TransferPublicOrder;
  nymSession: TransferPublicOrder["delivery"]["nymSession"];
}> {
  validateBuyerPublicKeyJwk(input.buyerPublicKeyJwk);
  const buyerPublicKeyHash = hashBuyerPublicKey(input.buyerPublicKeyJwk);
  const buyerNymAddress = normalizeNymAddress(input.buyerNymAddress);
  const transport = normalizeNymTransport(input.transport);

  return withOrderLock(orderId, async () => {
    const order = await readOrder(orderId);
    if (
      order.payment &&
      order.payment.buyerPublicKeyHash !== buyerPublicKeyHash
    ) {
      throw new ServerError(
        "flow_conflict",
        "This order already has a payment session for another buyer key",
      );
    }

    const now = new Date().toISOString();
    order.delivery = normalizeDeliveryState(order.delivery);
    order.delivery.nymSession = {
      transport,
      buyerNymAddress,
      buyerPublicKeyHash,
      status:
        order.payment?.status === "paid"
          ? "ready_for_delivery"
          : "waiting_for_payment",
      createdAt: order.delivery.nymSession?.createdAt ?? now,
      updatedAt: now,
      lastDelivery: order.delivery.nymSession?.lastDelivery,
    };
    order.updatedAt = now;
    await writeOrder(order);

    return {
      order: publicOrder(order),
      nymSession: publicOrder(order).delivery.nymSession,
    };
  });
}

export async function markTransferPaidForDev(
  orderId: string,
): Promise<TransferPublicOrder> {
  return withOrderLock(orderId, async () => {
    const order = await readOrder(orderId);
    if (order.payment?.provider !== "dev") {
      throw new ServerError(
        "validation",
        "Dev payment confirmation is only available for dev invoices",
      );
    }
    markOrderPaid(order);
    await writeOrder(order);
    return publicOrder(order);
  });
}

export async function markTransferPaidFromInvoice(input: {
  invoiceId?: string | null;
  orderId?: string | null;
  raw?: unknown;
}): Promise<TransferPublicOrder> {
  const orderId =
    input.orderId ?? (await findOrderIdByInvoice(input.invoiceId));
  if (!orderId) {
    throw new ServerError(
      "validation",
      "CipherPay webhook did not map to an order",
    );
  }

  return withOrderLock(orderId, async () => {
    const order = await readOrder(orderId);
    if (
      input.invoiceId &&
      order.payment &&
      order.payment.invoiceId !== input.invoiceId
    ) {
      throw new ServerError(
        "validation",
        "CipherPay webhook invoice did not match this order",
      );
    }

    markOrderPaid(order, input.raw);
    await writeOrder(order);
    return publicOrder(order);
  });
}

export async function getTransferReleaseChallenge(
  orderId: string,
  releaseSecret: string,
): Promise<TransferReleaseChallenge> {
  return withOrderLock(orderId, async () => {
    const order = await readOrder(orderId);
    assertReleaseSecret(order, releaseSecret);
    return releaseChallengeForOrder(order);
  });
}

export async function releaseTransferKey(input: {
  orderId: string;
  releaseSecret: string;
  keyEnvelope: TransferKeyEnvelope;
}): Promise<TransferReleaseChallenge> {
  validateKeyEnvelope(input.keyEnvelope);

  return withOrderLock(input.orderId, async () => {
    const order = await readOrder(input.orderId);
    assertReleaseSecret(order, input.releaseSecret);
    if (!order.payment || order.payment.status !== "paid") {
      throw new ServerError(
        "payment_required",
        "Payment must be confirmed before seller key release",
      );
    }

    order.release = normalizeReleaseState(order.release);
    if (order.release.keyEnvelope || order.status === "claimed") {
      throw new ServerError(
        "validation",
        "The key envelope was already released for this order and cannot be replaced",
      );
    }

    const now = new Date().toISOString();
    order.release.keyEnvelope = input.keyEnvelope;
    order.release.buyerPublicKeyHash = order.payment.buyerPublicKeyHash;
    order.release.releasedAt = now;
    order.updatedAt = now;
    await writeOrder(order);
    return releaseChallengeForOrder(order);
  });
}

export async function claimTransfer(
  orderId: string,
  buyerPublicKeyJwk: JsonWebKey,
): Promise<TransferClaim> {
  validateBuyerPublicKeyJwk(buyerPublicKeyJwk);
  const buyerPublicKeyHash = hashBuyerPublicKey(buyerPublicKeyJwk);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DOWNLOAD_TOKEN_TTL_MS);

  return withOrderLock(orderId, async () => {
    const order = await readOrder(orderId);
    if (order.status !== "paid" && order.status !== "claimed") {
      throw new ServerError(
        "payment_required",
        "Payment must be confirmed before the file key is released",
      );
    }
    if (
      !order.payment ||
      order.payment.buyerPublicKeyHash !== buyerPublicKeyHash
    ) {
      throw new ServerError(
        "payment_required",
        "This buyer key is not bound to the confirmed payment",
      );
    }
    order.delivery = normalizeDeliveryState(order.delivery);
    if (
      !order.delivery.nymSession ||
      order.delivery.nymSession.buyerPublicKeyHash !== buyerPublicKeyHash
    ) {
      throw new ServerError(
        "payment_required",
        "A Nym delivery session must be registered before the file key is released",
      );
    }

    order.release = normalizeReleaseState(order.release);
    const keyEnvelope = claimKeyEnvelope(order);
    const token = signDownloadToken({
      orderId,
      expiresAtMs: expiresAt.getTime(),
    });
    const encryptedFileDownload = {
      url: `/api/transfers/${orderId}/file?token=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
    };
    const nymDelivery = await queueNymDelivery({
      orderId,
      buyerNymAddress: order.delivery.nymSession.buyerNymAddress,
      transport: order.delivery.nymSession.transport,
      payload: {
        schema: "paidprivatefile.nym.claim.v1",
        orderId,
        manifest: manifestForOrder(order),
        keyEnvelope,
        encryptedFileDownload,
        devHttpFallback: encryptedFileDownload,
      },
    });
    order.status = "claimed";
    order.updatedAt = now.toISOString();
    order.delivery.nymSession.status = "queued";
    order.delivery.nymSession.updatedAt = now.toISOString();
    order.delivery.nymSession.lastDelivery = nymDelivery;
    order.claims.push({
      claimedAt: now.toISOString(),
      buyerPublicKeyHash,
      tokenExpiresAt: expiresAt.toISOString(),
    });
    await writeOrder(order);

    const response: TransferClaim = {
      order: publicOrder(order),
      manifest: manifestForOrder(order),
      deliveryMode: requireNymDeliveryForClaim() ? "nym" : "http-dev-fallback",
      nymDelivery,
    };
    if (response.deliveryMode === "http-dev-fallback") {
      response.keyEnvelope = keyEnvelope;
      response.download = {
        token,
        ...encryptedFileDownload,
      };
    }
    return response;
  });
}

export async function readEncryptedTransferFile(
  orderId: string,
  token: string,
): Promise<{ order: TransferPublicOrder; bytes: Uint8Array }> {
  const payload = verifyDownloadToken(token);
  if (payload.orderId !== orderId) {
    throw new ServerError("validation", "Download token does not match order");
  }

  const order = await readOrder(orderId);
  const bytes = new Uint8Array(await readFile(encryptedFilePath(orderId)));
  return { order: publicOrder(order), bytes };
}

function markOrderPaid(order: TransferOrder, raw?: unknown): void {
  const now = new Date().toISOString();
  if (!order.payment) {
    throw new ServerError(
      "validation",
      "Order does not have a payment session yet",
    );
  }
  order.status = order.status === "claimed" ? "claimed" : "paid";
  order.updatedAt = now;
  order.payment.status = "paid";
  order.payment.confirmedAt = order.payment.confirmedAt ?? now;
  order.delivery = normalizeDeliveryState(order.delivery);
  if (order.delivery.nymSession) {
    order.delivery.nymSession.status = "ready_for_delivery";
    order.delivery.nymSession.updatedAt = now;
  }
  if (raw !== undefined) {
    order.payment.raw = raw;
  }
}

function publicOrder(order: TransferOrder): TransferPublicOrder {
  const delivery = normalizeDeliveryState(order.delivery);
  const release = normalizeReleaseState(order.release);
  return {
    orderId: order.orderId,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    file: {
      fileName: order.fileName,
      mimeType: order.mimeType,
      originalSizeBytes: order.originalSizeBytes,
      encryptedSizeBytes: order.encryptedSizeBytes,
      encryptedFileSha256: order.encryptedFileSha256,
      encryptionScheme: order.encryption.scheme,
      encryptionIv: order.encryption.iv,
    },
    price: order.price,
    sellerPayoutAddress: order.sellerPayoutAddress,
    sellerNote: order.sellerNote,
    seller: order.seller,
    timestamp: order.timestampReceipt
      ? {
          commitmentScheme: order.timestampReceipt.commitment_scheme ?? null,
          commitment: order.timestampReceipt.commitment,
          blockHeight: order.timestampReceipt.block_height,
        }
      : null,
    manifestRoot: order.manifestRoot,
    payment: order.payment
      ? {
          provider: order.payment.provider,
          invoiceId: order.payment.invoiceId,
          checkoutUrl: order.payment.checkoutUrl,
          paymentAddress: order.payment.paymentAddress,
          memo: order.payment.memo,
          status: order.payment.status,
          createdAt: order.payment.createdAt,
          confirmedAt: order.payment.confirmedAt,
        }
      : null,
    delivery: {
      requiredTransport: delivery.requiredTransport,
      fallbackHttpDownload: delivery.fallbackHttpDownload,
      nymSession: delivery.nymSession
        ? {
            transport: delivery.nymSession.transport,
            buyerNymAddress: delivery.nymSession.buyerNymAddress,
            status: delivery.nymSession.status,
            createdAt: delivery.nymSession.createdAt,
            updatedAt: delivery.nymSession.updatedAt,
            lastDelivery: delivery.nymSession.lastDelivery,
          }
        : null,
    },
    release: {
      mode: release.mode,
      status: release.keyEnvelope ? "ready" : "seller_pending",
      releasedAt: release.releasedAt,
    },
  };
}

function manifestForOrder(order: TransferOrder): TransferManifest {
  return {
    schema: "zectime.paid-link.manifest.v1",
    orderId: order.orderId,
    fileName: order.fileName,
    mimeType: order.mimeType,
    originalSizeBytes: order.originalSizeBytes,
    encryptedSizeBytes: order.encryptedSizeBytes,
    encryptedFileSha256: order.encryptedFileSha256,
    encryptionScheme: order.encryption.scheme,
    encryptionIv: order.encryption.iv,
    price: order.price,
    sellerPayoutAddress: order.sellerPayoutAddress,
    sellerNote: order.sellerNote,
    timestampReceipt: order.timestampReceipt,
    manifestRoot: order.manifestRoot,
  };
}

function releaseChallengeForOrder(
  order: TransferOrder,
): TransferReleaseChallenge {
  const release = normalizeReleaseState(order.release);
  const hasPaidBuyer = order.payment?.status === "paid";
  const status = release.keyEnvelope
    ? "released"
    : hasPaidBuyer
      ? "ready_to_release"
      : order.payment
        ? "waiting_for_payment"
        : "waiting_for_buyer";

  return {
    order: publicOrder(order),
    release: {
      status,
      buyerPublicKeyHash: order.payment?.buyerPublicKeyHash ?? null,
      buyerPublicKeyJwk: hasPaidBuyer
        ? (order.payment?.buyerPublicKeyJwk ?? null)
        : null,
      releasedAt: release.releasedAt,
    },
  };
}

function claimKeyEnvelope(order: TransferOrder): TransferKeyEnvelope {
  const release = normalizeReleaseState(order.release);
  if (release.keyEnvelope) {
    return release.keyEnvelope;
  }
  throw new ServerError(
    "payment_required",
    "Seller key release is pending for this paid private file",
  );
}

function assertReleaseSecret(
  order: TransferOrder,
  releaseSecret: string,
): void {
  order.release = normalizeReleaseState(order.release);
  if (!order.release.releaseSecretHash) {
    throw new ServerError(
      "validation",
      "This paid private file does not support seller-held key release",
    );
  }
  const actual = hashReleaseSecret(releaseSecret);
  if (!safeEqual(actual, order.release.releaseSecretHash)) {
    throw new ServerError("validation", "Invalid seller release secret");
  }
}

function normalizeReleaseState(
  value: TransferReleaseState | undefined,
): TransferReleaseState {
  return {
    mode: "seller-held",
    releaseSecretHash:
      typeof value?.releaseSecretHash === "string"
        ? value.releaseSecretHash
        : null,
    keyEnvelope: value?.keyEnvelope ?? null,
    buyerPublicKeyHash:
      typeof value?.buyerPublicKeyHash === "string"
        ? value.buyerPublicKeyHash
        : null,
    releasedAt: typeof value?.releasedAt === "string" ? value.releasedAt : null,
  };
}

function validateKeyEnvelope(value: TransferKeyEnvelope): void {
  if (
    !value ||
    value.scheme !== "p256-ecdh-aes-gcm-v1" ||
    typeof value.iv !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.ephemeralPublicKeyJwk !== "object" ||
    value.ephemeralPublicKeyJwk === null ||
    value.ephemeralPublicKeyJwk.kty !== "EC" ||
    value.ephemeralPublicKeyJwk.crv !== "P-256"
  ) {
    throw new ServerError("validation", "Invalid key release envelope");
  }
  decodeBase64(value.iv, 12);
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  if (ciphertext.byteLength < 16 || ciphertext.byteLength > 512) {
    throw new ServerError("validation", "Invalid key release ciphertext");
  }
}

function signDownloadToken(input: {
  orderId: string;
  expiresAtMs: number;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      orderId: input.orderId,
      exp: input.expiresAtMs,
      nonce: randomBytes(12).toString("base64url"),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", downloadTokenSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifyDownloadToken(token: string): { orderId: string; exp: number } {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    throw new ServerError("validation", "Invalid download token");
  }
  const expected = createHmac("sha256", downloadTokenSecret())
    .update(payload)
    .digest("base64url");
  if (!safeEqual(signature, expected)) {
    throw new ServerError("validation", "Invalid download token");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new ServerError("validation", "Invalid download token");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("orderId" in parsed) ||
    !("exp" in parsed) ||
    typeof parsed.orderId !== "string" ||
    typeof parsed.exp !== "number"
  ) {
    throw new ServerError("validation", "Invalid download token");
  }
  if (parsed.exp < Date.now()) {
    throw new ServerError("validation", "Download token expired");
  }
  validateOrderId(parsed.orderId);
  return { orderId: parsed.orderId, exp: parsed.exp };
}

async function readOrder(orderId: string): Promise<TransferOrder> {
  validateOrderId(orderId);
  try {
    const raw = await readFile(orderPath(orderId), "utf8");
    return normalizeStoredOrder(JSON.parse(raw) as TransferOrder);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ServerError("validation", "Paid link not found");
    }
    throw error;
  }
}

function normalizeStoredOrder(order: TransferOrder): TransferOrder {
  order.delivery = normalizeDeliveryState(order.delivery);
  order.release = normalizeReleaseState(order.release);
  return order;
}

async function writeOrder(order: TransferOrder): Promise<void> {
  await mkdir(orderDir(order.orderId), { recursive: true, mode: 0o700 });
  await atomicWriteJson(orderPath(order.orderId), order);
}

async function writeInvoiceIndex(
  invoiceId: string,
  orderId: string,
): Promise<void> {
  await mkdir(invoiceIndexDir(), { recursive: true, mode: 0o700 });
  await atomicWriteJson(invoiceIndexPath(invoiceId), { orderId });
}

async function findOrderIdByInvoice(
  invoiceId: string | null | undefined,
): Promise<string | null> {
  if (!invoiceId) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      await readFile(invoiceIndexPath(invoiceId), "utf8"),
    ) as { orderId?: unknown };
    return typeof parsed.orderId === "string" ? parsed.orderId : null;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

async function withOrderLock<T>(
  orderId: string,
  callback: () => Promise<T>,
): Promise<T> {
  validateOrderId(orderId);
  const previous = locks.get(orderId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queue = previous.then(() => current);
  locks.set(orderId, queue);
  await previous;

  try {
    return await callback();
  } finally {
    releaseCurrent();
    if (locks.get(orderId) === queue) {
      locks.delete(orderId);
    }
  }
}

function validateCreateTransferInput(input: CreateTransferOrderInput): void {
  if (input.encryptedFile.byteLength < 1) {
    throw new ServerError("validation", "Encrypted file is required");
  }
  if (input.encryptedFile.byteLength > MAX_TRANSFER_BYTES) {
    throw new ServerError(
      "validation",
      `Encrypted file cannot exceed ${MAX_TRANSFER_BYTES} bytes`,
    );
  }
  if (
    !Number.isSafeInteger(input.originalSizeBytes) ||
    input.originalSizeBytes < 1
  ) {
    throw new ServerError("validation", "Original file size is invalid");
  }
  if (!Number.isSafeInteger(input.amountZats) || input.amountZats < 1) {
    throw new ServerError("validation", "Amount must be at least 1 zatoshi");
  }
  normalizeZcashUnifiedAddress(input.sellerPayoutAddress);
  if (!HEX_SHA256_PATTERN.test(input.encryptedFileSha256.toLowerCase())) {
    throw new ServerError(
      "validation",
      "Encrypted file digest must be a SHA-256 hex string",
    );
  }
  decodeBase64(input.encryptionIv, 12);
  normalizeHex(input.releaseSecretHash, 64, "seller release secret hash");
}

function normalizeDeliveryState(
  value: TransferDeliveryState | undefined,
): TransferDeliveryState {
  return {
    requiredTransport: normalizeNymTransport(value?.requiredTransport),
    fallbackHttpDownload: false,
    nymSession: value?.nymSession
      ? {
          transport: normalizeNymTransport(value.nymSession.transport),
          buyerNymAddress: normalizeNymAddress(
            value.nymSession.buyerNymAddress,
          ),
          buyerPublicKeyHash: value.nymSession.buyerPublicKeyHash,
          status: value.nymSession.status,
          createdAt: value.nymSession.createdAt,
          updatedAt: value.nymSession.updatedAt,
          lastDelivery: value.nymSession.lastDelivery,
        }
      : null,
  };
}

function normalizeNymTransport(
  value: NymTransportMode | undefined,
): NymTransportMode {
  return value === "nym-transfer-v1" ? "nym-transfer-v1" : "nym-claim-v1";
}

function normalizeNymAddress(value: string): string {
  const cleaned = value.trim();
  if (cleaned.length < 16 || cleaned.length > 512) {
    throw new ServerError("validation", "Buyer Nym address is invalid");
  }
  return cleaned;
}

function validateOrderId(orderId: string): void {
  if (!ORDER_ID_PATTERN.test(orderId)) {
    throw new ServerError("validation", "Invalid paid link id");
  }
}

function validateBuyerPublicKeyJwk(value: JsonWebKey): void {
  if (
    value.kty !== "EC" ||
    value.crv !== "P-256" ||
    typeof value.x !== "string" ||
    typeof value.y !== "string"
  ) {
    throw new ServerError("validation", "Buyer public key must be P-256 JWK");
  }
}

function createOrderId(): string {
  return `pl_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function normalizeFileName(value: string): string {
  const cleaned = basename(value || "private-file")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 160);
  return cleaned || "private-file";
}

function normalizeMimeType(value: string): string {
  const cleaned = value.trim().slice(0, 120);
  return cleaned || "application/octet-stream";
}

function normalizeZcashUnifiedAddress(value: string): string {
  const cleaned = value.trim();
  if (
    cleaned.length > 512 ||
    !/^(u1|utest|uregtest)[a-z0-9]{16,}$/iu.test(cleaned)
  ) {
    throw new ServerError(
      "validation",
      "Seller payout address must be a Zcash unified address",
    );
  }
  return cleaned;
}

function normalizeSellerNote(value: string | null | undefined): string | null {
  const cleaned = value?.trim().slice(0, 500);
  return cleaned ? cleaned : null;
}

function normalizeSeller(
  value: TransferSeller | null | undefined,
): TransferSeller | null {
  if (!value) {
    return null;
  }
  return {
    sellerId: value.sellerId,
    handle: value.handle,
    displayName: value.displayName,
  };
}

function normalizeTimestampReceipt(
  value: TransferTimestampReceipt | null | undefined,
): TransferTimestampReceipt | null {
  if (!value) {
    return null;
  }
  const commitment = normalizeHex(value.commitment, 64, "timestamp commitment");
  return {
    commitment_scheme:
      typeof value.commitment_scheme === "string"
        ? value.commitment_scheme.slice(0, 80)
        : undefined,
    commitment,
    block_height: Number.isSafeInteger(value.block_height)
      ? value.block_height
      : 0,
    nonce: normalizeHex(value.nonce, 32, "timestamp nonce"),
    doc_hash_lo: normalizeHex(value.doc_hash_lo, 32, "timestamp doc_hash_lo"),
    doc_hash_hi: normalizeHex(value.doc_hash_hi, 32, "timestamp doc_hash_hi"),
    ...(typeof value.doc_hash_sha256 === "string"
      ? {
          doc_hash_sha256: normalizeHex(
            value.doc_hash_sha256,
            64,
            "timestamp SHA-256",
          ),
        }
      : {}),
  };
}

function normalizeHex(value: string, length: number, label: string): string {
  const normalized = value.trim().replace(/^0x/iu, "").toLowerCase();
  const pattern = new RegExp(`^[0-9a-f]{${length}}$`, "u");
  if (!pattern.test(normalized)) {
    throw new ServerError("validation", `Invalid ${label}`);
  }
  return normalized;
}

function hashBuyerPublicKey(value: JsonWebKey): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function hashReleaseSecret(value: string): string {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== 32) {
    throw new ServerError("validation", "Invalid seller release secret");
  }
  return sha256Hex(bytes);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function decodeBase64(value: string, expectedLength: number): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== expectedLength) {
    throw new ServerError(
      "validation",
      `Expected base64 value with ${expectedLength} bytes`,
    );
  }
  return new Uint8Array(bytes);
}

function formatZec(amountZats: number): string {
  const whole = Math.floor(amountZats / 100_000_000);
  const fractional = String(amountZats % 100_000_000).padStart(8, "0");
  return `${whole}.${fractional}`.replace(/\.?0+$/u, "");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function downloadTokenSecret(): string {
  return (
    process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET ??
    process.env.ZECTIME_TRANSFER_TOKEN_SECRET ??
    process.env.ZKCGZ_TRANSFER_TOKEN_SECRET ??
    "paidprivatefile-dev-secret"
  );
}

function requireNymDeliveryForClaim(): boolean {
  if (process.env.PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY === "1") {
    return true;
  }
  return (
    process.env.NODE_ENV === "production" &&
    Boolean(process.env.NYM_CLIENT_ENDPOINT?.trim()) &&
    process.env.PAID_PRIVATE_FILE_ALLOW_HTTP_CLAIM_RESPONSE !== "1"
  );
}

function transferRoot(): string {
  return join(resolveWebRuntimeRoot(), "paid-transfers");
}

function orderDir(orderId: string): string {
  return join(transferRoot(), "orders", orderId);
}

function orderPath(orderId: string): string {
  return join(orderDir(orderId), "order.json");
}

function encryptedFilePath(orderId: string): string {
  return join(orderDir(orderId), "encrypted.bin");
}

function invoiceIndexDir(): string {
  return join(transferRoot(), "invoice-index");
}

function invoiceIndexPath(invoiceId: string): string {
  return join(invoiceIndexDir(), `${sha256Hex(Buffer.from(invoiceId))}.json`);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
