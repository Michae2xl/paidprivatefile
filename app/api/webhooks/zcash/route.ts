import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
} from "../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../lib/server/rate-limit";
import { readLimitedText } from "../../../../lib/server/request-body";
import {
  findOrderIdForDeposit,
  getTransferPublicOrder,
  markTransferPaidOnchain,
} from "../../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 60, windowMs: 60_000 };
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_MIN_CONFIRMATIONS = 10;
const TXID_PATTERN = /^[0-9a-f]{64}$/u;

interface ZcashDepositReport {
  receivingAddress: string;
  amountZats: number;
  txid: string;
  confirmations: number;
}

export async function POST(request: Request) {
  const throttled = enforceRateLimit(request, "webhooks/zcash", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const rawBody = await readLimitedText(request, MAX_BODY_BYTES);
    verifyWebhookSignature(request, rawBody);

    const report = parseDepositReport(rawBody);

    const orderId = await findOrderIdForDeposit(report.receivingAddress);
    if (!orderId) {
      throw new ServerError(
        "validation",
        "Deposit address did not map to an order",
      );
    }

    const order = await getTransferPublicOrder(orderId);
    if (
      !order.payment ||
      order.payment.receivingAddress !== report.receivingAddress
    ) {
      throw new ServerError(
        "validation",
        "Deposit address did not match the order payment session",
      );
    }

    if (report.amountZats < order.price.amountZats) {
      return NextResponse.json({
        ok: true,
        ignored: true,
        reason: "underpayment",
      });
    }

    if (report.confirmations < minConfirmations()) {
      return NextResponse.json({
        ok: true,
        ignored: true,
        reason: "insufficient_confirmations",
      });
    }

    const settled = await markTransferPaidOnchain({
      orderId,
      txid: report.txid,
      amountZats: report.amountZats,
      confirmations: report.confirmations,
    });
    return NextResponse.json({ ok: true, order: settled });
  } catch (error) {
    return createServerErrorResponse("webhooks/zcash", error);
  }
}

function parseDepositReport(rawBody: string): ZcashDepositReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new ServerError("validation", "Zcash webhook must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ServerError("validation", "Zcash webhook must be an object");
  }

  const body = parsed as Record<string, unknown>;
  const receivingAddress =
    typeof body.receivingAddress === "string"
      ? body.receivingAddress.trim()
      : "";
  if (!receivingAddress) {
    throw new ServerError("validation", "receivingAddress is required");
  }

  const txid =
    typeof body.txid === "string" ? body.txid.trim().toLowerCase() : "";
  if (!TXID_PATTERN.test(txid)) {
    throw new ServerError("validation", "txid must be a 32-byte hex string");
  }

  const amountZats = body.amountZats;
  if (!Number.isSafeInteger(amountZats) || (amountZats as number) < 0) {
    throw new ServerError(
      "validation",
      "amountZats must be a non-negative integer",
    );
  }

  const confirmations = body.confirmations;
  if (!Number.isSafeInteger(confirmations) || (confirmations as number) < 0) {
    throw new ServerError(
      "validation",
      "confirmations must be a non-negative integer",
    );
  }

  return {
    receivingAddress,
    amountZats: amountZats as number,
    txid,
    confirmations: confirmations as number,
  };
}

function verifyWebhookSignature(request: Request, body: string): void {
  const secret = process.env.PAID_PRIVATE_FILE_ZCASH_WEBHOOK_SECRET;
  if (!secret) {
    throw new ServerError("validation", "Zcash webhook is not configured");
  }

  const provided = request.headers.get("x-zcash-signature") ?? "";
  const normalized = provided.replace(/^sha256=/iu, "").trim();
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  if (!safeEqual(normalized, expected)) {
    throw new ServerError("validation", "Invalid Zcash webhook signature");
  }
}

function minConfirmations(): number {
  const raw = process.env.PAID_PRIVATE_FILE_ZCASH_MIN_CONFIRMATIONS;
  if (!raw) {
    return DEFAULT_MIN_CONFIRMATIONS;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MIN_CONFIRMATIONS;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
