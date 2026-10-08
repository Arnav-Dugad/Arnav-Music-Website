/** Tiny promise-based IndexedDB key/value store (no dependency). Falls back to memory when blocked. */

type StoreName = 'kv' | 'cache'
let dbPromise: Promise<IDBDatabase | null> | null = null
const memory = new Map<string, unknown>()

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open('arnav-music', 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined)
        try {
          const tx = db.transaction(store, mode)
          const req = fn(tx.objectStore(store))
          tx.oncomplete = () => resolve(req ? (req.result as T) : undefined)
          tx.onerror = () => resolve(undefined)
          tx.onabort = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      }),
  )
}

export async function idbGet<T>(key: string, store: StoreName = 'kv'): Promise<T | undefined> {
  const v = await run<T>(store, 'readonly', (s) => s.get(key))
  return v ?? (memory.get(`${store}:${key}`) as T | undefined)
}

export async function idbSet(key: string, value: unknown, store: StoreName = 'kv'): Promise<void> {
  memory.set(`${store}:${key}`, value)
  await run(store, 'readwrite', (s) => { s.put(value, key) })
}

export async function idbDel(key: string, store: StoreName = 'kv'): Promise<void> {
  memory.delete(`${store}:${key}`)
  await run(store, 'readwrite', (s) => { s.delete(key) })
}

export async function idbClear(store: StoreName): Promise<void> {
  for (const k of [...memory.keys()]) if (k.startsWith(`${store}:`)) memory.delete(k)
  await run(store, 'readwrite', (s) => { s.clear() })
}

export async function idbKeys(store: StoreName = 'kv'): Promise<string[]> {
  const keys = await run<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys())
  return (keys ?? []).map(String)
}

/** Safe localStorage helpers (private windows can throw). */
export const ls = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? fallback : (JSON.parse(raw) as T)
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage full or blocked */ }
  },
  del(key: string) {
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  },
}
