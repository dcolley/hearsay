/**
 * IndexedDB store for Pocket TTS cloned-voice reference clips.
 * pocket-tts-js keeps embeddings in the worker only — we persist mono PCM
 * and re-run cloneVoice() after reload.
 */

const DB_NAME = "hearsay.pocket.voices";
const DB_VERSION = 1;
const STORE = "clones";

export type PocketCloneRecord = {
  id: string;
  name: string;
  createdAt: number;
  sampleRate: number;
  /** Mono PCM at sampleRate (≤10 s). */
  pcm: Float32Array;
};

type StoredRow = {
  id: string;
  name: string;
  createdAt: number;
  sampleRate: number;
  pcm: ArrayBuffer;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
  });
}

function rowToRecord(row: StoredRow): PocketCloneRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    sampleRate: row.sampleRate,
    pcm: new Float32Array(row.pcm),
  };
}

export async function listPocketClones(): Promise<
  Omit<PocketCloneRecord, "pcm">[]
> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onerror = () => reject(req.error ?? new Error("list clones failed"));
    req.onsuccess = () => {
      const rows = (req.result as StoredRow[]).map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.createdAt,
        sampleRate: r.sampleRate,
      }));
      rows.sort((a, b) => b.createdAt - a.createdAt);
      resolve(rows);
    };
  });
}

export async function getPocketClone(
  id: string,
): Promise<PocketCloneRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onerror = () => reject(req.error ?? new Error("get clone failed"));
    req.onsuccess = () => {
      const row = req.result as StoredRow | undefined;
      resolve(row ? rowToRecord(row) : null);
    };
  });
}

export async function savePocketClone(
  record: PocketCloneRecord,
): Promise<void> {
  const db = await openDb();
  const pcmCopy = record.pcm.slice();
  const row: StoredRow = {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    sampleRate: record.sampleRate,
    pcm: pcmCopy.buffer.slice(
      pcmCopy.byteOffset,
      pcmCopy.byteOffset + pcmCopy.byteLength,
    ),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).put(row);
    req.onerror = () => reject(req.error ?? new Error("save clone failed"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("save clone tx failed"));
  });
}

export async function deletePocketClone(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).delete(id);
    req.onerror = () => reject(req.error ?? new Error("delete clone failed"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("delete clone tx failed"));
  });
}

export async function renamePocketClone(
  id: string,
  name: string,
): Promise<void> {
  const existing = await getPocketClone(id);
  if (!existing) throw new Error(`Clone ${id} not found`);
  await savePocketClone({ ...existing, name: name.trim() || existing.name });
}

export function newCloneId(): string {
  return `clone_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
