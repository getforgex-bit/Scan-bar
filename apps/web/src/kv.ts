// Almacén clave-valor mínimo sobre IndexedDB (modo, borradores, colas sin red).
const open = (): Promise<IDBDatabase> => new Promise((res, rej) => {
  const r = indexedDB.open('codigos', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await open();
  return new Promise((res, rej) => { const r = f(db.transaction('kv', mode).objectStore('kv')); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
};
export const kvGet = async <T,>(k: string, fallback: T): Promise<T> => { try { return ((await tx('readonly', s => s.get(k))) as T) ?? fallback; } catch { return fallback; } };
export const kvSet = async (k: string, v: unknown): Promise<void> => { try { await tx('readwrite', s => s.put(v, k)); } catch { /* sin almacenamiento */ } };
