import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { GET as listFilesRoute } from "../app/api/sellers/me/files/route";
import { createPaidLinkSellerReleaseDraft } from "../lib/paid-link-client-crypto";
import { resetRateLimitStateForTesting } from "../lib/server/rate-limit";
import {
  createSellerProfile,
  createSellerSessionToken,
  SELLER_SESSION_COOKIE,
} from "../lib/server/seller-store";
import {
  createTransferOrder,
  type TransferSeller,
} from "../lib/server/transfer-store";

const SELLER_ADDRESS = "u1selleraddr0000000000000000000000000000000000";

let runtimeDir: string;
let releaseDraft: { releaseSecretHash: string };

interface FilesEnvelope {
  files: Array<{
    orderId: string;
    fileName: string;
    displayZec: string;
    status: string;
    createdAt: string;
    sharePath: string;
  }>;
}

beforeAll(() => {
  const globalScope = globalThis as unknown as Record<string, unknown>;
  if (typeof globalScope.window === "undefined") {
    globalScope.window = {
      btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
      atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    };
  }
});

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "paidprivatefile-files-route-"));
  process.env.PAID_PRIVATE_FILE_RUNTIME_DIR = runtimeDir;
  process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS = "0";
  releaseDraft = await createPaidLinkSellerReleaseDraft(
    randomBytes(32).toString("base64"),
  );
  resetRateLimitStateForTesting();
});

afterEach(async () => {
  delete process.env.PAID_PRIVATE_FILE_RUNTIME_DIR;
  delete process.env.PAID_PRIVATE_FILE_TRUST_PROXY_HEADERS;
  await rm(runtimeDir, { recursive: true, force: true });
});

async function makeSeller(handle: string): Promise<TransferSeller> {
  const created = await createSellerProfile({
    handle,
    displayName: handle,
    defaultPayoutAddress: SELLER_ADDRESS,
  });
  return {
    sellerId: created.seller.sellerId,
    handle: created.seller.handle,
    displayName: created.seller.displayName,
  };
}

async function makeOrder(
  seller: TransferSeller,
  fileName: string,
): Promise<string> {
  const encrypted = new Uint8Array([9, 8, 7, 6]);
  const order = await createTransferOrder({
    encryptedFile: encrypted,
    fileName,
    mimeType: "application/pdf",
    originalSizeBytes: 120,
    encryptedFileSha256: createHash("sha256").update(encrypted).digest("hex"),
    encryptionIv: randomBytes(12).toString("base64"),
    releaseSecretHash: releaseDraft.releaseSecretHash,
    amountZats: 5_000_000,
    sellerPayoutAddress: SELLER_ADDRESS,
    seller,
  });
  return order.orderId;
}

function filesRequest(sellerId: string | null): Request {
  const headers: Record<string, string> = {};
  if (sellerId) {
    headers.cookie = `${SELLER_SESSION_COOKIE}=${createSellerSessionToken(sellerId)}`;
  }
  return new Request("http://localhost/api/sellers/me/files", {
    method: "GET",
    headers,
  });
}

describe("GET /api/sellers/me/files", () => {
  it("requires a seller session", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await listFilesRoute(filesRequest(null));
      expect(response.status).toBe(401);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("returns the seller's files newest first with summary fields", async () => {
    const seller = await makeSeller("files-shop");
    const first = await makeOrder(seller, "alpha.pdf");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await makeOrder(seller, "beta.pdf");

    const response = await listFilesRoute(filesRequest(seller.sellerId));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as FilesEnvelope;
    expect(parsed.files.map((file) => file.orderId)).toEqual([second, first]);

    const top = parsed.files[0];
    expect(top.fileName).toBe("beta.pdf");
    expect(top.displayZec).toBe("0.05");
    expect(top.status).toBe("created");
    expect(typeof top.createdAt).toBe("string");
    expect(top.sharePath).toBe(`/s/${seller.handle}/files/${second}`);
  });

  it("returns an empty list when the seller has no files", async () => {
    const seller = await makeSeller("empty-files-shop");
    const response = await listFilesRoute(filesRequest(seller.sellerId));
    expect(response.status).toBe(200);
    const parsed = (await response.json()) as FilesEnvelope;
    expect(parsed.files).toEqual([]);
  });

  it("does not leak buyer key material", async () => {
    const seller = await makeSeller("leak-shop");
    await makeOrder(seller, "secret.pdf");
    const response = await listFilesRoute(filesRequest(seller.sellerId));
    const text = await response.text();
    expect(text).not.toContain("buyerPublicKeyHash");
    expect(text).not.toContain("releaseSecretHash");
  });
});
