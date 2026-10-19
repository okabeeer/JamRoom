// Peer-to-peer rooms. Friends' Spotify apps talk to each other directly over WebRTC data
// channels; public Nostr relays are only used to find each other (via Trystero). When two
// networks won't allow a direct connection, the same messages go through the encrypted broker
// fallback (relay.js) instead. No JamRoom server is involved either way.

import { joinRoom, selfId } from 'trystero';
import { RelayChannel } from './relay.js';

export { selfId };

const APP_ID = 'jamroom-spotify-v1';
const REQUEST_TIMEOUT_MS = 15000;

/**
 * The Jam code names the room and is also the password that encrypts the connection
 * handshake (and the fallback path), so only people who know the code can connect.
 *
 * Returns Trystero's room API (makeAction, onPeerJoin, onPeerLeave, getPeers, leave) over both
 * paths: a friend counts as joined as soon as either path reaches them, messages take the
 * direct path whenever it's open, and they leave when neither path reaches them.
 */
export function openRoom(code) {
  let joinError = null;
  const rtc = joinRoom({ appId: APP_ID, password: `jamroom:${code}` }, `jam-${code}`, {
    onJoinError: (e) => {
      joinError = e?.error ?? String(e);
    },
  });
  const peers = new Map(); // peerId -> { rtc, relay }
  const actions = new Map(); // name -> { handler, onRequest }
  const pending = new Map(); // request id -> { resolve, reject, timer }
  let onJoin = () => {};
  let onLeave = () => {};

  const up = (id, via) => {
    const p = peers.get(id) ?? { rtc: false, relay: false };
    const known = p.rtc || p.relay;
    p[via] = true;
    peers.set(id, p);
    if (!known) onJoin(id);
  };
  const down = (id, via) => {
    const p = peers.get(id);
    if (!p) return;
    p[via] = false;
    if (p.rtc || p.relay) return;
    peers.delete(id);
    for (const [rid, w] of pending) {
      if (w.peerId !== id) continue;
      pending.delete(rid);
      clearTimeout(w.timer);
      w.reject(new Error('peer disconnected'));
    }
    onLeave(id);
  };
  const direct = (id) => !!peers.get(id)?.rtc;

  const relay = new RelayChannel(code, selfId, {
    onPeer: (id) => up(id, 'relay'),
    onPeerGone: (id) => down(id, 'relay'),
    onMessage: (from, header, data) => {
      const action = actions.get(header.ns);
      if (header.t === 'm') action?.handler?.(data, { peerId: from });
      else if (header.t === 'q') {
        const reply = (extra, body) => relay.send(from, { t: 'r', ns: header.ns, id: header.id, ...extra }, body).catch(() => {});
        if (!action?.onRequest) return reply({ e: 'request handler unavailable' });
        Promise.resolve()
          .then(() => action.onRequest(data, { peerId: from }))
          .then((res) => reply({}, res), (err) => reply({ e: String(err?.message ?? err) }));
      } else if (header.t === 'r') {
        const w = pending.get(header.id);
        if (!w || w.peerId !== from) return;
        pending.delete(header.id);
        clearTimeout(w.timer);
        if (header.e) w.reject(new Error(header.e));
        else w.resolve(data);
      }
    },
  });
  rtc.onPeerJoin = (id) => up(id, 'rtc');
  rtc.onPeerLeave = (id) => down(id, 'rtc');

  return {
    makeAction(name, config) {
      const isRequest = config?.kind === 'request';
      const inner = isRequest ? rtc.makeAction(name, { kind: 'request', ...(config.onRequest ? { onRequest: config.onRequest } : {}) }) : rtc.makeAction(name);
      const entry = { handler: null, onRequest: config?.onRequest ?? null };
      actions.set(name, entry);
      if (isRequest) {
        return {
          request(data, { target, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
            if (direct(target)) return inner.request(data, { target, timeoutMs });
            if (!peers.has(target)) return Promise.reject(new Error(`no active peer with id ${target}`));
            return new Promise((resolve, reject) => {
              const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
              const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error('request timed out'));
              }, timeoutMs);
              pending.set(id, { resolve, reject, timer, peerId: target });
              relay.send(target, { t: 'q', ns: name, id }, data).catch((err) => {
                pending.delete(id);
                clearTimeout(timer);
                reject(err);
              });
            });
          },
        };
      }
      return {
        async send(data, { target } = {}) {
          const targets = target == null ? [...peers.keys()] : [].concat(target);
          const viaRtc = targets.filter(direct);
          const viaRelay = targets.filter((t) => !direct(t) && peers.has(t));
          await Promise.all([viaRtc.length ? inner.send(data, { target: viaRtc }) : null, ...viaRelay.map((t) => relay.send(t, { t: 'm', ns: name }, data))]);
        },
        get onMessage() {
          return entry.handler;
        },
        set onMessage(fn) {
          entry.handler = fn;
          inner.onMessage = fn;
        },
      };
    },
    set onPeerJoin(fn) {
      onJoin = fn;
    },
    set onPeerLeave(fn) {
      onLeave = fn;
    },
    getPeers() {
      return Object.fromEntries([...peers.keys()].map((id) => [id, true]));
    },
    /** For messages and tests: how each friend is reached, and what went wrong. */
    status() {
      return {
        direct: [...peers.values()].filter((p) => p.rtc).length,
        relayed: [...peers.values()].filter((p) => !p.rtc && p.relay).length,
        brokers: relay.status().brokers,
        joinError,
      };
    },
    leave() {
      relay.close();
      for (const w of pending.values()) {
        clearTimeout(w.timer);
        w.reject(new Error('left the room'));
      }
      pending.clear();
      return rtc.leave();
    },
  };
}
