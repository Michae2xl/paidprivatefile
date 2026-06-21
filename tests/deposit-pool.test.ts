import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assignDepositAddress,
  findOrderIdByDepositAddress,
  listAssignedDepositAddresses,
  registerDepositAddresses,
} from "../lib/server/deposit-pool";

let runtimeDir: string;

const ORDER_A = "pl_aaaaaaaaaaaaaaaaaaaaaaaa";
const ORDER_B = "pl_bbbbbbbbbbbbbbbbbbbbbbbb";

const ADDRESS_A = "u1depositaddressaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDRESS_B = "u1depositaddressbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADDRESS_C = "utest1depositaddressccccccccccccccccccccccccccccccc";

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-pool-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  await rm(runtimeDir, { recursive: true, force: true });
});

describe("deposit pool", () => {
  it("registers valid unified addresses and dedupes", async () => {
    const first = await registerDepositAddresses([ADDRESS_A, ADDRESS_B]);
    expect(first.added).toBe(2);
    expect(first.total).toBe(2);

    // Re-registering an existing one plus a new one only adds the new one.
    const second = await registerDepositAddresses([ADDRESS_A, ADDRESS_C]);
    expect(second.added).toBe(1);
    expect(second.total).toBe(3);
  });

  it("rejects an invalid address", async () => {
    await expect(
      registerDepositAddresses([ADDRESS_A, "not-a-zcash-address"]),
    ).rejects.toThrow();
  });

  it("assigns a free address to an order and is idempotent", async () => {
    await registerDepositAddresses([ADDRESS_A]);
    const assigned = await assignDepositAddress(ORDER_A);
    expect(assigned).toBe(ADDRESS_A);

    // The same order asking again gets the same address (no double pop).
    const again = await assignDepositAddress(ORDER_A);
    expect(again).toBe(ADDRESS_A);

    expect(await findOrderIdByDepositAddress(ADDRESS_A)).toBe(ORDER_A);
  });

  it("gives different orders different addresses and exhausts the pool", async () => {
    await registerDepositAddresses([ADDRESS_A, ADDRESS_B]);
    const a = await assignDepositAddress(ORDER_A);
    const b = await assignDepositAddress(ORDER_B);
    expect(a).not.toBe(b);
    expect([a, b].sort()).toEqual([ADDRESS_A, ADDRESS_B].sort());

    // Pool empty now.
    const none = await assignDepositAddress("pl_cccccccccccccccccccccccc");
    expect(none).toBeNull();
  });

  it("returns null lookup for an unknown deposit address", async () => {
    expect(await findOrderIdByDepositAddress(ADDRESS_C)).toBeNull();
  });

  it("lists only the deposit addresses currently assigned to an order", async () => {
    await registerDepositAddresses([ADDRESS_A, ADDRESS_B, ADDRESS_C]);

    // Nothing assigned yet.
    expect(await listAssignedDepositAddresses()).toEqual([]);

    await assignDepositAddress(ORDER_A);
    await assignDepositAddress(ORDER_B);

    const assigned = await listAssignedDepositAddresses();
    // Two of the three are assigned; the never-assigned one is excluded.
    expect(assigned).toHaveLength(2);
    expect(assigned.sort()).toEqual([ADDRESS_A, ADDRESS_B].sort());
    expect(assigned).not.toContain(ADDRESS_C);
  });

  it("returns an empty list when no addresses are registered", async () => {
    expect(await listAssignedDepositAddresses()).toEqual([]);
  });
});
