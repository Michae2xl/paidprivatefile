import { createHash, randomBytes, webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPaidLinkSellerReleaseDraft } from "../lib/paid-link-client-crypto";
import { findBindingByOrderId } from "../lib/server/deposit-bindings";
import { registerDepositAddresses } from "../lib/server/deposit-pool";
import {
  setScannerClientForTesting,
  type ScannerClient,
} from "../lib/server/scanner-client";
import {
  createSellerProfile,
  registerSellerUfvk,
} from "../lib/server/seller-store";
import {
  createPaymentIntentForOrder,
  createTransferOrder,
  type TransferSeller,
} from "../lib/server/transfer-store";

const SELLER_DEFAULT_ADDRESS = "u1selleraddr0000000000000000000000000000000000";
const DERIVED_BASE = "u1derived";
const FINGERPRINT = "b".repeat(64);
const POOL_ADDRESS = "u1poolfallbackaddr00000000000000000000000000000000";

let runtimeDir: string;
let releaseDraft: { releaseSecretHash: string };
let deriveCalls: Array<{ ufvk: string; diversifierIndex: number }>;

function fakeScanner(): ScannerClient {
  deriveCalls = [];
  return {
    async validateUfvk() {
      return {
        valid: true,
        network: "main",
        fingerprint: FINGERPRINT,
        defaultAddress: SELLER_DEFAULT_ADDRESS,
        receivers: ["orchard", "sapling", "transparent"],
        uaMatches: true,
      };
    },
    async deriveAddress(input) {
      deriveCalls.push(input);
      return {
        address: `${DERIVED_BASE}${input.diversifierIndex}00000000000000000000`,
        actualIndex: input.diversifierIndex,
      };
    },
  };
}

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
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-derive-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_SELLER_UFVK_KEY =
    randomBytes(32).toString("hex");
  process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN = "1";
  releaseDraft = await createPaidLinkSellerReleaseDraft(
    randomBytes(32).toString("base64"),
  );
  setScannerClientForTesting(fakeScanner());
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_SELLER_UFVK_KEY;
  delete process.env.PAID_PRIVATE_FILE_ZCASH_ONCHAIN;
  delete process.env.PPF_SCAN_DEFAULT_START_HEIGHT;
  setScannerClientForTesting(null);
  await rm(runtimeDir, { recursive: true, force: true });
});

async function seller(
  handle: string,
  withUfvk: boolean,
): Promise<TransferSeller> {
  const created = await createSellerProfile({
    handle,
    displayName: handle,
    defaultPayoutAddress: SELLER_DEFAULT_ADDRESS,
  });
  if (withUfvk) {
    await registerSellerUfvk(created.seller.sellerId, {
      ufvk: "uview1sellerkeyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  }
  return {
    sellerId: created.seller.sellerId,
    handle: created.seller.handle,
    displayName: created.seller.displayName,
  };
}

async function order(sellerProfile: TransferSeller | null) {
  const encrypted = new Uint8Array([1, 2, 3, 4, 5, 6]);
  return createTransferOrder({
    encryptedFile: encrypted,
    fileName: "secret.pdf",
    mimeType: "application/pdf",
    originalSizeBytes: 123,
    encryptedFileSha256: createHash("sha256").update(encrypted).digest("hex"),
    encryptionIv: randomBytes(12).toString("base64"),
    releaseSecretHash: releaseDraft.releaseSecretHash,
    amountZats: 5_000_000,
    sellerPayoutAddress: SELLER_DEFAULT_ADDRESS,
    seller: sellerProfile,
  });
}

async function buyerJwk(): Promise<JsonWebKey> {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  return webcrypto.subtle.exportKey("jwk", pair.publicKey);
}

describe("createPaymentIntentForOrder branching", () => {
  it("derives a per-order address from the seller UFVK when present", async () => {
    const sellerProfile = await seller("ufvk-seller", true);
    const created = await order(sellerProfile);
    const result = await createPaymentIntentForOrder(
      created.orderId,
      await buyerJwk(),
    );

    expect(result.payment.provider).toBe("zcash-onchain");
    expect(result.payment.receivingAddress).toContain(DERIVED_BASE);
    expect(result.order.payment?.receivingAddress).toBe(
      result.payment.receivingAddress,
    );
    expect(deriveCalls).toHaveLength(1);
    expect(deriveCalls[0].diversifierIndex).toBe(1);

    const binding = await findBindingByOrderId(created.orderId);
    expect(binding?.address).toBe(result.payment.receivingAddress);
    expect(binding?.sellerId).toBe(sellerProfile.sellerId);
    expect(binding?.diversifierIndex).toBe(1);
  });

  it("uses the configured default start height for the binding", async () => {
    process.env.PPF_SCAN_DEFAULT_START_HEIGHT = "3385000";
    const sellerProfile = await seller("ufvk-seller-h", true);
    const created = await order(sellerProfile);
    await createPaymentIntentForOrder(created.orderId, await buyerJwk());
    const binding = await findBindingByOrderId(created.orderId);
    expect(binding?.startHeight).toBe(3_385_000);
  });

  it("falls back to the pool when the seller has no UFVK (back-compat)", async () => {
    await registerDepositAddresses([POOL_ADDRESS]);
    const sellerProfile = await seller("legacy-seller", false);
    const created = await order(sellerProfile);
    const result = await createPaymentIntentForOrder(
      created.orderId,
      await buyerJwk(),
    );

    expect(result.payment.provider).toBe("zcash-onchain");
    expect(result.payment.receivingAddress).toBe(POOL_ADDRESS);
    expect(deriveCalls).toHaveLength(0);
    expect(await findBindingByOrderId(created.orderId)).toBeNull();
  });

  it("falls back to the pool when there is no seller at all (back-compat)", async () => {
    await registerDepositAddresses([POOL_ADDRESS]);
    const created = await order(null);
    const result = await createPaymentIntentForOrder(
      created.orderId,
      await buyerJwk(),
    );
    expect(result.payment.receivingAddress).toBe(POOL_ADDRESS);
    expect(deriveCalls).toHaveLength(0);
  });

  it("persists the derived receiving address on disk", async () => {
    const sellerProfile = await seller("ufvk-seller-d", true);
    const created = await order(sellerProfile);
    const result = await createPaymentIntentForOrder(
      created.orderId,
      await buyerJwk(),
    );
    const raw = await readFile(
      join(
        runtimeDir,
        "paid-transfers",
        "orders",
        created.orderId,
        "order.json",
      ),
      "utf8",
    );
    expect(raw).toContain(result.payment.receivingAddress as string);
  });
});
