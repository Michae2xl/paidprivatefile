import { randomUUID } from "node:crypto";

import { ServerError } from "./error-kinds";

export type CipherPayProvider = "cipherpay" | "dev";

export interface CreateCipherPayInvoiceInput {
  orderId: string;
  amountZats: number;
  sellerPayoutAddress: string;
  buyerPublicKeyHash: string;
  manifestRoot: string;
  successUrl?: string;
}

export interface CipherPayInvoice {
  provider: CipherPayProvider;
  invoiceId: string;
  checkoutUrl: string | null;
  paymentAddress: string | null;
  memo: string | null;
  status: "pending" | "paid";
  raw?: unknown;
}

export interface CipherPayWebhookEvent {
  invoiceId: string | null;
  orderId: string | null;
  status: string | null;
  isPaid: boolean;
  raw: Record<string, unknown>;
}

const PAID_STATUSES = new Set([
  "paid",
  "confirmed",
  "settled",
  "complete",
  "completed",
  "invoice.paid",
  "invoice.confirmed",
  "payment.paid",
  "payment.confirmed",
]);

export async function createCipherPayInvoice(
  input: CreateCipherPayInvoiceInput,
): Promise<CipherPayInvoice> {
  const apiUrl = process.env.CIPHERPAY_API_URL?.replace(/\/+$/u, "");
  const apiKey = process.env.CIPHERPAY_API_KEY;

  if (!apiUrl || !apiKey) {
    return createDevInvoice(input);
  }

  const createPath = process.env.CIPHERPAY_CREATE_INVOICE_PATH ?? "/invoices";
  const payload: Record<string, unknown> = {
    amount: input.amountZats / 100_000_000,
    amount_zats: input.amountZats,
    currency: "ZEC",
    reference: input.orderId,
    success_url: input.successUrl,
    address: input.sellerPayoutAddress,
    recipient_address: input.sellerPayoutAddress,
    metadata: {
      orderId: input.orderId,
      sellerPayoutAddress: input.sellerPayoutAddress,
      buyerPublicKeyHash: input.buyerPublicKeyHash,
      manifestRoot: input.manifestRoot,
    },
  };

  const response = await fetch(`${apiUrl}${createPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = (await readJsonOrText(response)) as unknown;
  if (!response.ok) {
    throw new ServerError(
      "cli_unavailable",
      `CipherPay invoice creation failed with HTTP ${response.status}`,
      { provider: "cipherpay" },
    );
  }

  if (!isRecord(raw)) {
    throw new ServerError("validation", "CipherPay returned an invalid invoice");
  }

  const invoiceId = pickString(raw, [
    "id",
    "invoice_id",
    "invoiceId",
    "data.id",
    "data.invoice_id",
    "invoice.id",
  ]);

  if (!invoiceId) {
    throw new ServerError(
      "validation",
      "CipherPay invoice response did not include an invoice id",
    );
  }

  return {
    provider: "cipherpay",
    invoiceId,
    checkoutUrl: pickString(raw, [
      "checkout_url",
      "checkoutUrl",
      "hosted_url",
      "payment_url",
      "url",
      "data.checkout_url",
      "data.checkoutUrl",
      "invoice.checkout_url",
    ]),
    paymentAddress: pickString(raw, [
      "payment_address",
      "paymentAddress",
      "address",
      "data.payment_address",
      "data.address",
      "invoice.payment_address",
    ]),
    memo: pickString(raw, ["memo", "data.memo", "invoice.memo"]),
    status: "pending",
    raw,
  };
}

export function parseCipherPayWebhook(
  payload: Record<string, unknown>,
): CipherPayWebhookEvent {
  const status = pickString(payload, [
    "status",
    "event",
    "type",
    "data.status",
    "data.event",
    "payment.status",
    "invoice.status",
  ]);
  const normalizedStatus = status?.trim().toLowerCase() ?? null;

  return {
    invoiceId: pickString(payload, [
      "invoice_id",
      "invoiceId",
      "id",
      "data.invoice_id",
      "data.invoiceId",
      "data.id",
      "invoice.id",
      "payment.invoice_id",
    ]),
    orderId: pickString(payload, [
      "reference",
      "external_id",
      "metadata.orderId",
      "metadata.order_id",
      "data.reference",
      "data.external_id",
      "data.metadata.orderId",
      "data.metadata.order_id",
      "invoice.metadata.orderId",
    ]),
    status: normalizedStatus,
    isPaid: normalizedStatus ? PAID_STATUSES.has(normalizedStatus) : false,
    raw: payload,
  };
}

function createDevInvoice(input: CreateCipherPayInvoiceInput): CipherPayInvoice {
  return {
    provider: "dev",
    invoiceId: `dev_${input.orderId}_${randomUUID().replaceAll("-", "")}`,
    checkoutUrl: null,
    paymentAddress: input.sellerPayoutAddress,
    memo: `zectime-paid-link:${input.orderId}`,
    status: "pending",
    raw: {
      mode: "dev",
      amount_zats: input.amountZats,
      reference: input.orderId,
      seller_payout_address: input.sellerPayoutAddress,
    },
  };
}

async function readJsonOrText(response: Response): Promise<unknown> {
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

function pickString(
  source: Record<string, unknown>,
  paths: readonly string[],
): string | null {
  for (const path of paths) {
    const value = getPath(source, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function getPath(source: Record<string, unknown>, path: string): unknown {
  let value: unknown = source;
  for (const key of path.split(".")) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
