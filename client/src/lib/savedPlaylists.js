// Your own playlists, kept on this device across Jams (like the playlists in your Spotify
// library). Save a Jam playlist here, then play it in any later Jam.
//
// Uploaded files can only be kept where the platform keeps the file itself (the Spotify
// plugin stores them on your computer); in the web app they disappear when a Jam ends.

import { useSyncExternalStore } from 'react';
import { keptFiles } from './platform.js';

const KEY = 'jam:saved-playlists';
const MAX_PLAYLISTS = 200;
const MAX_TRACKS = 1000;

let cache = null;
const listeners = new Set();

function read() {
  if (cache) return cache;
  try {
    const value = JSON.parse(localStorage.getItem(KEY));
    cache = Array.isArray(value) ? value : [];
  } catch {
    cache = [];
  }
  return cache;
}

const fileIds = (items) => items.filter((i) => i.kind === 'file' && i.src.startsWith('p2p:')).map((i) => i.src.slice(4));

function write(list) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage full or blocked: kept for this session only
  }
  keptFiles?.keepOnly(new Set(list.flatMap((p) => fileIds(p.items))));
  for (const fn of listeners) fn();
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useSavedPlaylists() {
  return useSyncExternalStore(subscribe, read);
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Save (or update, by name) a playlist from Jam tracks. */
export function savePlaylist(name, tracks) {
  const items = [];
  let skipped = 0;
  for (const t of tracks) {
    if (t.kind === 'file' && !(keptFiles && t.src.startsWith('p2p:'))) {
      skipped++;
      continue;
    }
    items.push({ kind: t.kind, src: t.src, title: t.title, artist: t.artist ?? null, durationSec: t.duration ?? null, art: t.art ?? null });
  }
  if (!items.length) return { saved: false, replaced: false, skipped };
  const list = read();
  const existing = list.find((p) => p.name === name);
  const entry = { id: existing?.id ?? newId(), name, items: items.slice(0, MAX_TRACKS), savedAt: Date.now() };
  write(existing ? list.map((p) => (p === existing ? entry : p)) : [...list, entry].slice(-MAX_PLAYLISTS));
  return { saved: true, replaced: !!existing, skipped };
}

export function deleteSavedPlaylist(id) {
  write(read().filter((p) => p.id !== id));
}
