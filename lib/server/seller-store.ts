import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ServerError } from "./error-kinds";
import {
  getScannerClient,
  type ScannerClient,
  type ScannerNetwork,
} from "./scanner-client";
import { resolveWebRuntimeRoot } from "./web-session";

export const SELLER_SESSION_COOKIE = "paidprivatefile_seller";

// Schema v2 adds the optional UFVK fields for the non-custodial marketplace.
// v1 profiles are still readable (the UFVK fields are simply absent), so the
// existing single-seller / global-pool flow keeps working untouched.
export type SellerSchema =
  | "paidprivatefile.seller.v1"
  | "paidprivatefile.seller.v2";

export interface SellerProfile {
  schema: SellerSchema;
  sellerId: string;
  handle: string;
  displayName: string;
  defaultPayoutAddress: string;
  accessKeyHash: string;
  createdAt: string;
  updatedAt: string;
  // Non-custodial marketplace. All optional for back-compat.
  // Phase 3: the UFVK lives ONLY on the scanner host; the app keeps an opaque
  // handle. `ufvkEncrypted` is the deprecated Phase-1 field (no longer written).
  sellerScanRef?: string;
  ufvkEncrypted?: string;
  // sha256 hex of the UFVK; safe to expose (mirrors how a fingerprint is safe).
  ufvkFingerprint?: string;
  network?: ScannerNetwork;
}

export interface PublicSellerProfile {
  sellerId: string;
  handle: string;
  displayName: string;
  defaultPayoutAddress: string;
  publicPath: string;
  createdAt: string;
  updatedAt: string;
  // Only the fingerprint is exposed publicly; never the UFVK itself.
  ufvkFingerprint?: string;
  network?: ScannerNetwork;
}

export interface RegisterSellerUfvkResult {
  ufvkFingerprint: string;
  network: ScannerNetwork;
  defaultAddress: string;
}

export interface CreateSellerResult {
  seller: PublicSellerProfile;
  accessKey: string;
}

const SELLER_ID_PATTERN = /^sel_[a-f0-9]{24}$/u;
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/u;
const ZCASH_UNIFIED_ADDRESS_PATTERN = /^(u1|utest|uregtest)[a-z0-9]{16,}$/iu;
const RESERVED_HANDLES = new Set([
  "admin",
  "api",
  "files",
  "login",
  "new",
  "paid-private-file",
  "settings",
]);
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export async function createSellerProfile(
  input: {
    handle: string;
    displayName?: string | null;
    // Either a viewing key (preferred, non-custodial) or an explicit payout
    // address must be provided. When a UFVK is given, the receiving address is
    // DERIVED from it — the seller never pastes a separate wallet.
    defaultPayoutAddress?: string | null;
    ufvk?: string | null;
    ua?: string | null;
  },
  scanner: ScannerClient = getScannerClient(),
): Promise<CreateSellerResult> {
  const handle = normalizeSellerHandle(input.handle);
  const displayName = normalizeDisplayName(input.displayName, handle);
  if (await findSellerIdByHandle(handle)) {
    throw new ServerError("flow_conflict", "Seller handle is already taken");
  }

  let defaultPayoutAddress: string;
  let sellerScanRef: SellerProfile["sellerScanRef"];
  let ufvkFingerprint: SellerProfile["ufvkFingerprint"];
  let network: SellerProfile["network"];

  const ufvkInput = input.ufvk?.trim();
  if (ufvkInput) {
    // Non-custodial (Phase 3): the scanner validates AND stores the viewing key
    // on its own host; the app keeps only an opaque scanRef + derived address.
    const ufvk = normalizeUfvk(ufvkInput);
    const ua = input.ua ? normalizeZcashUnifiedAddress(input.ua) : undefined;
    const reg = await scanner.registerUfvk(ua ? { ufvk, ua } : { ufvk });
    if (reg.network !== "main") {
      throw new ServerError(
        "validation",
        "Only mainnet viewing keys are accepted",
      );
    }
    defaultPayoutAddress = normalizeZcashUnifiedAddress(
      ua ?? reg.defaultAddress,
    );
    sellerScanRef = reg.scanRef;
    ufvkFingerprint = reg.fingerprint;
    network = reg.network;
  } else if (input.defaultPayoutAddress) {
    defaultPayoutAddress = normalizeZcashUnifiedAddress(
      input.defaultPayoutAddress,
    );
  } else {
    throw new ServerError(
      "validation",
      "A shop viewing key (UFVK) or payout address is required",
    );
  }

  const sellerId = createSellerId();
  const accessKey = generateAccessKey();
  const now = new Date().toISOString();
  const profile: SellerProfile = {
    schema: sellerScanRef
      ? "paidprivatefile.seller.v2"
      : "paidprivatefile.seller.v1",
    sellerId,
    handle,
    displayName,
    defaultPayoutAddress,
    accessKeyHash: hashAccessKey(accessKey),
    createdAt: now,
    updatedAt: now,
    ...(sellerScanRef ? { sellerScanRef, ufvkFingerprint, network } : {}),
  };

  await mkdir(sellerProfileDir(), { recursive: true, mode: 0o700 });
  await mkdir(sellerHandleIndexDir(), { recursive: true, mode: 0o700 });
  await atomicWriteJson(sellerProfilePath(sellerId), profile);
  await atomicWriteJson(sellerHandleIndexPath(handle), { sellerId });

  return { seller: publicSeller(profile), accessKey };
}

export async function authenticateSeller(input: {
  handle: string;
  accessKey: string;
}): Promise<PublicSellerProfile> {
  const handle = normalizeSellerHandle(input.handle);
  const profile = await getSellerProfileByHandle(handle);
  if (
    !profile ||
    !safeEqual(profile.accessKeyHash, hashAccessKey(input.accessKey))
  ) {
    throw new ServerError(
      "auth_required",
      "Invalid seller handle or access key",
    );
  }
  return publicSeller(profile);
}

export async function getSellerProfileByHandle(
  handle: string,
): Promise<SellerProfile | null> {
  const sellerId = await findSellerIdByHandle(normalizeSellerHandle(handle));
  return sellerId ? getSellerProfileById(sellerId) : null;
}

export async function getPublicSellerProfileByHandle(
  handle: string,
): Promise<PublicSellerProfile | null> {
  const profile = await getSellerProfileByHandle(handle);
  return profile ? publicSeller(profile) : null;
}

export async function getSellerProfileById(
  sellerId: string,
): Promise<SellerProfile | null> {
  validateSellerId(sellerId);
  try {
    const parsed = JSON.parse(
      await readFile(sellerProfilePath(sellerId), "utf8"),
    ) as SellerProfile;
    return normalizeSellerProfile(parsed);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

export async function updateSellerProfile(
  sellerId: string,
  input: {
    displayName?: string | null;
    defaultPayoutAddress?: string | null;
  },
): Promise<PublicSellerProfile> {
  const profile = await getSellerProfileById(sellerId);
  if (!profile) {
    throw new ServerError("auth_required", "Seller session is invalid");
  }
  if (input.displayName !== undefined) {
    profile.displayName = normalizeDisplayName(
      input.displayName,
      profile.handle,
    );
  }
  if (input.defaultPayoutAddress !== undefined) {
    profile.defaultPayoutAddress = normalizeZcashUnifiedAddress(
      input.defaultPayoutAddress ?? "",
    );
  }
  profile.updatedAt = new Date().toISOString();
  await atomicWriteJson(sellerProfilePath(profile.sellerId), profile);
  return publicSeller(profile);
}

// Non-custodial marketplace (Phase 1): register a seller's pasted viewing key
// (UFVK), optionally bound to a UA. The scanner validates it; we reject
// invalid / non-mainnet keys and non-matching UAs, then store the UFVK
// encrypted at rest and keep only the fingerprint exposable.
export async function registerSellerUfvk(
  sellerId: string,
  input: { ufvk: string; ua?: string | null },
  scanner: ScannerClient = getScannerClient(),
): Promise<RegisterSellerUfvkResult> {
  const profile = await getSellerProfileById(sellerId);
  if (!profile) {
    throw new ServerError("auth_required", "Seller session is invalid");
  }
  const ufvk = normalizeUfvk(input.ufvk);
  const ua = input.ua ? normalizeZcashUnifiedAddress(input.ua) : undefined;

  // Phase 3: the scanner validates AND stores the UFVK on its own host; the app
  // keeps only an opaque scanRef + fingerprint.
  const reg = await scanner.registerUfvk(ua ? { ufvk, ua } : { ufvk });
  if (reg.network !== "main") {
    throw new ServerError(
      "validation",
      "Only mainnet viewing keys are accepted",
    );
  }

  const now = new Date().toISOString();
  const next: SellerProfile = {
    ...profile,
    schema: "paidprivatefile.seller.v2",
    sellerScanRef: reg.scanRef,
    // Drop any deprecated Phase-1 encrypted blob on re-registration.
    ufvkEncrypted: undefined,
    ufvkFingerprint: reg.fingerprint,
    network: reg.network,
    updatedAt: now,
  };
  await atomicWriteJson(sellerProfilePath(next.sellerId), next);

  return {
    ufvkFingerprint: reg.fingerprint,
    network: reg.network,
    defaultAddress: reg.defaultAddress,
  };
}

// Internal use only (scan-watchlist / derive): the opaque handle the scanner
// uses to look up the stored UFVK. The app never holds the viewing key (Phase 3).
export async function getSellerScanRef(
  sellerId: string,
): Promise<string | null> {
  const profile = await getSellerProfileById(sellerId);
  return profile?.sellerScanRef ?? null;
}

export async function getSellerFromRequest(
  request: Request,
): Promise<PublicSellerProfile | null> {
  const token = readCookieValue(
    request.headers.get("cookie"),
    SELLER_SESSION_COOKIE,
  );
  const payload = verifySellerSessionToken(token);
  if (!payload) {
    return null;
  }
  const profile = await getSellerProfileById(payload.sellerId);
  return profile ? publicSeller(profile) : null;
}

export async function requireSellerFromRequest(
  request: Request,
): Promise<PublicSellerProfile> {
  const seller = await getSellerFromRequest(request);
  if (!seller) {
    throw new ServerError("auth_required", "Seller login is required");
  }
  return seller;
}

export function createSellerSessionToken(sellerId: string): string {
  validateSellerId(sellerId);
  const payload = Buffer.from(
    JSON.stringify({
      sellerId,
      exp: Date.now() + SESSION_TTL_MS,
      nonce: randomBytes(12).toString("base64url"),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", sellerAuthSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function normalizeSellerHandle(value: string): string {
  const handle = value.trim().toLowerCase();
  if (!HANDLE_PATTERN.test(handle) || RESERVED_HANDLES.has(handle)) {
    throw new ServerError(
      "validation",
      "Seller handle must be 3-32 lowercase letters, numbers, or hyphens",
    );
  }
  return handle;
}

export function publicSeller(profile: SellerProfile): PublicSellerProfile {
  // NEVER include ufvkEncrypted here (mirrors accessKeyHash stripping). Only the
  // fingerprint and network are safe to expose.
  const result: PublicSellerProfile = {
    sellerId: profile.sellerId,
    handle: profile.handle,
    displayName: profile.displayName,
    defaultPayoutAddress: profile.defaultPayoutAddress,
    publicPath: `/s/${profile.handle}`,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
  if (profile.ufvkFingerprint) {
    result.ufvkFingerprint = profile.ufvkFingerprint;
  }
  if (profile.network) {
    result.network = profile.network;
  }
  return result;
}

async function findSellerIdByHandle(handle: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await readFile(sellerHandleIndexPath(handle), "utf8"),
    ) as { sellerId?: unknown };
    return typeof parsed.sellerId === "string" ? parsed.sellerId : null;
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function verifySellerSessionToken(
  token: string | null,
): { sellerId: string; exp: number } | null {
  if (!token) {
    return null;
  }
  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }
  const expected = createHmac("sha256", sellerAuthSecret())
    .update(payload)
    .digest("base64url");
  if (!safeEqual(signature, expected)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sellerId" in parsed) ||
    !("exp" in parsed) ||
    typeof parsed.sellerId !== "string" ||
    typeof parsed.exp !== "number" ||
    parsed.exp < Date.now()
  ) {
    return null;
  }
  validateSellerId(parsed.sellerId);
  return { sellerId: parsed.sellerId, exp: parsed.exp };
}

function normalizeSellerProfile(value: SellerProfile): SellerProfile {
  const hasScanRef =
    typeof value.sellerScanRef === "string" && value.sellerScanRef.length > 0;
  const hasUfvk =
    typeof value.ufvkEncrypted === "string" && value.ufvkEncrypted.length > 0;
  const profile: SellerProfile = {
    schema:
      hasScanRef || hasUfvk
        ? "paidprivatefile.seller.v2"
        : (value.schema ?? "paidprivatefile.seller.v1"),
    sellerId: value.sellerId,
    handle: normalizeSellerHandle(value.handle),
    displayName: normalizeDisplayName(value.displayName, value.handle),
    defaultPayoutAddress: normalizeZcashUnifiedAddress(
      value.defaultPayoutAddress,
    ),
    accessKeyHash: value.accessKeyHash,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (hasScanRef) {
    profile.sellerScanRef = value.sellerScanRef;
  }
  if (hasUfvk) {
    profile.ufvkEncrypted = value.ufvkEncrypted;
  }
  if (typeof value.ufvkFingerprint === "string" && value.ufvkFingerprint) {
    profile.ufvkFingerprint = value.ufvkFingerprint;
  }
  if (
    value.network === "main" ||
    value.network === "test" ||
    value.network === "regtest"
  ) {
    profile.network = value.network;
  }
  return profile;
}

function normalizeDisplayName(
  value: string | null | undefined,
  fallback: string,
): string {
  const cleaned = value?.trim().replace(/\s+/gu, " ").slice(0, 80);
  return cleaned || fallback;
}

function normalizeZcashUnifiedAddress(value: string): string {
  const cleaned = value.trim();
  if (cleaned.length > 512 || !ZCASH_UNIFIED_ADDRESS_PATTERN.test(cleaned)) {
    throw new ServerError(
      "validation",
      "Seller payout address must be a Zcash unified address",
    );
  }
  return cleaned;
}

function createSellerId(): string {
  return `sel_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function validateSellerId(sellerId: string): void {
  if (!SELLER_ID_PATTERN.test(sellerId)) {
    throw new ServerError("validation", "Invalid seller id");
  }
}

function generateAccessKey(): string {
  return `ppf_${randomBytes(24).toString("base64url")}`;
}

function hashAccessKey(accessKey: string): string {
  return createHash("sha256").update(accessKey).digest("hex");
}

const UFVK_PATTERN = /^uview1[a-z0-9]{16,}$/iu;
const MAX_UFVK_LENGTH = 4096;

function normalizeUfvk(value: unknown): string {
  if (typeof value !== "string") {
    throw new ServerError("validation", "Viewing key (UFVK) must be a string");
  }
  const cleaned = value.trim();
  if (cleaned.length > MAX_UFVK_LENGTH || !UFVK_PATTERN.test(cleaned)) {
    throw new ServerError(
      "validation",
      "Viewing key must be a Zcash unified full viewing key (uview1...)",
    );
  }
  return cleaned;
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, path);
}

function sellerAuthSecret(): string {
  return (
    process.env.PAID_PRIVATE_FILE_AUTH_SECRET ??
    process.env.PAID_PRIVATE_FILE_TRANSFER_TOKEN_SECRET ??
    process.env.ZECTIME_TRANSFER_TOKEN_SECRET ??
    "paidprivatefile-dev-auth-secret"
  );
}

function sellerRoot(): string {
  return join(resolveWebRuntimeRoot(), "seller-workspaces");
}

function sellerProfileDir(): string {
  return join(sellerRoot(), "profiles");
}

function sellerProfilePath(sellerId: string): string {
  return join(sellerProfileDir(), `${sellerId}.json`);
}

function sellerHandleIndexDir(): string {
  return join(sellerRoot(), "handle-index");
}

function sellerHandleIndexPath(handle: string): string {
  return join(sellerHandleIndexDir(), `${handle}.json`);
}

function readCookieValue(
  cookieHeader: string | null,
  cookieName: string,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const entry of cookieHeader.split(/;\s*/u)) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    if (entry.slice(0, separatorIndex) === cookieName) {
      return entry.slice(separatorIndex + 1);
    }
  }
  return null;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
