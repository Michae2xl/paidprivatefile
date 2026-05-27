import { createServerErrorResponse } from "../../../../../lib/server/error-kinds";
import { enforceRateLimit } from "../../../../../lib/server/rate-limit";
import { readEncryptedTransferFile } from "../../../../../lib/server/transfer-store";

const RATE_LIMIT = { maxRequests: 20, windowMs: 60_000 };

interface RouteContext {
  params: Promise<{ orderId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const throttled = enforceRateLimit(request, "transfers/file", RATE_LIMIT);
  if (throttled) return throttled;

  try {
    const { orderId } = await context.params;
    const url = new URL(request.url);
    const token = url.searchParams.get("token") ?? "";
    const { order, bytes } = await readEncryptedTransferFile(orderId, token);
    const fileName = `${order.file.fileName}.zectime.enc`;

    return new Response(copyToArrayBuffer(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${escapeHeaderValue(
          fileName,
        )}"`,
      },
    });
  } catch (error) {
    return createServerErrorResponse("transfers/file", error);
  }
}

function escapeHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/gu, "_");
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
