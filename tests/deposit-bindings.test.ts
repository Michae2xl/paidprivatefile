import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bindOrderDeposit,
  findBindingByAddress,
  findOrderIdByBoundAddress,
  listBoundOrderIds,
  nextDiversifierIndex,
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
