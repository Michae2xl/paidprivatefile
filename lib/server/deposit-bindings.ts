// Per-order deposit-address BINDING store for the non-custodial marketplace
// (Phase 1). Unlike the global pre-registered pool (deposit-pool.ts, kept
// intact), here each order's address is derived on demand from the seller's
// UFVK. We persist:
//   - bindings: address -> { orderId, sellerId, diversifierIndex, startHeight }
//   - per-seller diversifier high-water mark (monotonic, crash-safe, and
//     collision-free across concurrent orders via the in-process lock).
//
// Persistence mirrors transfer-store: atomic temp-file writes under
// PAID_PRIVATE_FILE_RUNTIME_DIR, guarded by an in-process lock.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ServerError } from "./error-kinds";
import { resolveWebRuntimeRoot } from "./web-session";

export interface DepositBinding {
  orderId: string;
  address: string;
  sellerId: string;
  diversifierIndex: number;
  startHeight: number;
  boundAt: string;
}

interface BindingsFile {
  schema: "paidprivatefile.deposit-bindings.v1";
  bindings: DepositBinding[];
}

interface DiversifierFile {
  schema: "paidprivatefile.diversifier-marks.v1";
  marks: Record<string, number>;
}

const ORDER_ID_PATTERN = /^pl_[a-f0-9]{24}$/u;
const SELLER_ID_PATTERN = /^sel_[a-f0-9]{24}$/u;
const UNIFIED_ADDRESS_PATTERN = /^(u1|utest|uregtest)[a-z0-9]{16,}$/iu;
const MAX_ADDRESS_LENGTH = 512;

let bindingsLock: Promise<void> = Promise.resolve();
let diversifierLock: Promise<void> = Promise.resolve();

// Thrown when an address is already bound to a DIFFERENT order — a derivation
// collision that, if silently bound, would misattribute a buyer's real ZEC to
// another order (paid, no file, no refund). The caller rederives at a higher
// diversifier index on this error.
export class DepositAddressCollisionError extends Error {
  readonly code = "DEPOSIT_ADDRESS_COLLISION";
  constructor(
    readonly address: string,
    readonly existingOrderId: string,
  ) {
    super("Deposit address already bound to another order");
    this.name = "DepositAddressCollisionError";
  }
}

export function isDepositAddressCollision(error: unknown): boolean {
  return error instanceof DepositAddressCollisionError;
}

export async function bindOrderDeposit(
  orderId: string,
  input: {
    address: string;
    sellerId: string;
    diversifierIndex: number;
    startHeight: number;
  },
): Promise<DepositBinding> {
  validateOrderId(orderId);
  validateSellerId(input.sellerId);
  const address = normalizeAddress(input.address);
  const diversifierIndex = requireNonNegativeInteger(
    input.diversifierIndex,
    "diversifierIndex",
  );
  const startHeight = requireNonNegativeInteger(
    input.startHeight,
    "startHeight",
  );

  return withBindingsLock(async () => {
    const file = await readBindings();
    const existing = file.bindings.find((entry) => entry.orderId === orderId);
    if (existing) {
      // Idempotent: the same order keeps its first binding.
      return existing;
    }
    // Uniqueness guard: never bind one address to two orders. A diversifier
    // collision would otherwise be bound silently and the deposit webhook would
    // credit only the FIRST order — the other buyer pays with no file/refund.
    const addressClash = file.bindings.find(
      (entry) => entry.address === address,
    );
    if (addressClash) {
      throw new DepositAddressCollisionError(address, addressClash.orderId);
    }
    const binding: DepositBinding = {
      orderId,
      address,
      sellerId: input.sellerId,
      diversifierIndex,
      startHeight,
      boundAt: new Date().toISOString(),
    };
    const next: BindingsFile = {
      schema: "paidprivatefile.deposit-bindings.v1",
      bindings: [...file.bindings, binding],
    };
    await writeBindings(next);
    return binding;
  });
}

export async function findBindingByAddress(
  address: string,
): Promise<DepositBinding | null> {
  const normalized = address.trim();
  const file = await readBindings();
  return file.bindings.find((entry) => entry.address === normalized) ?? null;
}

export async function findOrderIdByBoundAddress(
  address: string,
): Promise<string | null> {
  const binding = await findBindingByAddress(address);
  return binding?.orderId ?? null;
}

export async function findBindingByOrderId(
  orderId: string,
): Promise<DepositBinding | null> {
  const file = await readBindings();
  return file.bindings.find((entry) => entry.orderId === orderId) ?? null;
}

export async function listBoundOrderIds(): Promise<string[]> {
  const file = await readBindings();
  return file.bindings.map((entry) => entry.orderId);
}

export async function listBindings(): Promise<DepositBinding[]> {
  const file = await readBindings();
  return [...file.bindings];
}

// Monotonic per-seller high-water mark. Crash-safe (persisted before returning)
// and collision-free under concurrency (serialized by the in-process lock).
export async function nextDiversifierIndex(sellerId: string): Promise<number> {
  validateSellerId(sellerId);
  return withDiversifierLock(async () => {
    const file = await readDiversifiers();
    const current = file.marks[sellerId] ?? 0;
    const next = current + 1;
    const updated: DiversifierFile = {
      schema: "paidprivatefile.diversifier-marks.v1",
      marks: { ...file.marks, [sellerId]: next },
    };
    await writeDiversifiers(updated);
    return next;
  });
}

// Advance the per-seller high-water mark to AT LEAST `atLeastNext`. The scanner
// returns the next VALID diversified address at/after the requested index, so the
// actual index used is frequently GREATER than requested (Sapling diversifiers
// are valid only ~half the time). Reconciling the mark to actualIndex+1 after
// each derivation stops a later order from requesting an index that re-derives a
// prior order's address (which would misattribute that buyer's payment).
// Monotonic + idempotent: never lowers the mark.
export async function reconcileDiversifierMark(
  sellerId: string,
  atLeastNext: number,
): Promise<void> {
  validateSellerId(sellerId);
  const floor = requireNonNegativeInteger(atLeastNext, "atLeastNext");
  await withDiversifierLock(async () => {
    const file = await readDiversifiers();
    const current = file.marks[sellerId] ?? 0;
    if (current >= floor) {
      return;
    }
    await writeDiversifiers({
      schema: "paidprivatefile.diversifier-marks.v1",
      marks: { ...file.marks, [sellerId]: floor },
    });
  });
}

function normalizeAddress(value: unknown): string {
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

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ServerError(
      "validation",
      `${label} must be a non-negative integer`,
    );
  }
  return value;
}

function validateOrderId(orderId: string): void {
  if (!ORDER_ID_PATTERN.test(orderId)) {
    throw new ServerError("validation", "Invalid paid link id");
  }
}

function validateSellerId(sellerId: string): void {
  if (!SELLER_ID_PATTERN.test(sellerId)) {
    throw new ServerError("validation", "Invalid seller id");
  }
}

async function readBindings(): Promise<BindingsFile> {
  try {
    const raw = await readFile(bindingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<BindingsFile>;
    return {
      schema: "paidprivatefile.deposit-bindings.v1",
      bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        schema: "paidprivatefile.deposit-bindings.v1",
        bindings: [],
      };
    }
    throw error;
  }
}

async function writeBindings(file: BindingsFile): Promise<void> {
  await atomicWriteJson(bindingsPath(), file);
}

async function readDiversifiers(): Promise<DiversifierFile> {
  try {
    const raw = await readFile(diversifierPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DiversifierFile>;
    const marks =
      parsed.marks &&
      typeof parsed.marks === "object" &&
      !Array.isArray(parsed.marks)
        ? (parsed.marks as Record<string, number>)
        : {};
    return { schema: "paidprivatefile.diversifier-marks.v1", marks };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { schema: "paidprivatefile.diversifier-marks.v1", marks: {} };
    }
    throw error;
  }
}

async function writeDiversifiers(file: DiversifierFile): Promise<void> {
  await atomicWriteJson(diversifierPath(), file);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(bindingsDir(), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

async function withBindingsLock<T>(callback: () => Promise<T>): Promise<T> {
  const previous = bindingsLock;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  bindingsLock = previous.then(() => current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

async function withDiversifierLock<T>(callback: () => Promise<T>): Promise<T> {
  const previous = diversifierLock;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  diversifierLock = previous.then(() => current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function bindingsDir(): string {
  return join(resolveWebRuntimeRoot(), "paid-transfers", "deposit-bindings");
}

function bindingsPath(): string {
  return join(bindingsDir(), "bindings.json");
}

function diversifierPath(): string {
  return join(bindingsDir(), "diversifier-marks.json");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
