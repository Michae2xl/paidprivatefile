import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSellerProfile,
  getSellerProfileById,
  getSellerScanRef,
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
const SCAN_REF = `scan_${"b".repeat(24)}`;

let runtimeDir: string;

// Phase 3: the scanner holds the UFVK. The fake validates on `validateUfvk`
// (preview) and STORES on `registerUfvk` (returning a scanRef), rejecting
// invalid keys / non-matching UAs exactly as the real scanner would.
function fakeScanner(
  overrides: Partial<ScannerValidateResult> = {},
): ScannerClient {
  const base: ScannerValidateResult = {
    valid: true,
    network: "main",
    fingerprint: FINGERPRINT,
    defaultAddress: DEFAULT_ADDRESS,
    receivers: ["orchard", "sapling", "transparent"],
    uaMatches: true,
    ...overrides,
  };
  return {
    async validateUfvk() {
      return base;
    },
    async registerUfvk() {
      if (!base.valid || base.uaMatches === false) {
        throw new Error("scanner rejected the viewing key");
      }
      return {
        scanRef: SCAN_REF,
        network: base.network,
        fingerprint: base.fingerprint,
        defaultAddress: base.defaultAddress,
        receivers: base.receivers,
        uaMatches: base.uaMatches,
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
  setScannerClientForTesting(fakeScanner());
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
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

describe("seller-store UFVK custody (Phase 3: scanRef only)", () => {
  it("stores only a scanRef + fingerprint, never the UFVK", async () => {
    const sellerId = await newSeller();
    const result = await registerSellerUfvk(sellerId, {
      ufvk: VALID_UFVK,
      ua: VALID_UA,
    });

    expect(result.ufvkFingerprint).toBe(FINGERPRINT);
    expect(result.network).toBe("main");
    expect(result.defaultAddress).toBe(DEFAULT_ADDRESS);

    const profile = await getSellerProfileById(sellerId);
    expect(profile?.sellerScanRef).toBe(SCAN_REF);
    expect(profile?.ufvkFingerprint).toBe(FINGERPRINT);
    expect(profile?.network).toBe("main");
    expect(profile?.ufvkEncrypted).toBeUndefined();

    const onDisk = await readFile(
      join(runtimeDir, "seller-workspaces", "profiles", `${sellerId}.json`),
      "utf8",
    );
    // The app never holds the UFVK — it must not appear on disk.
    expect(onDisk).not.toContain(VALID_UFVK);
    expect(onDisk).toContain(FINGERPRINT);
  });

  it("getSellerScanRef returns the stored scanRef", async () => {
    const sellerId = await newSeller();
    await registerSellerUfvk(sellerId, { ufvk: VALID_UFVK, ua: VALID_UA });
    expect(await getSellerScanRef(sellerId)).toBe(SCAN_REF);
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
    expect(profile?.sellerScanRef).toBe(SCAN_REF);
    expect(profile?.ufvkEncrypted).toBeUndefined();
    expect(JSON.stringify(profile)).not.toContain(VALID_UFVK);
  });

  it("rejects shop creation with neither a UFVK nor a payout address", async () => {
    await expect(
      createSellerProfile({ handle: "no-key", displayName: "No Key" }),
    ).rejects.toThrow();
  });

  it("never leaks the UFVK or scanRef through publicSeller()", async () => {
    const sellerId = await newSeller();
    await registerSellerUfvk(sellerId, { ufvk: VALID_UFVK, ua: VALID_UA });
    const profile = await getSellerProfileById(sellerId);
    if (!profile) throw new Error("profile missing");
    const pub = publicSeller(profile);
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain(VALID_UFVK);
    expect(serialized).not.toContain(SCAN_REF);
    expect(serialized).not.toContain("ufvkEncrypted");
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
    expect(profile?.sellerScanRef).toBeUndefined();
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

  it("getSellerScanRef returns null for a seller without a UFVK", async () => {
    const sellerId = await newSeller();
    expect(await getSellerScanRef(sellerId)).toBeNull();
  });

  it("keeps a seller without a UFVK valid and loadable (back-compat)", async () => {
    const sellerId = await newSeller("legacy-shop");
    const profile = await getSellerProfileById(sellerId);
    expect(profile).not.toBeNull();
    expect(profile?.sellerScanRef).toBeUndefined();
    expect(profile?.ufvkFingerprint).toBeUndefined();
  });
});
