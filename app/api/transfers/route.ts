import { NextResponse } from "next/server";

import {
  createServerErrorResponse,
  ServerError,
  type ServerErrorEnvelope,
} from "../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../lib/server/rate-limit";
import {
  createTransferOrder,
  type TransferTimestampReceipt,
} from "../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 8, windowMs: 60_000 };
const MAX_BODY_BYTES = 54 * 1024 * 1024;

function validationResponse(message: string, status = 400): NextResponse {
  return NextResponse.json<ServerErrorEnvelope>(
    { error: { kind: "validation", message } },
    { status },
  );
}

export async function POST(request: Request) {
  const throttled = enforceRateLimit(request, "transfers/create", RATE_LIMIT);
  if (throttled) return throttled;

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return validationResponse("Transfer upload is too large", 413);
  }

  try {
    const form = await request.formData();
    const encryptedFile = form.get("encryptedFile");
    if (!(encryptedFile instanceof Blob)) {
      throw new ServerError("validation", "Missing encrypted file");
    }

    const order = await createTransferOrder({
      encryptedFile: new Uint8Array(await encryptedFile.arrayBuffer()),
      fileName: readFormString(form, "fileName") ?? "private-file",
      mimeType:
        readFormString(form, "mimeType") ??
        encryptedFile.type ??
        "application/octet-stream",
      originalSizeBytes: readFormNumber(form, "originalSizeBytes"),
      encryptedFileSha256: requireFormString(form, "encryptedFileSha256"),
      encryptionIv: requireFormString(form, "encryptionIv"),
      fileKey: requireFormString(form, "fileKey"),
      amountZats: readFormNumber(form, "amountZats"),
      sellerPayoutAddress: requireFormString(form, "sellerPayoutAddress"),
      sellerNote: readFormString(form, "sellerNote"),
      timestampReceipt: readTimestampReceipt(form),
    });

    return NextResponse.json({
      order,
      sharePath: `/paid-private-file?order=${encodeURIComponent(
        order.orderId,
      )}`,
    });
  } catch (error) {
    return createServerErrorResponse("transfers/create", error);
  }
}

function requireFormString(form: FormData, name: string): string {
  const value = readFormString(form, name);
  if (!value) {
    throw new ServerError("validation", `Missing required field: ${name}`);
  }
  return value;
}

function readFormString(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function readFormNumber(form: FormData, name: string): number {
  const raw = requireFormString(form, name);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new ServerError("validation", `Invalid numeric field: ${name}`);
  }
  return parsed;
}

function readTimestampReceipt(form: FormData): TransferTimestampReceipt | null {
  const raw = readFormString(form, "timestampReceiptJson");
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as TransferTimestampReceipt;
    }
  } catch {
    throw new ServerError("validation", "timestampReceiptJson must be valid JSON");
  }
  throw new ServerError("validation", "timestampReceiptJson must be an object");
}
