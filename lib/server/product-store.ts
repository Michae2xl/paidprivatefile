import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { ServerError } from "./error-kinds";
import { resolveWebRuntimeRoot } from "./web-session";

// Multi-buyer "product" model (Phase 1): a product is a SELLER-OWNED catalog
// entry that many buyers can purchase. Unlike a single-use transfer order (one
// link = one buyer), a product persists across sales — each future purchase
// (Phase 2) spawns its OWN order from this product. Phase 1 only builds the data
// model + create-product capability; nothing here is wired into the existing
// single-use order flow.

// "open" = unlimited supply. "limited" = a fixed number of units; once
// salesCount reaches max the product flips to "sold_out".
export type ProductSupply = { mode: "open" } | { mode: "limited"; max: number };

export type ProductStatus = "open" | "sold_out" | "closed";

export interface ProductSeller {
  sellerId: string;
  handle: string;
  displayName: string;
}

export interface Product {
  schema: "paidprivatefile.product.v1";
  productId: string;
  sellerId: string;
  seller: ProductSeller | null;
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  mimeType: string;
  originalSizeBytes: number;
  encryptedSizeBytes: number;
  encryptedFileSha256: string;
  encryption: {
    scheme: "aes-256-gcm-v1";
    iv: string;
  };
  price: {
    asset: "ZEC";
    amountZats: number;
    displayZec: string;
  };
  sellerPayoutAddress: string;
  sellerNote: string | null;
  supply: ProductSupply;
  salesCount: number;
  // The seller-held AES file-key hash — EXACTLY like an order. The plaintext key
  // never touches the server; it is only ever used (Phase 2) to wrap the key for
  // a buyer in the seller's browser.
  releaseSecretHash: string;
  manifestRoot: string;
}

// Secret-stripped projection for any buyer-facing or listing surface. NEVER
// expose releaseSecretHash or other secret material (mirrors PublicSellerProfile
// and getTransferPublicOrder).
export interface PublicProduct {
  productId: string;
  sellerId: string;
  seller: ProductSeller | null;
  status: ProductStatus;
  createdAt: string;
  updatedAt: string;
  file: {
    fileName: string;
    mimeType: string;
    originalSizeBytes: number;
    encryptedSizeBytes: number;
    encryptedFileSha256: string;
    encryptionScheme: "aes-256-gcm-v1";
    encryptionIv: string;
  };
  price: Product["price"];
  sellerPayoutAddress: string;
  sellerNote: string | null;
  supply: ProductSupply;
  salesCount: number;
  remainingSupply: number;
  soldOut: boolean;
  manifestRoot: string;
}

export interface CreateProductInput {
  encryptedFile: Uint8Array;
  fileName: string;
  mimeType: string;
  originalSizeBytes: number;
  encryptedFileSha256: string;
  encryptionIv: string;
  releaseSecretHash: string;
  amountZats: number;
  sellerPayoutAddress: string;
  sellerId: string;
  seller?: ProductSeller | null;
  sellerNote?: string | null;
  supply: ProductSupply;
}

const PRODUCT_ID_PATTERN = /^prd_[a-f0-9]{24}$/u;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_PRODUCT_BYTES = 50 * 1024 * 1024;
const locks = new Map<string, Promise<void>>();

export async function createProduct(
  input: CreateProductInput,
): Promise<Product> {
  validateCreateProductInput(input);

  const productId = createProductId();
  const createdAt = new Date().toISOString();
  const fileName = normalizeFileName(input.fileName);
  const mimeType = normalizeMimeType(input.mimeType);
  const sellerPayoutAddress = normalizeZcashUnifiedAddress(
    input.sellerPayoutAddress,
  );
  const supply = normalizeSupply(input.supply);
  const encryptedFileSha256 = sha256Hex(input.encryptedFile);
  if (encryptedFileSha256 !== input.encryptedFileSha256.toLowerCase()) {
    throw new ServerError(
      "validation",
      "Encrypted file digest did not match the uploaded payload",
    );
  }

  const manifestRoot = sha256Json({
    productId,
    fileName,
    mimeType,
    originalSizeBytes: input.originalSizeBytes,
    encryptedSizeBytes: input.encryptedFile.byteLength,
    encryptedFileSha256,
    encryptionScheme: "aes-256-gcm-v1",
    encryptionIv: input.encryptionIv,
    sellerPayoutAddress,
    amountZats: input.amountZats,
    supply,
  });

  const product: Product = {
    schema: "paidprivatefile.product.v1",
    productId,
    sellerId: input.sellerId,
    seller: normalizeSeller(input.seller),
    status: "open",
    createdAt,
    updatedAt: createdAt,
    fileName,
    mimeType,
    originalSizeBytes: input.originalSizeBytes,
    encryptedSizeBytes: input.encryptedFile.byteLength,
    encryptedFileSha256,
    encryption: {
      scheme: "aes-256-gcm-v1",
      iv: input.encryptionIv,
    },
    price: {
      asset: "ZEC",
      amountZats: input.amountZats,
      displayZec: formatZec(input.amountZats),
    },
    sellerPayoutAddress,
    sellerNote: normalizeSellerNote(input.sellerNote),
    supply,
    salesCount: 0,
    releaseSecretHash: normalizeHex(
      input.releaseSecretHash,
      64,
      "seller release secret hash",
    ),
    manifestRoot,
  };

  const dir = productDir(productId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(encryptedFilePath(productId), input.encryptedFile, {
    mode: 0o600,
  });
  await writeProduct(product);

  return product;
}

export async function getProduct(productId: string): Promise<Product> {
  return readProduct(productId);
}

export async function getPublicProduct(
  productId: string,
): Promise<PublicProduct> {
  return publicProduct(await readProduct(productId));
}

// Seller dashboard: every product created by a given seller, newest first, as
// secret-stripped public products. Low volume per shop, so a directory scan is
// acceptable here (mirrors listOrdersForSeller in transfer-store).
export async function listProductsForSeller(
  sellerId: string,
): Promise<PublicProduct[]> {
  const productsRoot = join(productRoot(), "products");
  let entries: string[];
  try {
    entries = await readdir(productsRoot);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  const products = await Promise.all(
    entries
      .filter((entry) => PRODUCT_ID_PATTERN.test(entry))
      .map(async (productId) => {
        try {
          return await readProduct(productId);
        } catch (error) {
          if (isMissingFileError(error)) {
            return null;
          }
          throw error;
        }
      }),
  );

  return products
    .filter((product): product is Product => product?.sellerId === sellerId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(publicProduct);
}

// Remaining units a product can still sell. Infinity for an open product;
// max - salesCount (never negative) for a limited one.
export function remainingSupply(product: Product): number {
  if (product.supply.mode === "open") {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, product.supply.max - product.salesCount);
}

// A product is sold out only when limited supply is exhausted. Open products are
// never sold out.
export function isSoldOut(product: Product): boolean {
  if (product.supply.mode === "open") {
    return false;
  }
  return product.salesCount >= product.supply.max;
}

// Phase 2 will call this when a buyer's purchase settles: atomically bump
// salesCount and, for a limited product, flip status to "sold_out" once the last
// unit sells. The order lock makes the last-unit increment race-safe (concurrent
// callers serialize, so we never oversell). NOT wired into any existing flow yet.
export async function recordProductSale(productId: string): Promise<Product> {
  return withProductLock(productId, async () => {
    const product = await readProduct(productId);
    if (product.status === "closed") {
      throw new ServerError("flow_conflict", "This product is closed");
    }
    if (isSoldOut(product)) {
      throw new ServerError("flow_conflict", "This product is sold out");
    }

    const now = new Date().toISOString();
    const next: Product = {
      ...product,
      salesCount: product.salesCount + 1,
      updatedAt: now,
    };
    if (next.supply.mode === "limited" && next.salesCount >= next.supply.max) {
      next.status = "sold_out";
    }
    await writeProduct(next);
    return next;
  });
}

function publicProduct(product: Product): PublicProduct {
  return {
    productId: product.productId,
    sellerId: product.sellerId,
    seller: product.seller,
    status: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    file: {
      fileName: product.fileName,
      mimeType: product.mimeType,
      originalSizeBytes: product.originalSizeBytes,
      encryptedSizeBytes: product.encryptedSizeBytes,
      encryptedFileSha256: product.encryptedFileSha256,
      encryptionScheme: product.encryption.scheme,
      encryptionIv: product.encryption.iv,
    },
    price: product.price,
    sellerPayoutAddress: product.sellerPayoutAddress,
    sellerNote: product.sellerNote,
    supply: product.supply,
    salesCount: product.salesCount,
    remainingSupply: remainingSupply(product),
    soldOut: isSoldOut(product),
    manifestRoot: product.manifestRoot,
  };
}

async function readProduct(productId: string): Promise<Product> {
  validateProductId(productId);
  try {
    const raw = await readFile(productPath(productId), "utf8");
    return normalizeStoredProduct(JSON.parse(raw) as Product);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new ServerError("validation", "Product not found");
    }
    throw error;
  }
}

function normalizeStoredProduct(product: Product): Product {
  product.supply = normalizeSupply(product.supply);
  product.salesCount = Number.isSafeInteger(product.salesCount)
    ? product.salesCount
    : 0;
  return product;
}

async function writeProduct(product: Product): Promise<void> {
  await mkdir(productDir(product.productId), { recursive: true, mode: 0o700 });
  await atomicWriteJson(productPath(product.productId), product);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

// Per-product async mutex (identical strategy to transfer-store's withOrderLock).
// Serializes mutations on a single product so the supply increment that flips a
// limited product to "sold_out" is race-safe — the last unit can never oversell.
async function withProductLock<T>(
  productId: string,
  callback: () => Promise<T>,
): Promise<T> {
  validateProductId(productId);
  const previous = locks.get(productId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queue = previous.then(() => current);
  locks.set(productId, queue);
  await previous;

  try {
    return await callback();
  } finally {
    releaseCurrent();
    if (locks.get(productId) === queue) {
      locks.delete(productId);
    }
  }
}

function validateCreateProductInput(input: CreateProductInput): void {
  if (input.encryptedFile.byteLength < 1) {
    throw new ServerError("validation", "Encrypted file is required");
  }
  if (input.encryptedFile.byteLength > MAX_PRODUCT_BYTES) {
    throw new ServerError(
      "validation",
      `Encrypted file cannot exceed ${MAX_PRODUCT_BYTES} bytes`,
    );
  }
  if (
    !Number.isSafeInteger(input.originalSizeBytes) ||
    input.originalSizeBytes < 1
  ) {
    throw new ServerError("validation", "Original file size is invalid");
  }
  if (!Number.isSafeInteger(input.amountZats) || input.amountZats < 1) {
    throw new ServerError("validation", "Amount must be at least 1 zatoshi");
  }
  if (!input.sellerId || typeof input.sellerId !== "string") {
    throw new ServerError("validation", "Product requires a seller");
  }
  normalizeZcashUnifiedAddress(input.sellerPayoutAddress);
  if (!HEX_SHA256_PATTERN.test(input.encryptedFileSha256.toLowerCase())) {
    throw new ServerError(
      "validation",
      "Encrypted file digest must be a SHA-256 hex string",
    );
  }
  decodeBase64(input.encryptionIv, 12);
  normalizeHex(input.releaseSecretHash, 64, "seller release secret hash");
  normalizeSupply(input.supply);
}

function normalizeSupply(value: ProductSupply | undefined): ProductSupply {
  if (value?.mode === "limited") {
    const max = value.max;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new ServerError(
        "validation",
        "Limited supply max must be a positive integer",
      );
    }
    return { mode: "limited", max };
  }
  if (value?.mode === "open") {
    return { mode: "open" };
  }
  throw new ServerError(
    "validation",
    "Supply mode must be 'open' or 'limited'",
  );
}

function createProductId(): string {
  return `prd_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function validateProductId(productId: string): void {
  if (!PRODUCT_ID_PATTERN.test(productId)) {
    throw new ServerError("validation", "Invalid product id");
  }
}

function normalizeFileName(value: string): string {
  const cleaned = basename(value || "private-file")
    .replace(/[ -]/gu, "")
    .trim()
    .slice(0, 160);
  return cleaned || "private-file";
}

function normalizeMimeType(value: string): string {
  const cleaned = value.trim().slice(0, 120);
  return cleaned || "application/octet-stream";
}

function normalizeZcashUnifiedAddress(value: string): string {
  const cleaned = value.trim();
  if (
    cleaned.length > 512 ||
    !/^(u1|utest|uregtest)[a-z0-9]{16,}$/iu.test(cleaned)
  ) {
    throw new ServerError(
      "validation",
      "Seller payout address must be a Zcash unified address",
    );
  }
  return cleaned;
}

function normalizeSellerNote(value: string | null | undefined): string | null {
  const cleaned = value?.trim().slice(0, 500);
  return cleaned ? cleaned : null;
}

function normalizeSeller(
  value: ProductSeller | null | undefined,
): ProductSeller | null {
  if (!value) {
    return null;
  }
  return {
    sellerId: value.sellerId,
    handle: value.handle,
    displayName: value.displayName,
  };
}

function normalizeHex(value: string, length: number, label: string): string {
  const normalized = value.trim().replace(/^0x/iu, "").toLowerCase();
  const pattern = new RegExp(`^[0-9a-f]{${length}}$`, "u");
  if (!pattern.test(normalized)) {
    throw new ServerError("validation", `Invalid ${label}`);
  }
  return normalized;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function decodeBase64(value: string, expectedLength: number): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== expectedLength) {
    throw new ServerError(
      "validation",
      `Expected base64 value with ${expectedLength} bytes`,
    );
  }
  return new Uint8Array(bytes);
}

function formatZec(amountZats: number): string {
  const whole = Math.floor(amountZats / 100_000_000);
  const fractional = String(amountZats % 100_000_000).padStart(8, "0");
  return `${whole}.${fractional}`.replace(/\.?0+$/u, "");
}

function productRoot(): string {
  return join(resolveWebRuntimeRoot(), "paid-products");
}

function productDir(productId: string): string {
  return join(productRoot(), "products", productId);
}

function productPath(productId: string): string {
  return join(productDir(productId), "product.json");
}

function encryptedFilePath(productId: string): string {
  return join(productDir(productId), "encrypted.bin");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
