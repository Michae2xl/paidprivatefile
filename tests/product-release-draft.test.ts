// Multi-buyer "product" model (Phase 3a): the seller's PRODUCT release draft is
// browser-local (localStorage), keyed by productId, with the SAME shape as the
// per-order draft. Phase 3b loads it by productId to wrap the product's fileKey
// for each buyer of that product. These tests prove the productId-keyed
// round-trip and that it never collides with the per-order draft namespace.

import { randomBytes } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPaidLinkSellerReleaseDraft,
  loadProductReleaseDraft,
  loadSellerReleaseDraft,
  saveProductReleaseDraft,
  saveSellerReleaseDraft,
} from "../lib/paid-link-client-crypto";

// Minimal localStorage + base64 shim for the node test env. The crypto helpers
// only touch window.localStorage get/set/remove and window.btoa/atob.
beforeAll(() => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
  const globalScope = globalThis as unknown as Record<string, unknown>;
  globalScope.window = {
    localStorage,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
  };
});

beforeEach(() => {
  (
    globalThis as unknown as { window: { localStorage: { clear: () => void } } }
  ).window.localStorage.clear();
});

describe("product release draft (localStorage, keyed by productId)", () => {
  it("round-trips save -> load", async () => {
    const draft = await createPaidLinkSellerReleaseDraft(
      randomBytes(32).toString("base64"),
    );
    saveProductReleaseDraft("prd_abc123", draft);

    const loaded = loadProductReleaseDraft("prd_abc123");
    expect(loaded).not.toBeNull();
    expect(loaded!.fileKey).toBe(draft.fileKey);
    expect(loaded!.releaseSecret).toBe(draft.releaseSecret);
    expect(loaded!.releaseSecretHash).toBe(draft.releaseSecretHash);
  });

  it("returns null for an unknown productId", () => {
    expect(loadProductReleaseDraft("prd_missing")).toBeNull();
  });

  it("does not collide with the per-order release draft namespace", async () => {
    const productDraft = await createPaidLinkSellerReleaseDraft(
      randomBytes(32).toString("base64"),
    );
    const orderDraft = await createPaidLinkSellerReleaseDraft(
      randomBytes(32).toString("base64"),
    );
    // Same id string used for BOTH an order and a product to prove the key
    // namespaces are distinct.
    saveProductReleaseDraft("shared-id", productDraft);
    saveSellerReleaseDraft("shared-id", orderDraft);

    expect(loadProductReleaseDraft("shared-id")!.fileKey).toBe(
      productDraft.fileKey,
    );
    expect(loadSellerReleaseDraft("shared-id")!.fileKey).toBe(
      orderDraft.fileKey,
    );
    expect(productDraft.fileKey).not.toBe(orderDraft.fileKey);
  });
});
