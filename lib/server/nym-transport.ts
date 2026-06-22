import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { ServerError } from "./error-kinds";
import { resolveWebRuntimeRoot } from "./web-session";

export type NymTransportMode = "nym-claim-v1" | "nym-transfer-v1";

export interface NymDeliveryPayload {
  orderId: string;
  buyerNymAddress: string;
  transport: NymTransportMode;
  payload: unknown;
}

export interface NymDeliveryReceipt {
  deliveryId: string;
  transport: NymTransportMode;
  status: "queued_local_outbox" | "sent_nym_client" | "delivered";
  queuedAt: string;
  nymClientEndpoint?: string;
  // Stamped by the buyer's status-only delivery ack (no key material). Lets the
  // seller honestly distinguish "sent over Nym" from "received by buyer".
  deliveredAt?: string;
}

export async function queueNymDelivery(
  input: NymDeliveryPayload,
): Promise<NymDeliveryReceipt> {
  const endpoint = normalizeNymClientEndpoint(process.env.NYM_CLIENT_ENDPOINT);
  if (endpoint) {
    return sendWithStandaloneNymClient(input, endpoint);
  }

  if (
    process.env.PAID_PRIVATE_FILE_REQUIRE_NYM_DELIVERY === "1" &&
    process.env.PAID_PRIVATE_FILE_ALLOW_LOCAL_NYM_OUTBOX !== "1"
  ) {
    throw new ServerError(
      "cli_unavailable",
      "NYM_CLIENT_ENDPOINT is required when Nym delivery is mandatory",
      { transport: input.transport },
    );
  }

  if (
    process.env.NODE_ENV === "production" &&
    process.env.PAID_PRIVATE_FILE_ALLOW_LOCAL_NYM_OUTBOX !== "1"
  ) {
    throw new ServerError(
      "cli_unavailable",
      "NYM_CLIENT_ENDPOINT is required for production Nym delivery",
      { transport: input.transport },
    );
  }

  return queueLocalOutbox(input);
}

async function queueLocalOutbox(
  input: NymDeliveryPayload,
): Promise<NymDeliveryReceipt> {
  const queuedAt = new Date().toISOString();
  const deliveryId = `nym_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const receipt: NymDeliveryReceipt = {
    deliveryId,
    transport: input.transport,
    status: "queued_local_outbox",
    queuedAt,
  };

  const outbox = join(resolveWebRuntimeRoot(), "nym-outbox");
  await mkdir(outbox, { recursive: true, mode: 0o700 });
  await writeFile(
    join(outbox, `${deliveryId}.json`),
    `${JSON.stringify({ ...receipt, ...input }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  return receipt;
}

async function sendWithStandaloneNymClient(
  input: NymDeliveryPayload,
  endpoint: string,
): Promise<NymDeliveryReceipt> {
  const queuedAt = new Date().toISOString();
  const deliveryId = `nym_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const timeoutMs = readNymClientTimeoutMs();
  const wireMessage = JSON.stringify({
    type: "send",
    message: JSON.stringify(input.payload),
    recipient: input.buyerNymAddress,
  });

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close();
      }
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    timer = setTimeout(() => {
      finish(
        new ServerError("cli_unavailable", "Nym client send timed out", {
          endpoint,
          timeoutMs,
        }),
      );
    }, timeoutMs);

    socket.once("open", () => {
      socket.send(wireMessage, (error) => {
        if (error) {
          finish(
            new ServerError("cli_unavailable", "Nym client send failed", {
              endpoint,
              cause: error.message,
            }),
          );
          return;
        }
        finish();
      });
    });

    socket.once("error", (error) => {
      finish(
        new ServerError("cli_unavailable", "Nym client connection failed", {
          endpoint,
          cause: error.message,
        }),
      );
    });
  });

  return {
    deliveryId,
    transport: input.transport,
    status: "sent_nym_client",
    queuedAt,
    nymClientEndpoint: endpoint,
  };
}

function normalizeNymClientEndpoint(value: string | undefined): string | null {
  const endpoint = value?.trim();
  if (!endpoint) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ServerError("validation", "NYM_CLIENT_ENDPOINT must be a URL");
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new ServerError(
      "validation",
      "NYM_CLIENT_ENDPOINT must use ws:// or wss://",
    );
  }
  return parsed.toString();
}

function readNymClientTimeoutMs(): number {
  const raw = process.env.NYM_CLIENT_TIMEOUT_MS;
  if (!raw) {
    return 10_000;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 500 || parsed > 60_000) {
    throw new ServerError(
      "validation",
      "NYM_CLIENT_TIMEOUT_MS must be between 500 and 60000",
    );
  }
  return parsed;
}
