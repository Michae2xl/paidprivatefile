import { ServerError } from "./error-kinds";

const TEXT_DECODER = new TextDecoder();

export async function readLimitedJsonObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const raw = await readLimitedText(request, maxBytes);
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ServerError("validation", "Request body must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ServerError("validation", "Expected JSON object");
  }

  return parsed as Record<string, unknown>;
}

export async function readLimitedText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      throw new ServerError("validation", "Invalid Content-Length header");
    }
    if (parsedLength > maxBytes) {
      throw new ServerError(
        "validation",
        `Request body too large; max ${maxBytes} bytes`,
      );
    }
  }

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        throw new ServerError(
          "validation",
          `Request body too large; max ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) {
    return "";
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return TEXT_DECODER.decode(body);
}
