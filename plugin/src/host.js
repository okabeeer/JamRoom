// The Jam host, running inside the host's Spotify. It is the same room logic and
// command handlers the JamRoom server uses (server/rooms.js, server/sockets.js),
// fed by friends' commands arriving peer to peer instead of over Socket.IO.

import { RoomStore } from '../../server/rooms.js';
import { registerSocketHandlers } from '../../server/sockets.js';
import { forgetJam, shareFiles } from './files.js';
import { openRoom } from './net.js';
import { spotifyTrackInfo } from './spotifyMeta.js';

const SAVE_KEY = 'jamroom:hosted';
const SAVE_DELAY_MS = 1000;
const FILE_ID = /^[A-Za-z0-9_-]{16,32}$/;
const MAX_FILES_PER_UPLOAD = 20;
const GUEST_FORBIDDEN = new Set(['room:create']);

/** Looks enough like a Socket.IO server-side socket for registerSocketHandlers. */
class HostSocket {
  data = {};
  rooms = new Set();
  #handlers = new Map();

  constructor(deliver) {
    this.deliver = deliver;
  }

  on(event, fn) {
    this.#handlers.set(event, fn);
  }

  emit(event, data) {
    this.deliver(event, data);
  }

  join(room) {
    this.rooms.add(room);
  }

  leave(room) {
    this.rooms.delete(room);
  }

  /** Run a command; resolves with its ack ({ ok, ... }). */
  dispatch(event, payload) {
    const fn = this.#handlers.get(event);
    if (!fn || event === 'disconnect') return Promise.resolve({ ok: false, error: 'Unknown command' });
    return new Promise((resolve) => fn(payload && typeof payload === 'object' ? payload : {}, resolve));
  }

  close() {
    this.#handlers.get('disconnect')?.();
  }
}

export class Host {
  #sockets = new Set();
  #served = new Map(); // code -> { room, stopSharing }
  #onConnection = null;
  #saveTimer = null;

  constructor() {
    this.store = new RoomStore();
    const io = {
      on: (event, fn) => {
        if (event === 'connection') this.#onConnection = fn;
      },
      to: (code) => ({
        emit: (event, data) => {
          for (const socket of this.#sockets) if (socket.rooms.has(code)) socket.emit(event, data);
        },
      }),
      of: () => ({ sockets: this.#sockets }),
    };
    registerSocketHandlers(io, this.store, {
      allowSpotify: true,
      extend: (on, me) => this.#extend(on, me),
      spotifyLookup: spotifyTrackInfo,
      // A file from someone's saved playlist: its bytes are on their computer and shared peer to peer.
      importFile: (item) => {
        const fileId = typeof item.src === 'string' && item.src.startsWith('p2p:') ? item.src.slice(4) : null;
        if (!fileId || !FILE_ID.test(fileId)) return null;
        return { kind: 'file', src: `p2p:${fileId}`, file: fileId, title: item.title, artist: item.artist, durationSec: item.durationSec };
      },
    });
    this.store.on('change', () => this.#save());
    this.store.on('ended', ({ code }) => {
      this.#save(0); // right away, so closing Spotify now can't bring the ended Jam back
      forgetJam(code);
      setTimeout(() => this.#unserve(code), 3000); // let the "ended" message reach everyone first
    });
    this.#restore();
  }

  /** Uploaded files stay on the uploader's computer; the Jam only records their IDs. */
  #extend(on, me) {
    on('track:addFiles', ({ files, enqueue }) => {
      const [code, memberId] = me();
      const items = (Array.isArray(files) ? files : [])
        .slice(0, MAX_FILES_PER_UPLOAD)
        .filter((f) => typeof f?.fileId === 'string' && FILE_ID.test(f.fileId))
        .map((f) => ({ kind: 'file', src: `p2p:${f.fileId}`, file: f.fileId, title: f.title, artist: f.artist, durationSec: f.durationSec }));
      const tracks = this.store.addTracks(code, memberId, items, { enqueue: Boolean(enqueue) });
      return { tracks: tracks.map(({ id, title }) => ({ id, title })) };
    });
  }

  has(code) {
    return this.store.has(code);
  }

  /** A connection for this Spotify's own UI. */
  connect(deliver) {
    const socket = new HostSocket(deliver);
    this.#sockets.add(socket);
    this.#onConnection(socket);
    return socket;
  }

  #disconnect(socket) {
    socket.close();
    this.#sockets.delete(socket);
  }

  /** Open the Jam to friends: anyone who knows the code can connect and send commands. */
  serve(code) {
    if (this.#served.has(code)) return;
    const room = openRoom(code);
    const guests = new Map(); // peerId -> HostSocket
    const events = room.makeAction('evt');
    const hello = room.makeAction('host');
    room.makeAction('cmd', {
      kind: 'request',
      onRequest: ({ event, payload } = {}, { peerId }) => {
        event = String(event);
        if (GUEST_FORBIDDEN.has(event)) return { ok: false, error: 'Not allowed' };
        if (payload?.code != null && payload.code !== code) return { ok: false, error: 'Wrong Jam', code: 'not-found' };
        let socket = guests.get(peerId);
        if (!socket) {
          socket = this.connect((ev, data) => events.send({ event: ev, data }, { target: peerId }).catch(() => {}));
          guests.set(peerId, socket);
        }
        return socket.dispatch(event, payload);
      },
    });
    room.onPeerJoin = (peerId) => hello.send({ code }, { target: peerId }).catch(() => {});
    room.onPeerLeave = (peerId) => {
      const socket = guests.get(peerId);
      if (!socket) return;
      guests.delete(peerId);
      this.#disconnect(socket);
    };
    this.#served.set(code, { room, guests, stopSharing: shareFiles(room) });
  }

  #unserve(code) {
    const served = this.#served.get(code);
    if (!served) return;
    this.#served.delete(code);
    for (const socket of served.guests.values()) this.#disconnect(socket);
    served.stopSharing();
    served.room.leave().catch(() => {});
  }

  #save(delayMs = SAVE_DELAY_MS) {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(this.store));
      } catch {
        // storage full or blocked: the Jam just won't survive a restart
      }
    }, delayMs);
  }

  /** Jams you host come back when Spotify restarts (paused where they were). */
  #restore() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(SAVE_KEY));
    } catch {
      return;
    }
    this.store.load(data);
    for (const room of data?.rooms ?? []) if (this.store.has(room.code)) this.serve(room.code);
  }
}
