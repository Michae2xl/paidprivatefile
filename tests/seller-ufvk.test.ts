import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSellerProfile,
  getSellerProfileById,
  getSellerUfvk,
  publicSeller,
  registerSellerUfvk,
} from "../lib/server/seller-store";
import {
  setScannerClientForTesting,
  type ScannerClient,
  type ScannerValidateResult,
} from "../lib/server/scanner-client";

const VALID_UFVK = "uview1validkeyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_UA = "u1validuaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEFAULT_ADDRESS = "u1default00000000000000000000000000000000000000";
const FINGERPRINT = "a".repeat(64);

let runtimeDir: string;

function fakeScanner(
  overrides: Partial<ScannerValidateResult> = {},
): ScannerClient {
  return {
    async validateUfvk() {
      return {
        valid: true,
        network: "main",
        fingerprint: FINGERPRINT,
        defaultAddress: DEFAULT_ADDRESS,
        receivers: ["orchard", "sapling", "transparent"],
        uaMatches: true,
        ...overrides,
      };
    },
    async deriveAddress() {
      return { address: DEFAULT_ADDRESS, actualIndex: 0 };
    },
  };
}

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-ufvk-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_SELLER_UFVK_KEY =
    randomBytes(32).toString("hex");
  setScannerClientForTesting(fakeScanner());
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_SELLER_UFVK_KEY;
  setScannerClientForTesting(null);
  await rm(runtimeDir, { recursive: true, force: true });
});

async function newSeller(handle = "ufvk-shop") {
  const created = await createSellerProfile({
    handle,
    displayName: "UFVK Shop",
    defaultPayoutAddress: DEFAULT_ADDRESS,
  });
  return created.seller.sellerId;
}

describe("seller-store UFVK registration", () => {
  it("encrypts the UFVK at rest and exposes only the fingerprint", async () => {
    const sellerId = await newSeller();
    const result = await registerSellerUfvk(sellerId, {
      ufvk: VALID_UFVK,
      ua: VALID_UA,
    });

    expect(result.ufvkFingerprint).toBe(FINGERPRINT);
    expect(result.network).toBe("main");
    expect(result.defaultAddress).toBe(DEFAULT_ADDRESS);

    const profile = await getSellerProfileById(sellerId);
    expect(profile?.ufvkFingerprint).toBe(FINGERPRINT);
    expect(profile?.network).toBe("main");
    expect(profile?.ufvkEncrypted).toBeTruthy();
    // The encrypted blob must not contain the plaintext UFVK.
    expect(JSON.stringify(profile)).not.toContain(VALID_UFVK);

    const onDisk = await readFile(
      join(runtimeDir, "seller-workspaces", "profiles", `${sellerId}.json`),
      "utf8",
    );
    expect(onDisk).not.toContain(VALID_UFVK);
    expect(onDisk).toContain(FINGERPRINT);
  });

  it("round-trips the decrypted UFVK via getSellerUfvk", async () => {
    const sellerId = await newSeller();
    await registerSellerUfvk(sellerId, { ufvk: VALID_UFVK, ua: VALID_UA });
    const decrypted = await getSellerUfvk(sellerId);
    expect(decrypted).toBe(VALID_UFVK);
  });

  it("creates a shop directly from a UFVK, deriving the receiving address", async () => {
    const created = await createSellerProfile({
      handle: "ufvk-create",
      displayName: "UFVK Create",
      ufvk: VALID_UFVK,
    });
    // Receiving address is derived from the key (no separate wallet pasted).
    expect(created.seller.defaultPayoutAddress).toBe(DEFAULT_ADDRESS);
    const profile = await getSellerProfileById(created.seller.sellerId);
    expect(profile?.ufvkFingerprint).toBe(FINGERPRINT);
    expect(profile?.ufvkEncrypted).toBeTruthy();
    expect(JSON.stringify(profile)).not.toContain(VALID_UFVK);
  });

  it("rejects shop creation with neither a UFVK nor a payout address", async () => {
    await expect(
      createSellerProfile({ handle: "no-key", displayName: "No Key" }),
    ).rejects.toThrow();
  });

  it("never leaks the UFVK through publicSeller()", async () => {
    const sellerId = await newSeller();
    await registerSellerUfvk(sellerId, { ufvk: VALID_UFVK, ua: VALID_UA });
    const profile = await getSellerProfileById(sellerId);
    if (!profile) throw new Error("profile missing");
    const pub = publicSeller(profile);
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain(VALID_UFVK);
    expect(serialized).not.toContain("ufvkEncrypted");
    // Fingerprint is safe to expose.
    expect((pub as { ufvkFingerprint?: string }).ufvkFingerprint).toBe(
      FINGERPRINT,
    );
  });

  it("rejects an invalid UFVK", async () => {
    setScannerClientForTesting(fakeScanner({ valid: false }));
    const sellerId = await newSeller();
    await expect(
      registerSellerUfvk(sellerId, { ufvk: VALID_UFVK }),
    ).rejects.toThrow();
    const profile = await getSellerProfileById(sellerId);
    expect(profile?.ufvkEncrypted).toBeUndefined();
  });

  it("rejects a non-mainnet UFVK", async () => {
    setScannerClientForTesting(fakeScanner({ network: "test" }));
    const sellerId = await newSeller();
    await expect(
      registerSellerUfvk(sellerId, { ufvk: VALID_UFVK }),
    ).rejects.toThrow();
  });

  it("rejects when the provided UA does not match the UFVK", async () => {
    setScannerClientForTesting(fakeScanner({ uaMatches: false }));
    const sellerId = await newSeller();
    await expect(
      registerSellerUfvk(sellerId, { ufvk: VALID_UFVK, ua: VALID_UA }),
    ).rejects.toThrow();
  });

  it("rejects when the UFVK encryption key is unset", async () => {
    delete process.env.PAID_PRIVATE_FILE_SELLER_UFVK_KEY;
    const sellerId = await newSeller();
    await expect(
      registerSellerUfvk(sellerId, { ufvk: VALID_UFVK }),
    ).rejects.toThrow();
  });

  it("getSellerUfvk returns null for a seller without a UFVK (back-compat)", async () => {
    const sellerId = await newSeller();
    expect(await getSellerUfvk(sellerId)).toBeNull();
  });

  it("keeps a seller without a UFVK valid and loadable (back-compat)", async () => {
    const sellerId = await newSeller("legacy-shop");
    const profile = await getSellerProfileById(sellerId);
    expect(profile).not.toBeNull();
    expect(profile?.ufvkEncrypted).toBeUndefined();
    expect(profile?.ufvkFingerprint).toBeUndefined();
  });
});
