// Per-order Zcash deposit-address pool for the zcash-onchain payment mode.
//
// The local watcher/wallet (next to the user's Zallet wallet) registers a batch
// of unique Unified Addresses ahead of time. Each new payment intent pops one
// free address and binds it to the order, so the buyer pays into an order-unique
// address and the watcher can map an incoming deposit back to a single order.
//
// Persistence mirrors transfer-store: atomic temp-file writes under
// PAID_PRIVATE_FILE_RUNTIME_DIR, guarded by an in-process lock.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ServerError } from "./error-kinds";
import { resolveWebRuntimeRoot } from "./web-session";

interface DepositPoolEntry {
  address: string;
  status: "available" | "assigned";
  orderId: string | null;
  registeredAt: string;
  assignedAt: string | null;
}

interface DepositPoolFile {
  schema: "paidprivatefile.deposit-pool.v1";
  entries: DepositPoolEntry[];
}

const UNIFIED_ADDRESS_PATTERN = /^(u1|utest|uregtest)[a-z0-9]{16,}$/iu;
const MAX_ADDRESS_LENGTH = 512;
const MAX_BATCH = 1_000;

let poolLock: Promise<void> = Promise.resolve();

export async function registerDepositAddresses(
  addresses: string[],
): Promise<{ added: number; total: number }> {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new ServerError(
      "validation",
      "At least one deposit address is required",
    );
  }
  if (addresses.length > MAX_BATCH) {
    throw new ServerError(
      "validation",
      `Cannot register more than ${MAX_BATCH} deposit addresses at once`,
    );
  }

  const normalized = addresses.map(normalizeDepositAddress);

  return withPoolLock(async () => {
    const pool = await readPool();
    const known = new Set(pool.entries.map((entry) => entry.address));
    const now = new Date().toISOString();
    let added = 0;

    for (const address of normalized) {
      if (known.has(address)) {
        continue;
      }
      known.add(address);
      pool.entries.push({
        address,
        status: "available",
        orderId: null,
        registeredAt: now,
        assignedAt: null,
      });
      added += 1;
    }

    if (added > 0) {
      await writePool(pool);
    }

    return { added, total: pool.entries.length };
  });
}

export async function assignDepositAddress(
  orderId: string,
): Promise<string | null> {
  return withPoolLock(async () => {
    const pool = await readPool();

    const existing = pool.entries.find(
      (entry) => entry.status === "assigned" && entry.orderId === orderId,
    );
    if (existing) {
      return existing.address;
    }

    const free = pool.entries.find((entry) => entry.status === "available");
    if (!free) {
      return null;
    }

    free.status = "assigned";
    free.orderId = orderId;
    free.assignedAt = new Date().toISOString();
    await writePool(pool);
    return free.address;
  });
}

export async function findOrderIdByDepositAddress(
  address: string,
): Promise<string | null> {
  const normalized = address.trim();
  const pool = await readPool();
  const entry = pool.entries.find(
    (candidate) => candidate.address === normalized,
  );
  return entry?.orderId ?? null;
}

function normalizeDepositAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw new ServerError("validation", "Deposit address must be a string");
  }
  const cleaned = value.trim();
  if (
    cleaned.length > MAX_ADDRESS_LENGTH ||
    !UNIFIED_ADDRESS_PATTERN.test(cleaned)
  ) {
    throw new ServerError(
      "validation",
      "Deposit address must be a Zcash unified address",
    );
  }
  return cleaned;
}

async function readPool(): Promise<DepositPoolFile> {
  try {
    const raw = await readFile(poolPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DepositPoolFile>;
    return {
      schema: "paidprivatefile.deposit-pool.v1",
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { schema: "paidprivatefile.deposit-pool.v1", entries: [] };
    }
    throw error;
  }
}

async function writePool(pool: DepositPoolFile): Promise<void> {
  await mkdir(poolDir(), { recursive: true, mode: 0o700 });
  const path = poolPath();
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(pool, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

async function withPoolLock<T>(callback: () => Promise<T>): Promise<T> {
  const previous = poolLock;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  poolLock = previous.then(() => current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function poolDir(): string {
  return join(resolveWebRuntimeRoot(), "paid-transfers", "deposit-pool");
}

function poolPath(): string {
  return join(poolDir(), "pool.json");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
