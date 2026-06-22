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
const DB_VERSION = 1;
const STORE_NAME = "seller_ciphertext";

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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function runStore<T>(
  db: IDBDatabase,
  storeMode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | null> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, storeMode);
    } catch {
      resolve(null);
      return;
    }
    let request: IDBRequest<T> | null;
    try {
      request = work(tx.objectStore(STORE_NAME));
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
    await runStore<IDBValidKey>(db, "readwrite", (store) =>
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
    const value = await runStore<unknown>(db, "readonly", (store) =>
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
    await runStore<undefined>(db, "readwrite", (store) =>
      store.delete(orderId),
    );
  } finally {
    db.close();
  }
}
