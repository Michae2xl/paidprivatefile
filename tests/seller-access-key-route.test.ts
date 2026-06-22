import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as rotateAccessKeyRoute } from "../app/api/sellers/me/access-key/route";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";
import {
  authenticateSeller,
  createSellerProfile,
  createSellerSessionToken,
  SELLER_SESSION_COOKIE,
} from "../lib/server/seller-store";

const PAYOUT = "u1default00000000000000000000000000000000000000";

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await mkdtemp(
    join(tmpdir(), "paidprivatefile-access-key-route-"),
  );
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  resetRateLimitStateForTesting();
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS;
  await rm(runtimeDir, { recursive: true, force: true });
});

function accessKeyRequest(sellerId: string | null): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (sellerId) {
    headers.cookie = `${SELLER_SESSION_COOKIE}=${createSellerSessionToken(sellerId)}`;
  }
  return new Request("http://localhost/api/sellers/me/access-key", {
    method: "POST",
    headers,
  });
}

describe("POST /api/sellers/me/access-key", () => {
  it("rotates the key for an authenticated seller and returns the new key", async () => {
    const created = await createSellerProfile({
      handle: "route-shop",
      displayName: "Route Shop",
      defaultPayoutAddress: PAYOUT,
    });

    const response = await rotateAccessKeyRoute(
      accessKeyRequest(created.seller.sellerId),
    );
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as { accessKey: string };
    expect(parsed.accessKey).toMatch(/^ppf_/u);
    expect(parsed.accessKey).not.toBe(created.accessKey);

    // The returned key authenticates; the old one no longer does.
    const seller = await authenticateSeller({ accessKey: parsed.accessKey });
    expect(seller.sellerId).toBe(created.seller.sellerId);
    await expect(
      authenticateSeller({ accessKey: created.accessKey }),
    ).rejects.toThrow();
  });

  it("requires a seller session (401 without a cookie)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await rotateAccessKeyRoute(accessKeyRequest(null));
      expect(response.status).toBe(401);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
