import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
  status: "queued_local_outbox";
  queuedAt: string;
}

export async function queueNymDelivery(
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
