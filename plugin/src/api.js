// The plugin's version of client/src/lib/api.js: the same socket / call / uploadFiles
// interface the JamRoom UI already uses, carried peer to peer instead of to a server.
//
// - "Start a Jam" makes this Spotify the host (host.js).
// - Joining a code connects to the host's Spotify, wherever it is.

import { Host } from './host.js';
import { MAX_FILE_BYTES, fetchFile, forgetJam, saveFile, shareFiles } from './files.js';
import { openRoom } from './net.js';

const FIND_HOST_MS = 30000; // finding peers through the relays can take a while
const COMMAND_TIMEOUT_MS = 15000;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|weba)$/i;

const jamError = (message, code = null) => Object.assign(new Error(message), { code });

export const host = new Host();

class PeerSocket {
  #listeners = new Map();
  #local = null; // this Spotify's connection to its own host
  #target = null; // the Jam the UI talks to
  connected = true; // until we know which Jam, there is nothing to be disconnected from
  joined = null; // code of the Jam this UI has joined, for "Add to Jam"

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(fn);
  }

  off(event, fn) {
    this.#listeners.get(event)?.delete(fn);
  }

  #fire(event, data) {
    if (event === 'state') prefetchFiles(data);
    if (event === 'ended' || event === 'removed') {
      if (event === 'ended') forgetJam(this.#target?.code);
      this.joined = null;
    }
    for (const fn of this.#listeners.get(event) ?? []) fn(data);
  }

  get #localSocket() {
    this.#local ??= host.connect((event, data) => {
      if (this.#target?.local) this.#fire(event, data);
    });
    return this.#local;
  }

  /** Socket.IO-style: socket.timeout(ms).emit(event, payload, (err, res) => …) */
  timeout(ms) {
    return {
      emit: (event, payload, cb) =>
        this.#request(event, payload ?? {}, ms).then(
          (res) => cb(null, res),
          (err) => cb(err),
        ),
    };
  }

  async #request(event, payload, timeoutMs) {
    if (event === 'room:create') {
      const res = await this.#localSocket.dispatch(event, payload);
      if (res.ok) host.serve(res.code);
      return res;
    }
    if (typeof payload.code === 'string') {
      try {
        await this.#use(payload.code);
      } catch (err) {
        return { ok: false, error: err.message, code: err.code };
      }
    }
    const target = this.#target;
    if (!target) return { ok: false, error: 'Join a Jam first', code: 'not-joined' };
    let res;
    if (target.local) {
      res = await this.#localSocket.dispatch(event, payload);
    } else {
      if (!target.hostPeer) return { ok: false, error: "The host isn't connected right now", code: 'offline' };
      res = await target.cmd.request({ event, payload }, { target: target.hostPeer, timeoutMs: Math.max(timeoutMs, COMMAND_TIMEOUT_MS) });
    }
    if (res?.ok && event === 'room:join') this.joined = target.code;
    if (res?.ok && event === 'room:leave') this.joined = null;
    return res;
  }

  /** Point the UI at a Jam: our own (hosted here) or a friend's (found peer to peer). */
  async #use(code) {
    if (this.#target?.code !== code) this.#switchTo(code);
    const target = this.#target;
    if (target.local || target.hostPeer) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        target.waiters.delete(done);
        const net = target.room.status?.();
        reject(
          jamError(
            net && !net.brokers
              ? "Couldn't reach the services JamRoom uses to connect friends. A firewall, VPN or antivirus may be blocking them."
              : "Couldn't reach this Jam. Check the code, and that the host has Spotify open with the latest JamRoom (you both need it).",
            'offline',
          ),
        );
      }, FIND_HOST_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      target.waiters.add(done);
    });
  }

  #switchTo(code) {
    const previous = this.#target;
    if (previous && !previous.local) {
      previous.stopSharing();
      previous.room.leave().catch(() => {});
    }
    this.connected = true;
    if (host.has(code)) {
      this.#target = { code, local: true };
      return;
    }
    const room = openRoom(code);
    const target = {
      code,
      local: false,
      room,
      hostPeer: null,
      waiters: new Set(),
      cmd: room.makeAction('cmd', { kind: 'request' }),
      stopSharing: shareFiles(room),
    };
    room.makeAction('evt').onMessage = ({ event, data } = {}, { peerId }) => {
      if (peerId === target.hostPeer && this.#target === target && typeof event === 'string') this.#fire(event, data);
    };
    room.makeAction('host').onMessage = ({ code: hostedCode } = {}, { peerId }) => {
      if (hostedCode !== code || this.#target !== target) return;
      const reconnect = target.hostPeer !== peerId;
      target.hostPeer = peerId;
      for (const done of target.waiters) done();
      target.waiters.clear();
      if (reconnect) {
        this.connected = true;
        this.#fire('connect');
      }
    };
    room.onPeerLeave = (peerId) => {
      if (peerId !== target.hostPeer || this.#target !== target) return;
      target.hostPeer = null;
      this.connected = false;
      this.#fire('disconnect');
    };
    this.#target = target;
  }
}

export const socket = new PeerSocket();

/** Same contract as the web client's call(). */
export function call(event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(COMMAND_TIMEOUT_MS).emit(event, payload, (err, res) => {
      if (err) return reject(jamError("The Jam's host didn't respond. They may have lost their connection."));
      if (!res?.ok) return reject(jamError(res?.error ?? 'Request failed', res?.code ?? null));
      resolve(res);
    });
  });
}

// ---- files

/** Fetch upcoming uploaded songs in the background so they're ready when their turn comes. */
let prefetching = false;
async function prefetchFiles(state) {
  if (prefetching || !state?.queue) return;
  prefetching = true;
  try {
    const upcoming = state.queue.slice(Math.max(0, state.player.index));
    for (const item of upcoming) {
      const track = state.tracks[item.trackId];
      if (track?.kind === 'file') await fetchFile(track.src.slice(4), state.code).catch(() => {});
    }
  } finally {
    prefetching = false;
  }
}

function randomFileId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (sec) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(sec) && sec > 0 ? sec : null);
    };
    const timer = setTimeout(() => done(null), 5000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

/** "Artist - Title.mp3" → { artist, title } */
function namesFromFile(name) {
  const base = name.replace(AUDIO_EXT, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1], title: m[2] } : { artist: null, title: base };
}

/** Same contract as the web client's uploadFiles(), but the file stays here and is shared peer to peer. */
export async function uploadFiles({ code, files, enqueue, onProgress }) {
  const accepted = [];
  const skipped = [];
  for (const file of files) {
    if (AUDIO_EXT.test(file.name) && file.size <= MAX_FILE_BYTES) accepted.push(file);
    else skipped.push(file.name);
  }
  if (!accepted.length) throw new Error(`Nothing to add. Files must be audio, up to ${MAX_FILE_BYTES / 1024 / 1024} MB each.`);
  const items = [];
  for (const [i, file] of accepted.entries()) {
    const fileId = randomFileId();
    await saveFile(fileId, file, code);
    items.push({ fileId, ...namesFromFile(file.name), durationSec: await probeDuration(file) });
    onProgress?.((i + 1) / accepted.length);
  }
  const res = await call('track:addFiles', { files: items, enqueue });
  return { ok: true, tracks: res.tracks, skipped };
}
