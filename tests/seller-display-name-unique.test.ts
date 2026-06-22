import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PATCH as updateSellerRoute } from "../app/api/sellers/me/route";
import { ServerError } from "../lib/server/error-kinds";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";
import {
  createSellerProfile,
  createSellerSessionToken,
  isDisplayNameAvailable,
  SELLER_SESSION_COOKIE,
  updateSellerProfile,
} from "../lib/server/seller-store";

const PAYOUT = "u1default00000000000000000000000000000000000000";

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-name-unique-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  resetRateLimitStateForTesting();
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS;
  await rm(runtimeDir, { recursive: true, force: true });
});

describe("isDisplayNameAvailable", () => {
  it("returns false when another seller already uses the name", async () => {
    await createSellerProfile({
      handle: "shop-one",
      displayName: "Acme Store",
      defaultPayoutAddress: PAYOUT,
    });

    expect(await isDisplayNameAvailable("Acme Store")).toBe(false);
  });

  it("returns true for a name no seller uses", async () => {
    await createSellerProfile({
      handle: "shop-one",
      displayName: "Acme Store",
      defaultPayoutAddress: PAYOUT,
    });

    expect(await isDisplayNameAvailable("Brand New Name")).toBe(true);
  });

  it("compares case-insensitively and trims surrounding whitespace", async () => {
    await createSellerProfile({
      handle: "shop-one",
      displayName: "Acme Store",
      defaultPayoutAddress: PAYOUT,
    });

    expect(await isDisplayNameAvailable("  acme   STORE  ")).toBe(false);
  });

  it("excludes the seller's own profile (self never collides)", async () => {
    const mine = await createSellerProfile({
      handle: "my-shop",
      displayName: "My Shop",
      defaultPayoutAddress: PAYOUT,
    });

    expect(await isDisplayNameAvailable("My Shop", mine.seller.sellerId)).toBe(
      true,
    );
    // Without the exclusion it is taken.
    expect(await isDisplayNameAvailable("My Shop")).toBe(false);
  });
});

describe("updateSellerProfile display-name uniqueness", () => {
  it("rejects changing to a name already used by another seller", async () => {
    await createSellerProfile({
      handle: "first-shop",
      displayName: "Taken Name",
      defaultPayoutAddress: PAYOUT,
    });
    const second = await createSellerProfile({
      handle: "second-shop",
      displayName: "Second Shop",
      defaultPayoutAddress: PAYOUT,
    });

    await expect(
      updateSellerProfile(second.seller.sellerId, {
        displayName: "Taken Name",
      }),
    ).rejects.toBeInstanceOf(ServerError);
  });

  it("allows keeping (re-saving) your own current name", async () => {
    const mine = await createSellerProfile({
      handle: "stay-shop",
      displayName: "Keep This",
      defaultPayoutAddress: PAYOUT,
    });

    const updated = await updateSellerProfile(mine.seller.sellerId, {
      displayName: "Keep This",
    });
    expect(updated.displayName).toBe("Keep This");
  });

  it("allows changing to a free name", async () => {
    const mine = await createSellerProfile({
      handle: "change-shop",
      displayName: "Old Name",
      defaultPayoutAddress: PAYOUT,
    });

    const updated = await updateSellerProfile(mine.seller.sellerId, {
      displayName: "Fresh Unique Name",
    });
    expect(updated.displayName).toBe("Fresh Unique Name");
  });
});

describe("createSellerProfile display-name uniqueness", () => {
  it("rejects a new shop that takes an existing public name", async () => {
    await createSellerProfile({
      handle: "owner-shop",
      displayName: "Original Name",
      defaultPayoutAddress: PAYOUT,
    });

    await expect(
      createSellerProfile({
        handle: "copycat-shop",
        displayName: "original name",
        defaultPayoutAddress: PAYOUT,
      }),
    ).rejects.toBeInstanceOf(ServerError);
  });
});

describe("PATCH /api/sellers/me display-name conflict", () => {
  it("returns 409 when the new public name belongs to another seller", async () => {
    await createSellerProfile({
      handle: "alpha-shop",
      displayName: "Alpha Name",
      defaultPayoutAddress: PAYOUT,
    });
    const beta = await createSellerProfile({
      handle: "beta-shop",
      displayName: "Beta Name",
      defaultPayoutAddress: PAYOUT,
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await updateSellerRoute(
        new Request("http://localhost/api/sellers/me", {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            cookie: `${SELLER_SESSION_COOKIE}=${createSellerSessionToken(beta.seller.sellerId)}`,
          },
          body: JSON.stringify({ displayName: "Alpha Name" }),
        }),
      );
      expect(response.status).toBe(409);
      const parsed = (await response.json()) as {
        error: { kind: string; message: string };
      };
      expect(parsed.error.kind).toBe("flow_conflict");
      expect(parsed.error.message).toContain("already in use");
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("lets a seller re-save their own public name (200)", async () => {
    const solo = await createSellerProfile({
      handle: "solo-shop",
      displayName: "Solo Name",
      defaultPayoutAddress: PAYOUT,
    });

    const response = await updateSellerRoute(
      new Request("http://localhost/api/sellers/me", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          cookie: `${SELLER_SESSION_COOKIE}=${createSellerSessionToken(solo.seller.sellerId)}`,
        },
        body: JSON.stringify({ displayName: "Solo Name" }),
      }),
    );
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as {
      seller: { displayName: string };
    };
    expect(parsed.seller.displayName).toBe("Solo Name");
  });
});
