// Multi-buyer "product" model (Phase 3a): best-effort IndexedDB persistence for
// the seller's PRODUCT ciphertext, keyed by productId in a separate object store.
// A product holds one self-contained ciphertext that every future purchase
// reuses, so the creating browser persists it once; Phase 3b loads it by
// productId to stream each purchase's file over Nym. Same node-env fake as the
// per-order ciphertext store test (no real IndexedDB, no polyfill dependency).

import { describe, expect, it } from "vitest";

import {
  deleteProductCiphertext,
  getProductCiphertext,
  putProductCiphertext,
} from "../lib/seller-ciphertext-store";

type Listener = (() => void) | null;

function fireSoon(getListener: () => Listener): void {
  queueMicrotask(() => {
    getListener()?.();
  });
}

class FakeRequest<T> {
  result: T | undefined;
  onsuccess: Listener = null;
  onerror: Listener = null;
  succeed(result: T): void {
    this.result = result;
    fireSoon(() => this.onsuccess);
  }
}

class FakeObjectStore {
  constructor(private readonly data: Map<string, unknown>) {}
  put(value: unknown, key: string): FakeRequest<IDBValidKey> {
    const req = new FakeRequest<IDBValidKey>();
    this.data.set(key, value);
    req.succeed(key);
    return req;
  }
  get(key: string): FakeRequest<unknown> {
    const req = new FakeRequest<unknown>();
    req.succeed(this.data.get(key));
    return req;
  }
  delete(key: string): FakeRequest<undefined> {
    const req = new FakeRequest<undefined>();
    this.data.delete(key);
    req.succeed(undefined);
    return req;
  }
}

class FakeTransaction {
  oncomplete: Listener = null;
  onerror: Listener = null;
  onabort: Listener = null;
  constructor(private readonly data: Map<string, unknown>) {}
  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this.data);
  }
}

class FakeDatabase {
  closed = false;
  // A per-store data map: the real DB isolates stores, so the fake routes each
  // store name to its own Map to prove product + order keys never collide.
  private readonly stores = new Map<string, Map<string, unknown>>();
  objectStoreNames = {
    contains: () => true,
  };
  transaction(storeName: string): FakeTransaction {
    let data = this.stores.get(storeName);
    if (!data) {
      data = new Map<string, unknown>();
      this.stores.set(storeName, data);
    }
    return new FakeTransaction(data);
  }
  createObjectStore(): void {
    // No-op: the fake store always "exists".
  }
  close(): void {
    this.closed = true;
  }
}

function makeFakeFactory(): Pick<IDBFactory, "open"> {
  const db = new FakeDatabase();
  return {
    open(): IDBOpenDBRequest {
      const req = {
        result: db,
        onsuccess: null as Listener,
        onerror: null as Listener,
        onupgradeneeded: null as Listener,
        onblocked: null as Listener,
      };
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  };
}

describe("product ciphertext store", () => {
  it("round-trips put -> get -> delete keyed by productId", async () => {
    const factory = makeFakeFactory();
    const productId = "prd_round_trip";
    const bytes = new Uint8Array([5, 6, 7, 8, 254, 255]);

    await putProductCiphertext(productId, bytes, factory);

    const loaded = await getProductCiphertext(productId, factory);
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!)).toEqual(Array.from(bytes));

    await deleteProductCiphertext(productId, factory);
    expect(await getProductCiphertext(productId, factory)).toBeNull();
  });

  it("stores an independent copy", async () => {
    const factory = makeFakeFactory();
    const bytes = new Uint8Array([1, 2, 3]);
    await putProductCiphertext("prd_copy", bytes, factory);
    bytes[0] = 99;
    const loaded = await getProductCiphertext("prd_copy", factory);
    expect(Array.from(loaded!)).toEqual([1, 2, 3]);
  });

  it("returns null for a missing product", async () => {
    const factory = makeFakeFactory();
    expect(await getProductCiphertext("prd_nope", factory)).toBeNull();
  });

  it("degrades to a no-op / null when IndexedDB is unavailable", async () => {
    await expect(
      putProductCiphertext("prd_x", new Uint8Array([1])),
    ).resolves.toBeUndefined();
    await expect(getProductCiphertext("prd_x")).resolves.toBeNull();
    await expect(deleteProductCiphertext("prd_x")).resolves.toBeUndefined();
  });
});
