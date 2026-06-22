// Store-level unit tests for markTransferDetectedOnchain — the 0-conf "Payment
// detected" transition. It must record an UNCONFIRMED mempool sighting
// (detectedAt + onchain) WITHOUT flipping the order to paid, and be idempotent
// for repeated 0-conf reports of the same txid. The key release stays gated on
// the separate confirmed paid transition, so a detected order is NOT claimable.

import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPaidLinkSellerReleaseDraft } from "../lib/paid-link-client-crypto";
import { registerDepositAddresses } from "../lib/server/deposit-pool";
import { ServerError } from "../lib/server/error-kinds";
import {
  createPaymentIntentForOrder,
  createTransferOrder,
  getTransferPublicOrder,
  markTransferDetectedOnchain,
  markTransferPaidOnchain,
} from "../lib/server/transfer-store";

const POOL_ADDRESS = "u1detectpooladdr000000000000000000000000000000000000";
const SELLER_ADDRESS = "u1sellerpayoutaddress000000000000000000000000000000000";
const TXID = "c".repeat(64);

let runtimeDir: string;
let releaseDraft: { releaseSecretHash: string };

beforeAll(() => {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  if (typeof globalScope.window === "undefined") {
    globalScope.window = {
      btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    };
  }
});

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-detected-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN = "1";
  releaseDraft = await createPaidLinkSellerReleaseDraft(
    randomBytes(32).toString("base64"),
  );
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN;
  await rm(runtimeDir, { recursive: true, force: true });
});

async function onchainOrder(): Promise<{
  orderId: string;
  receivingAddress: string;
}> {
  await registerDepositAddresses([POOL_ADDRESS]);
  const encrypted = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const created = await createTransferOrder({
    encryptedFile: encrypted,
    fileName: "secret.pdf",
    mimeType: "application/pdf",
    originalSizeBytes: 123,
    encryptedFileSha256: createHash("sha256").update(encrypted).digest("hex"),
    encryptionIv: randomBytes(12).toString("base64"),
    releaseSecretHash: releaseDraft.releaseSecretHash,
    amountZats: 5_000_000,
    sellerPayoutAddress: SELLER_ADDRESS,
  });
  const { payment } = await createPaymentIntentForOrder(
    created.orderId,
    await buyerJwk(),
  );
  return {
    orderId: created.orderId,
    receivingAddress: payment.receivingAddress ?? POOL_ADDRESS,
  };
}

async function buyerJwk(): Promise<JsonWebKey> {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  return webcrypto.subtle.exportKey("jwk", pair.publicKey);
}

describe("markTransferDetectedOnchain", () => {
  it("records detectedAt + onchain without flipping to paid", async () => {
    const { orderId } = await onchainOrder();

    const result = await markTransferDetectedOnchain({
      orderId,
      txid: TXID,
      amountZats: 5_000_000,
      confirmations: 0,
    });

    // The sighting is recorded for the UI...
    expect(typeof result.payment?.detectedAt).toBe("string");
    expect(result.payment?.onchain?.txid).toBe(TXID);
    expect(result.payment?.onchain?.confirmations).toBe(0);
    // ...but the order is NOT paid and stays open (not claimable).
    expect(result.payment?.status).toBe("pending");
    expect(result.status).toBe("payment_pending");

    const reread = await getTransferPublicOrder(orderId);
    expect(reread.status).toBe("payment_pending");
    expect(reread.payment?.status).toBe("pending");
  });

  it("is idempotent: re-sending confs=0 for the same txid keeps detectedAt", async () => {
    const { orderId } = await onchainOrder();

    const first = await markTransferDetectedOnchain({
      orderId,
      txid: TXID,
      amountZats: 5_000_000,
      confirmations: 0,
    });
    const detectedAt = first.payment?.detectedAt;
    expect(typeof detectedAt).toBe("string");

    const second = await markTransferDetectedOnchain({
      orderId,
      txid: TXID,
      amountZats: 5_000_000,
      confirmations: 1,
    });
    // detectedAt is stamped only once; confirmations may refresh.
    expect(second.payment?.detectedAt).toBe(detectedAt);
    expect(second.payment?.onchain?.confirmations).toBe(1);
    expect(second.payment?.status).toBe("pending");
    expect(second.status).toBe("payment_pending");
  });

  it("does not regress an already-paid order to detected", async () => {
    const { orderId } = await onchainOrder();
    await markTransferPaidOnchain({
      orderId,
      txid: TXID,
      amountZats: 5_000_000,
      confirmations: 12,
    });

    // A late 0-conf report for the same txid must not undo the paid state.
    const result = await markTransferDetectedOnchain({
      orderId,
      txid: TXID,
      amountZats: 5_000_000,
      confirmations: 0,
    });
    expect(result.status).toBe("paid");
    expect(result.payment?.status).toBe("paid");
  });

  it("rejects a conflicting txid sighting", async () => {
    const { orderId } = await onchainOrder();
    await markTransferDetectedOnchain({
      orderId,
      txid: TXID,
      amountZats: 5_000_000,
      confirmations: 0,
    });

    await expect(
      markTransferDetectedOnchain({
        orderId,
        txid: "d".repeat(64),
        amountZats: 5_000_000,
        confirmations: 0,
      }),
    ).rejects.toBeInstanceOf(ServerError);
  });
});
