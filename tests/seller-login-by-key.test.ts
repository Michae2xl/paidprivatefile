import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerError } from "../lib/server/error-kinds";
import {
  authenticateSeller,
  createSellerProfile,
  getSellerProfileByAccessKey,
  rotateSellerAccessKey,
} from "../lib/server/seller-store";

const PAYOUT = "u1default00000000000000000000000000000000000000";

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-login-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

describe("seller login by access key alone", () => {
  it("authenticates with only the access key (no handle)", async () => {
    const created = await createSellerProfile({
      handle: "key-shop",
      displayName: "Key Shop",
      defaultPayoutAddress: PAYOUT,
    });

    const seller = await authenticateSeller({ accessKey: created.accessKey });
    expect(seller.sellerId).toBe(created.seller.sellerId);
    expect(seller.handle).toBe("key-shop");
  });

  it("still authenticates when the handle is also supplied", async () => {
    const created = await createSellerProfile({
      handle: "both-shop",
      displayName: "Both Shop",
      defaultPayoutAddress: PAYOUT,
    });

    const seller = await authenticateSeller({
      handle: "both-shop",
      accessKey: created.accessKey,
    });
    expect(seller.sellerId).toBe(created.seller.sellerId);
  });

  it("finds the right seller by key among several", async () => {
    await createSellerProfile({
      handle: "shop-a",
      displayName: "A",
      defaultPayoutAddress: PAYOUT,
    });
    const target = await createSellerProfile({
      handle: "shop-b",
      displayName: "B",
      defaultPayoutAddress: PAYOUT,
    });
    await createSellerProfile({
      handle: "shop-c",
      displayName: "C",
      defaultPayoutAddress: PAYOUT,
    });

    const found = await getSellerProfileByAccessKey(target.accessKey);
    expect(found?.sellerId).toBe(target.seller.sellerId);
    expect(found?.handle).toBe("shop-b");
  });

  it("rejects an unknown access key", async () => {
    await createSellerProfile({
      handle: "real-shop",
      displayName: "Real",
      defaultPayoutAddress: PAYOUT,
    });

    await expect(
      authenticateSeller({ accessKey: "ppf_not_a_real_key" }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(await getSellerProfileByAccessKey("ppf_not_a_real_key")).toBeNull();
  });
});

describe("rotateSellerAccessKey", () => {
  it("invalidates the old key and authenticates with the new one", async () => {
    const created = await createSellerProfile({
      handle: "rotate-shop",
      displayName: "Rotate Shop",
      defaultPayoutAddress: PAYOUT,
    });

    const { accessKey: newKey } = await rotateSellerAccessKey(
      created.seller.sellerId,
    );
    expect(newKey).toMatch(/^ppf_/u);
    expect(newKey).not.toBe(created.accessKey);

    // The NEW key authenticates to the same seller.
    const seller = await authenticateSeller({ accessKey: newKey });
    expect(seller.sellerId).toBe(created.seller.sellerId);
    expect(seller.handle).toBe("rotate-shop");

    // The OLD key no longer works (its hash was replaced).
    await expect(
      authenticateSeller({ accessKey: created.accessKey }),
    ).rejects.toBeInstanceOf(ServerError);
  });

  it("leaves the handle and payout config untouched", async () => {
    const created = await createSellerProfile({
      handle: "stable-shop",
      displayName: "Stable Shop",
      defaultPayoutAddress: PAYOUT,
    });

    await rotateSellerAccessKey(created.seller.sellerId);

    const seller = await authenticateSeller({
      accessKey: (await rotateSellerAccessKey(created.seller.sellerId))
        .accessKey,
    });
    expect(seller.handle).toBe("stable-shop");
    expect(seller.displayName).toBe("Stable Shop");
    expect(seller.defaultPayoutAddress).toBe(PAYOUT);
  });

  it("rejects rotation for an unknown seller", async () => {
    await expect(
      rotateSellerAccessKey(`sel_${"a".repeat(24)}`),
    ).rejects.toBeInstanceOf(ServerError);
  });
});
