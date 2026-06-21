import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerError } from "../lib/server/error-kinds";
import {
  authenticateSeller,
  createSellerProfile,
  getSellerProfileByAccessKey,
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
