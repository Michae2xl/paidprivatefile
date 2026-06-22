// Best-effort IndexedDB persistence for the seller's encrypted file bytes.
//
// The seller browser keeps each order's ciphertext in an in-memory Map so it can
// stream the file to the buyer over Nym (browser-to-browser). That Map is lost on
// reload / in a later session, which silently disables file-over-Nym for orders
// created earlier — the buyer then always falls back to HTTPS. This thin
// IndexedDB wrapper persists the ciphertext keyed by orderId so the SAME browser
// can deliver the file over Nym even after a reload, as long as it created the
// order.
//
// Everything here is BEST-EFFORT: any failure (no IndexedDB, blocked DB, quota,
// etc.) resolves to a no-op / null so the caller transparently keeps today's
// in-memory + HTTPS-fallback behavior.

const DB_NAME = "paidprivatefile";
// Bumped to 2 to add the product-ciphertext object store alongside the order
// store. onupgradeneeded creates ANY missing store, so a browser on v1 upgrades
// in place (the existing per-order store is preserved) and a fresh browser gets
// both. Multi-buyer "product" model: a product holds one self-contained
// ciphertext that every future purchase reuses, so the seller browser persists
// it keyed by productId (parallel to the per-order keying) to deliver every
// purchase of that product over Nym after a reload.
const DB_VERSION = 2;
const STORE_NAME = "seller_ciphertext";
const PRODUCT_STORE_NAME = "seller_product_ciphertext";

// The minimal IndexedDB surface this module depends on. Injectable so the
// put/get/delete round-trip can be unit-tested with a small in-memory fake
// without pulling in a real IndexedDB polyfill as a dependency.
type IndexedDBFactoryLike = Pick<IDBFactory, "open">;

function resolveFactory(
  factory?: IndexedDBFactoryLike,
): IndexedDBFactoryLike | null {
  if (factory) {
    return factory;
  }
  if (typeof indexedDB !== "undefined") {
    return indexedDB;
  }
  const globalIndexedDB = (globalThis as { indexedDB?: IndexedDBFactoryLike })
    .indexedDB;
  return globalIndexedDB ?? null;
}

// Open (and upgrade if needed) the database. Resolves null when IndexedDB is
// unavailable or the open fails, so every caller degrades gracefully.
function openDb(factory?: IndexedDBFactoryLike): Promise<IDBDatabase | null> {
  const idb = resolveFactory(factory);
  if (!idb) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(PRODUCT_STORE_NAME)) {
        db.createObjectStore(PRODUCT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function runStore<T>(
  db: IDBDatabase,
  storeName: string,
  storeMode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | null> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, storeMode);
    } catch {
      resolve(null);
      return;
    }
    let request: IDBRequest<T> | null;
    try {
      request = work(tx.objectStore(storeName));
    } catch {
      resolve(null);
      return;
    }
    if (!request) {
      tx.oncomplete = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
      return;
    }
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
}

// Persist the encrypted file bytes for an order. Best-effort: resolves whether
// or not the write succeeded; never throws.
export async function putSellerCiphertext(
  orderId: string,
  bytes: Uint8Array,
  factory?: IndexedDBFactoryLike,
): Promise<void> {
  const db = await openDb(factory);
  if (!db) {
    return;
  }
  try {
    // Copy into a standalone ArrayBuffer-backed Uint8Array so the stored value
    // is independent of any shared/detached source buffer.
    const stored = bytes.slice();
    await runStore<IDBValidKey>(db, STORE_NAME, "readwrite", (store) =>
      store.put(stored, orderId),
    );
  } finally {
    db.close();
  }
}

// Load the encrypted file bytes for an order, or null if none are stored / the
// read failed. Never throws.
export async function getSellerCiphertext(
  orderId: string,
  factory?: IndexedDBFactoryLike,
): Promise<Uint8Array | null> {
  const db = await openDb(factory);
  if (!db) {
    return null;
  }
  try {
    const value = await runStore<unknown>(db, STORE_NAME, "readonly", (store) =>
      store.get(orderId),
    );
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    return null;
  } finally {
    db.close();
  }
}

// Remove the stored ciphertext for an order (after a confirmed Ack). Best-effort.
export async function deleteSellerCiphertext(
  orderId: string,
  factory?: IndexedDBFactoryLike,
): Promise<void> {
  const db = await openDb(factory);
  if (!db) {
    return;
  }
  try {
    await runStore<undefined>(db, STORE_NAME, "readwrite", (store) =>
      store.delete(orderId),
    );
  } finally {
    db.close();
  }
}

// --- Product ciphertext (multi-buyer "product" model) ---------------------
// Same best-effort IndexedDB persistence as the per-order helpers above, but
// keyed by productId and backed by a separate object store. A product holds one
// self-contained ciphertext that every future purchase reuses, so the creating
// browser persists it once at create time; Phase 3b loads it by productId to
// stream each purchase's file over Nym. Every helper degrades to a no-op / null
// exactly like the order helpers, so a browser without IndexedDB simply re-uploads
// nothing and the HTTPS fallback keeps working.

export async function putProductCiphertext(
  productId: string,
  bytes: Uint8Array,
  factory?: IndexedDBFactoryLike,
): Promise<void> {
  const db = await openDb(factory);
  if (!db) {
    return;
  }
  try {
    const stored = bytes.slice();
    await runStore<IDBValidKey>(db, PRODUCT_STORE_NAME, "readwrite", (store) =>
      store.put(stored, productId),
    );
  } finally {
    db.close();
  }
}

export async function getProductCiphertext(
  productId: string,
  factory?: IndexedDBFactoryLike,
): Promise<Uint8Array | null> {
  const db = await openDb(factory);
  if (!db) {
    return null;
  }
  try {
    const value = await runStore<unknown>(
      db,
      PRODUCT_STORE_NAME,
      "readonly",
      (store) => store.get(productId),
    );
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    return null;
  } finally {
    db.close();
  }
}

export async function deleteProductCiphertext(
  productId: string,
  factory?: IndexedDBFactoryLike,
): Promise<void> {
  const db = await openDb(factory);
  if (!db) {
    return;
  }
  try {
    await runStore<undefined>(db, PRODUCT_STORE_NAME, "readwrite", (store) =>
      store.delete(productId),
    );
  } finally {
    db.close();
  }
}
