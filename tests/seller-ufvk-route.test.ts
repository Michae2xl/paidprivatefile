import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as registerUfvkRoute } from "../app/api/sellers/me/ufvk/route";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";
import {
  setScannerClientForTesting,
  type ScannerClient,
  type ScannerValidateResult,
} from "../lib/server/scanner-client";
import {
  createSellerProfile,
  createSellerSessionToken,
  getSellerUfvk,
  SELLER_SESSION_COOKIE,
} from "../lib/server/seller-store";

const DEFAULT_ADDRESS = "u1default00000000000000000000000000000000000000";
const FINGERPRINT = "d".repeat(64);
const UFVK = "uview1routekeyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

let runtimeDir: string;

interface ErrorEnvelope {
  error: { kind: string; message: string };
}

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
        receivers: ["orchard"],
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
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-ufvk-route-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_SELLER_UFVK_KEY =
    randomBytes(32).toString("hex");
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  setScannerClientForTesting(fakeScanner());
  resetRateLimitStateForTesting();
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_SELLER_UFVK_KEY;
  delete process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS;
  setScannerClientForTesting(null);
  await rm(runtimeDir, { recursive: true, force: true });
});

async function authedSellerId(handle = "route-shop"): Promise<string> {
  const created = await createSellerProfile({
    handle,
    displayName: handle,
    defaultPayoutAddress: DEFAULT_ADDRESS,
  });
  return created.seller.sellerId;
}

function ufvkRequest(sellerId: string | null, body: unknown): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (sellerId) {
    headers.cookie = `${SELLER_SESSION_COOKIE}=${createSellerSessionToken(sellerId)}`;
  }
  return new Request("http://localhost/api/sellers/me/ufvk", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/sellers/me/ufvk", () => {
  it("registers the UFVK and returns the fingerprint and default address", async () => {
    const sellerId = await authedSellerId();
    const response = await registerUfvkRoute(
      ufvkRequest(sellerId, { ufvk: UFVK }),
    );
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      ufvkFingerprint: string;
      network: string;
      defaultAddress: string;
    };
    expect(parsed.ufvkFingerprint).toBe(FINGERPRINT);
    expect(parsed.network).toBe("main");
    expect(parsed.defaultAddress).toBe(DEFAULT_ADDRESS);

    expect(await getSellerUfvk(sellerId)).toBe(UFVK);
  });

  it("requires a seller session", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await registerUfvkRoute(
        ufvkRequest(null, { ufvk: UFVK }),
      );
      expect(response.status).toBe(401);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects an invalid UFVK", async () => {
    setScannerClientForTesting(fakeScanner({ valid: false }));
    const sellerId = await authedSellerId();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await registerUfvkRoute(
        ufvkRequest(sellerId, { ufvk: UFVK }),
      );
      expect(response.status).toBe(400);
      const parsed = (await response.json()) as ErrorEnvelope;
      expect(parsed.error.kind).toBe("validation");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("does not echo the UFVK back in the response", async () => {
    const sellerId = await authedSellerId();
    const response = await registerUfvkRoute(
      ufvkRequest(sellerId, { ufvk: UFVK }),
    );
    const text = await response.text();
    expect(text).not.toContain(UFVK);
  });
});
