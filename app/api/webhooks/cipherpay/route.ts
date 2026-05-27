import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { parseCipherPayWebhook } from "../../../../lib/server/cipherpay-client";
import {
  createServerErrorResponse,
  ServerError,
} from "../../../../lib/server/error-kinds";
import { readLimitedText } from "../../../../lib/server/request-body";
import { markTransferPaidFromInvoice } from "../../../../lib/server/transfer-store";

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request) {
  try {
    const rawBody = await readLimitedText(request, MAX_BODY_BYTES);
    validateWebhookSignature(request, rawBody);

    const parsed = JSON.parse(rawBody) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new ServerError("validation", "CipherPay webhook must be an object");
    }

    const event = parseCipherPayWebhook(parsed as Record<string, unknown>);
    if (!event.isPaid) {
      return NextResponse.json({ ok: true, ignored: true });
    }

    const order = await markTransferPaidFromInvoice({
      invoiceId: event.invoiceId,
      orderId: event.orderId,
      raw: event.raw,
    });
    return NextResponse.json({ ok: true, order });
  } catch (error) {
    return createServerErrorResponse("webhooks/cipherpay", error);
  }
}

function validateWebhookSignature(request: Request, body: string): void {
  const secret = process.env.CIPHERPAY_WEBHOOK_SECRET;
  if (!secret) {
    return;
  }

  const provided =
    request.headers.get("x-cipherpay-signature") ??
    request.headers.get("cipherpay-signature") ??
    "";
  const normalized = provided.replace(/^sha256=/iu, "").trim();
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  if (!safeEqual(normalized, expected)) {
    throw new ServerError("validation", "Invalid CipherPay webhook signature");
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
