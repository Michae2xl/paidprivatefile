// FIX 3: best-effort IndexedDB persistence for the seller's ciphertext so the
// file can still be delivered over Nym after a reload / in a later session.
//
// The vitest environment is "node" (no real IndexedDB), and we deliberately do
// NOT add a polyfill dependency. The store accepts an injectable IndexedDB
// factory; here we drive it with a tiny in-memory fake that mimics the async
// request/transaction surface the store uses (open -> onsuccess, transaction ->
// objectStore -> put/get/delete requests). This proves the put/get/delete
// round-trip and the graceful no-IndexedDB degradation without a real browser.

import { describe, expect, it } from "vitest";

import {
  deleteSellerCiphertext,
  getSellerCiphertext,
  putSellerCiphertext,
} from "../lib/seller-ciphertext-store";

// --- Minimal in-memory IndexedDB fake -------------------------------------
// Only the pieces lib/seller-ciphertext-store.ts touches are implemented. All
// success/error callbacks fire on a microtask so the wrapper's Promise plumbing
// behaves like the real async API.

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
  objectStoreNames = {
    contains: () => true,
  };
  constructor(private readonly data: Map<string, unknown>) {}
  transaction(): FakeTransaction {
    return new FakeTransaction(this.data);
  }
  createObjectStore(): void {
    // No-op: the fake store always "exists".
  }
  close(): void {
    this.closed = true;
  }
}

class FakeOpenRequest {
  result!: FakeDatabase;
  onsuccess: Listener = null;
  onerror: Listener = null;
  onupgradeneeded: Listener = null;
  onblocked: Listener = null;
}

function makeFakeFactory(): Pick<IDBFactory, "open"> {
  const data = new Map<string, unknown>();
  return {
    open(): IDBOpenDBRequest {
      const req = new FakeOpenRequest();
      req.result = new FakeDatabase(data);
      queueMicrotask(() => {
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req as unknown as IDBOpenDBRequest;
    },
  };
}

describe("seller-ciphertext-store", () => {
  it("round-trips put -> get -> delete", async () => {
    const factory = makeFakeFactory();
    const orderId = "order-abc-123";
    const bytes = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]);

    await putSellerCiphertext(orderId, bytes, factory);

    const loaded = await getSellerCiphertext(orderId, factory);
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!)).toEqual(Array.from(bytes));

    await deleteSellerCiphertext(orderId, factory);
    const afterDelete = await getSellerCiphertext(orderId, factory);
    expect(afterDelete).toBeNull();
  });

  it("stores an independent copy (mutating the source does not change it)", async () => {
    const factory = makeFakeFactory();
    const orderId = "order-copy";
    const bytes = new Uint8Array([10, 20, 30]);

    await putSellerCiphertext(orderId, bytes, factory);
    bytes[0] = 99; // mutate AFTER persisting

    const loaded = await getSellerCiphertext(orderId, factory);
    expect(loaded).not.toBeNull();
    expect(Array.from(loaded!)).toEqual([10, 20, 30]);
  });

  it("returns null for a missing order", async () => {
    const factory = makeFakeFactory();
    const loaded = await getSellerCiphertext("nope", factory);
    expect(loaded).toBeNull();
  });

  it("degrades to a no-op / null when IndexedDB is unavailable", async () => {
    // No injected factory and no global indexedDB in the node test env.
    await expect(
      putSellerCiphertext("order-x", new Uint8Array([1])),
    ).resolves.toBeUndefined();
    await expect(getSellerCiphertext("order-x")).resolves.toBeNull();
    await expect(deleteSellerCiphertext("order-x")).resolves.toBeUndefined();
  });
});
