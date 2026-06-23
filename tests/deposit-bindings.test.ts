import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bindOrderDeposit,
  DepositAddressCollisionError,
  findBindingByAddress,
  findOrderIdByBoundAddress,
  isDepositAddressCollision,
  listBoundOrderIds,
  nextDiversifierIndex,
  reconcileDiversifierMark,
} from "../lib/server/deposit-bindings";
import { findOrderIdForDeposit } from "../lib/server/transfer-store";

let runtimeDir: string;

const SELLER_A = "sel_aaaaaaaaaaaaaaaaaaaaaaaa";
const SELLER_B = "sel_bbbbbbbbbbbbbbbbbbbbbbbb";
const ORDER_A = "pl_aaaaaaaaaaaaaaaaaaaaaaaa";
const ORDER_B = "pl_bbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_A = "u1bindingaddressaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-bindings-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

describe("deposit bindings", () => {
  it("persists a binding and resolves it by address", async () => {
    await bindOrderDeposit(ORDER_A, {
      address: ADDRESS_A,
      sellerId: SELLER_A,
      diversifierIndex: 7,
      startHeight: 3_385_000,
    });

    expect(await findOrderIdByBoundAddress(ADDRESS_A)).toBe(ORDER_A);
    const binding = await findBindingByAddress(ADDRESS_A);
    expect(binding).toMatchObject({
      orderId: ORDER_A,
      sellerId: SELLER_A,
      diversifierIndex: 7,
      startHeight: 3_385_000,
    });
    expect(await listBoundOrderIds()).toContain(ORDER_A);
  });

  it("returns null for an unknown address", async () => {
    expect(await findOrderIdByBoundAddress(ADDRESS_A)).toBeNull();
    expect(await findBindingByAddress(ADDRESS_A)).toBeNull();
  });

  it("rejects binding one address to a SECOND order (collision guard)", async () => {
    await bindOrderDeposit(ORDER_A, {
      address: ADDRESS_A,
      sellerId: SELLER_A,
      diversifierIndex: 3,
      startHeight: 0,
    });
    // A different order deriving the SAME address must be rejected, not silently
    // bound (which would misattribute that buyer's payment to ORDER_A).
    let caught: unknown;
    try {
      await bindOrderDeposit(ORDER_B, {
        address: ADDRESS_A,
        sellerId: SELLER_A,
        diversifierIndex: 3,
        startHeight: 0,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DepositAddressCollisionError);
    expect(isDepositAddressCollision(caught)).toBe(true);
    // The original binding is untouched.
    expect(await findOrderIdByBoundAddress(ADDRESS_A)).toBe(ORDER_A);
  });

  it("is idempotent for the SAME order (no collision on its own address)", async () => {
    const first = await bindOrderDeposit(ORDER_A, {
      address: ADDRESS_A,
      sellerId: SELLER_A,
      diversifierIndex: 3,
      startHeight: 0,
    });
    const again = await bindOrderDeposit(ORDER_A, {
      address: ADDRESS_A,
      sellerId: SELLER_A,
      diversifierIndex: 3,
      startHeight: 0,
    });
    expect(again).toEqual(first);
  });

  it("findOrderIdForDeposit resolves a binding (and still resolves pool entries)", async () => {
    await bindOrderDeposit(ORDER_A, {
      address: ADDRESS_A,
      sellerId: SELLER_A,
      diversifierIndex: 1,
      startHeight: 0,
    });
    expect(await findOrderIdForDeposit(ADDRESS_A)).toBe(ORDER_A);
    // Unknown address still resolves null (no pool entry either).
    expect(await findOrderIdForDeposit("u1nope")).toBeNull();
  });
});

describe("nextDiversifierIndex", () => {
  it("returns a monotonic high-water mark per seller", async () => {
    expect(await nextDiversifierIndex(SELLER_A)).toBe(1);
    expect(await nextDiversifierIndex(SELLER_A)).toBe(2);
    expect(await nextDiversifierIndex(SELLER_A)).toBe(3);
  });

  it("tracks the high-water mark independently per seller", async () => {
    await nextDiversifierIndex(SELLER_A);
    await nextDiversifierIndex(SELLER_A);
    expect(await nextDiversifierIndex(SELLER_B)).toBe(1);
    expect(await nextDiversifierIndex(SELLER_A)).toBe(3);
  });

  it("is collision-free under concurrency", async () => {
    const count = 50;
    const results = await Promise.all(
      Array.from({ length: count }, () => nextDiversifierIndex(SELLER_A)),
    );
    const unique = new Set(results);
    expect(unique.size).toBe(count);
    expect(Math.max(...results)).toBe(count);
    expect(Math.min(...results)).toBe(1);
  });

  it("persists the high-water mark to disk (crash-safe)", async () => {
    await nextDiversifierIndex(SELLER_A);
    await nextDiversifierIndex(SELLER_A);

    // The mark is durable on disk, not just in process memory: a fresh read
    // (as a restarted process would do) sees the persisted high-water mark.
    const onDisk = JSON.parse(
      await readFile(
        join(
          runtimeDir,
          "paid-transfers",
          "deposit-bindings",
          "diversifier-marks.json",
        ),
        "utf8",
      ),
    ) as { marks: Record<string, number> };
    expect(onDisk.marks[SELLER_A]).toBe(2);

    // And the next index continues from the persisted mark.
    expect(await nextDiversifierIndex(SELLER_A)).toBe(3);
  });
});

describe("reconcileDiversifierMark", () => {
  it("advances the mark past the scanner's actual index so the next order can't collide", async () => {
    // Order 1 requests index 1 but the scanner returns actualIndex 5 (skipped
    // invalid diversifiers). Reconciling to actualIndex+1 must push the mark to 6,
    // so the NEXT order requests 6 — never 2..5, which could re-derive order 1's
    // address.
    expect(await nextDiversifierIndex(SELLER_A)).toBe(1);
    await reconcileDiversifierMark(SELLER_A, 5 + 1);
    expect(await nextDiversifierIndex(SELLER_A)).toBe(7);
  });

  it("is monotonic — never lowers the mark", async () => {
    await nextDiversifierIndex(SELLER_A); // mark = 1
    await nextDiversifierIndex(SELLER_A); // mark = 2
    await nextDiversifierIndex(SELLER_A); // mark = 3
    // A reconcile to a LOWER floor is a no-op.
    await reconcileDiversifierMark(SELLER_A, 2);
    expect(await nextDiversifierIndex(SELLER_A)).toBe(4);
  });

  it("is per-seller", async () => {
    await reconcileDiversifierMark(SELLER_A, 10);
    expect(await nextDiversifierIndex(SELLER_B)).toBe(1);
    expect(await nextDiversifierIndex(SELLER_A)).toBe(11);
  });
});
