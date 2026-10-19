// Uploaded songs travel friend to friend: whoever has a file (the person who added
// it, or anyone who already fetched it) sends it to whoever asks. Each Spotify keeps
// the files it has in IndexedDB, so they survive a restart.

export const MAX_FILE_BYTES = 60 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 180000;
const DB_NAME = 'jamroom-files';
const STORE = 'files';

let dbPromise = null;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

// Also the fallback when IndexedDB is unavailable.
const memory = new Map(); // id -> { blob, code }
const urls = new Map(); // id -> object URL

export async function saveFile(id, blob, code) {
  memory.set(id, { blob, code });
  try {
    await withStore('readwrite', (s) => s.put({ blob, code, savedAt: Date.now() }, id));
  } catch {
    // memory only
  }
}

export async function loadFile(id) {
  if (memory.has(id)) return memory.get(id).blob;
  try {
    const rec = await withStore('readonly', (s) => s.get(id));
    if (rec?.blob) {
      memory.set(id, rec);
      return rec.blob;
    }
  } catch {
    // not stored
  }
  return null;
}

// Files that saved playlists use (savedPlaylists.js) survive the end of their Jam.
const KEPT_KEY = 'jamroom:kept-files';
let kept = new Set();
try {
  kept = new Set(JSON.parse(localStorage.getItem(KEPT_KEY)) ?? []);
} catch {
  // none kept
}

export const keptFiles = {
  keepOnly(ids) {
    kept = new Set(ids);
    try {
      localStorage.setItem(KEPT_KEY, JSON.stringify([...kept]));
    } catch {
      // kept for this session only
    }
  },
};

/** The Jam ended: drop its files from this computer, except ones a saved playlist uses. */
export async function forgetJam(code) {
  for (const [id, rec] of memory) {
    if (rec.code !== code || kept.has(id)) continue;
    memory.delete(id);
    if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
    urls.delete(id);
  }
  try {
    await withStore('readwrite', (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (cursor.value?.code === code && !kept.has(cursor.key)) cursor.delete();
        cursor.continue();
      };
      return null;
    });
  } catch {
    // nothing stored
  }
}

// ---- peer to peer

const shared = new Set(); // { room, action }

/** Answer file requests from peers in this room. Returns a function that stops. */
export function shareFiles(room) {
  const action = room.makeAction('file', {
    kind: 'request',
    onRequest: async ({ id } = {}) => {
      const blob = typeof id === 'string' ? await loadFile(id) : null;
      return blob ? blob.arrayBuffer() : new ArrayBuffer(0);
    },
  });
  const entry = { room, action };
  shared.add(entry);
  return () => shared.delete(entry);
}

const inflight = new Map();

/** A file from this computer, or else from the first friend who has it. */
export function fetchFile(id, code) {
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    const local = await loadFile(id);
    if (local) return local;
    for (const { room, action } of shared) {
      for (const peerId of Object.keys(room.getPeers())) {
        try {
          const data = await action.request({ id }, { target: peerId, timeoutMs: TRANSFER_TIMEOUT_MS });
          if (data?.byteLength) {
            const blob = new Blob([data]);
            await saveFile(id, blob, code);
            return blob;
          }
        } catch {
          // try the next friend
        }
      }
    }
    throw new Error('Nobody in the Jam has this file right now. The person who added it may have left.');
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

export async function fileUrl(id, code) {
  if (!urls.has(id)) urls.set(id, URL.createObjectURL(await fetchFile(id, code)));
  return urls.get(id);
}
