// The fallback path between friends. Some networks never allow a direct (WebRTC) connection:
// carrier-grade or "symmetric" NAT, common on 4G/5G home routers, and there are no free TURN
// relays left. When that happens the Jam's messages go through free public MQTT brokers
// instead. Everything is end-to-end encrypted with a key derived from the Jam code; the brokers
// only see a random-looking topic and ciphertext. Topic and key come from a slow PBKDF2, so
// listing a public broker's topics doesn't let anyone guess codes.

const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const KEEPALIVE_S = 30;
const CHUNK_BYTES = 200 * 1024; // every broker above accepts this
const ONE_BROKER_ABOVE = 48 * 1024; // small messages go through every broker, big ones through the fastest
const HEARTBEAT_MS = 10000;
const GONE_AFTER_MS = 32000;
const SEEN_FOR_MS = 120000;
const VERSION = 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

function concat(...parts) {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : p instanceof ArrayBuffer ? new Uint8Array(p) : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

const u16 = (n) => [n >> 8, n & 255];
const mqttString = (s) => {
  const b = enc.encode(s);
  return concat(u16(b.length), b);
};
const remainingLength = (n) => {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 128;
    out.push(b);
  } while (n > 0);
  return out;
};
const packet = (type, flags, body) => concat([(type << 4) | flags], remainingLength(body.length), body);
const randomId = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** One broker connection (MQTT 3.1.1 over a secure WebSocket, QoS 0), reconnecting by itself. */
class Broker {
  ready = false;
  rtt = Infinity;
  #topics = new Set();
  #ws = null;
  #ping = null;
  #retryMs = 2000;
  #packetId = 1;
  #closed = false;

  constructor(url, onPublish, onReady) {
    this.url = url;
    this.onPublish = onPublish;
    this.onReady = onReady;
    this.#connect();
  }

  #connect() {
    if (this.#closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url, 'mqtt');
    } catch {
      this.#retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    const started = performance.now();
    let buffer = new Uint8Array(0);
    ws.onopen = () => ws.send(packet(1, 0, concat(mqttString('MQTT'), [4, 2, 0, KEEPALIVE_S], mqttString(`jr${randomId(8)}`))));
    ws.onmessage = (e) => {
      buffer = concat(buffer, new Uint8Array(e.data));
      for (;;) {
        if (buffer.length < 2) return;
        let length = 0;
        let mult = 1;
        let i = 1;
        let b;
        do {
          if (i >= buffer.length) return;
          b = buffer[i++];
          length += (b & 127) * mult;
          mult *= 128;
        } while (b & 128);
        if (buffer.length < i + length) return;
        const type = buffer[0] >> 4;
        const qos = (buffer[0] >> 1) & 3;
        const body = buffer.subarray(i, i + length);
        buffer = buffer.slice(i + length);
        if (type === 2) this.#connected(body, started);
        else if (type === 3) {
          const topicLength = (body[0] << 8) | body[1];
          const topic = dec.decode(body.subarray(2, 2 + topicLength));
          const payload = body.slice(2 + topicLength + (qos ? 2 : 0));
          this.onPublish(topic, payload);
        }
      }
    };
    ws.onclose = () => {
      this.ready = false;
      clearInterval(this.#ping);
      this.#retry();
    };
    ws.onerror = () => {};
  }

  #connected(body, started) {
    if (body[1] !== 0) return this.#ws.close(); // refused
    this.ready = true;
    this.rtt = performance.now() - started;
    this.#retryMs = 2000;
    for (const topic of this.#topics) this.#send(8, 2, concat(u16(this.#nextId()), mqttString(topic), [0]));
    clearInterval(this.#ping);
    this.#ping = setInterval(() => this.#send(12, 0, new Uint8Array(0)), (KEEPALIVE_S - 5) * 1000);
    this.onReady();
  }

  #retry() {
    if (this.#closed) return;
    setTimeout(() => this.#connect(), this.#retryMs);
    this.#retryMs = Math.min(this.#retryMs * 2, 60000);
  }

  #nextId() {
    this.#packetId = (this.#packetId % 65535) + 1;
    return this.#packetId;
  }

  #send(type, flags, body) {
    if (!this.ready || this.#ws.readyState !== 1) return false;
    this.#ws.send(packet(type, flags, body));
    return true;
  }

  subscribe(topic) {
    this.#topics.add(topic);
    this.#send(8, 2, concat(u16(this.#nextId()), mqttString(topic), [0]));
  }

  unsubscribe(topic) {
    this.#topics.delete(topic);
    this.#send(10, 2, concat(u16(this.#nextId()), mqttString(topic)));
  }

  publish(topic, payload) {
    return this.#send(3, 0, concat(mqttString(topic), payload));
  }

  close() {
    this.#closed = true;
    clearInterval(this.#ping);
    this.#ws?.close();
  }
}

/** The broker connections, shared by every Jam on this computer. */
const hub = {
  brokers: null,
  handlers: new Map(), // topic -> fn(bytes)
  readyWaiters: new Set(),
  start() {
    if (this.brokers) return;
    const onPublish = (topic, payload) => this.handlers.get(topic)?.(payload);
    const onReady = () => {
      for (const done of this.readyWaiters) done();
      this.readyWaiters.clear();
    };
    this.brokers = BROKERS.map((url) => new Broker(url, onPublish, onReady));
  },
  subscribe(topic, handler) {
    this.start();
    this.handlers.set(topic, handler);
    for (const b of this.brokers) b.subscribe(topic);
  },
  unsubscribe(topic) {
    this.handlers.delete(topic);
    for (const b of this.brokers ?? []) b.unsubscribe(topic);
    if (!this.handlers.size && this.brokers) {
      for (const b of this.brokers) b.close();
      this.brokers = null;
    }
  },
  connected() {
    return (this.brokers ?? []).filter((b) => b.ready).length;
  },
  whenReady(ms) {
    if (this.connected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.readyWaiters.delete(done);
        resolve(false);
      }, ms);
      this.readyWaiters.add(done);
    });
  },
  /** Small messages through every broker (if one drops it, another delivers); big ones through the fastest. */
  publish(topic, frames, big) {
    const ready = (this.brokers ?? []).filter((b) => b.ready).sort((a, b) => a.rtt - b.rtt);
    const via = big ? ready.slice(0, 1) : ready;
    for (const b of via) for (const f of frames) b.publish(topic, f);
    return via.length > 0;
  },
};

async function deriveRoom(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode(`jamroom-relay:${code}`), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('jamroom-relay-v1'), iterations: 200000 }, base, 384));
  const topic = `jamroom/${[...bits.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const key = await crypto.subtle.importKey('raw', bits.subarray(16, 48), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topic, key };
}

const isBinary = (d) => d instanceof ArrayBuffer || ArrayBuffer.isView(d);

/**
 * One Jam's encrypted channel through the brokers.
 * onPeer(id) / onPeerGone(id): someone with the same code appeared / left.
 * onMessage(id, header, data): header is the sender's small JSON; data is JSON or an ArrayBuffer.
 */
export class RelayChannel {
  #peers = new Map(); // peerId -> last heard (ms)
  #seen = new Map(); // "msgId:index" -> time, to drop the copies other brokers deliver
  #partial = new Map(); // msgId -> { parts, got, t }
  #timers = [];
  #closed = false;

  constructor(code, selfId, { onPeer, onPeerGone, onMessage }) {
    this.selfId = selfId;
    Object.assign(this, { onPeer, onPeerGone, onMessage });
    this.ready = deriveRoom(code).then((room) => {
      if (this.#closed) return null;
      this.room = room;
      const receive = (bytes) => this.#receive(bytes).catch(() => {});
      hub.subscribe(room.topic, receive);
      hub.subscribe(`${room.topic}/${selfId}`, receive);
      this.#timers.push(setInterval(() => this.#announce(null), HEARTBEAT_MS));
      this.#timers.push(setInterval(() => this.#sweep(), 4000));
      hub.whenReady(15000).then(() => this.#announce(null));
      return room;
    });
    this.#onUnload = () => this.close();
    window.addEventListener('pagehide', this.#onUnload);
  }

  #onUnload;

  peers() {
    return [...this.#peers.keys()];
  }

  status() {
    return { brokers: hub.connected(), peers: this.#peers.size };
  }

  #announce(to) {
    this.send(to, { t: 'hi' }).catch(() => {});
  }

  #sweep() {
    const now = Date.now();
    for (const [id, last] of this.#peers) {
      if (now - last > GONE_AFTER_MS) {
        this.#peers.delete(id);
        this.onPeerGone(id);
      }
    }
    for (const [k, t] of this.#seen) if (now - t > SEEN_FOR_MS) this.#seen.delete(k);
    for (const [k, p] of this.#partial) if (now - p.t > SEEN_FOR_MS) this.#partial.delete(k);
  }

  /** to: a peer id, or null for everyone. data: anything JSON, or binary. */
  async send(to, header, data) {
    const room = await this.ready;
    if (!room || this.#closed && header.t !== 'bye') return;
    if (!hub.connected() && !(await hub.whenReady(10000))) throw new Error('No connection to the relay brokers');
    const binary = isBinary(data);
    const head = enc.encode(JSON.stringify({ ...header, f: this.selfId, b: binary ? 1 : 0, d: binary ? undefined : data }));
    const plain = concat([head.length >>> 24, (head.length >> 16) & 255, (head.length >> 8) & 255, head.length & 255], head, binary ? (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data) : []);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = concat(iv, await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, room.key, plain));
    const msgId = crypto.getRandomValues(new Uint8Array(8));
    const count = Math.max(1, Math.ceil(sealed.length / CHUNK_BYTES));
    if (count > 65535) throw new Error('Too big to send through the relay');
    const frames = [];
    for (let i = 0; i < count; i++) frames.push(concat([0x4a, VERSION], msgId, u16(i), u16(count), sealed.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)));
    const topic = to ? `${room.topic}/${to}` : room.topic;
    if (!hub.publish(topic, frames, sealed.length > ONE_BROKER_ABOVE)) throw new Error('No connection to the relay brokers');
  }

  async #receive(frame) {
    if (frame.length < 14 || frame[0] !== 0x4a || frame[1] !== VERSION) return;
    const msgId = [...frame.subarray(2, 10)].join('.');
    const index = (frame[10] << 8) | frame[11];
    const count = (frame[12] << 8) | frame[13];
    const key = `${msgId}:${index}`;
    if (this.#seen.has(key)) return;
    this.#seen.set(key, Date.now());
    let sealed;
    if (count === 1) sealed = frame.subarray(14);
    else {
      const p = this.#partial.get(msgId) ?? { parts: new Array(count), got: 0, t: Date.now() };
      this.#partial.set(msgId, p);
      p.parts[index] = frame.slice(14);
      if (++p.got < count) return;
      this.#partial.delete(msgId);
      sealed = concat(...p.parts);
    }
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12) }, this.room.key, sealed.subarray(12)));
    const headLength = ((plain[0] << 24) | (plain[1] << 16) | (plain[2] << 8) | plain[3]) >>> 0;
    const header = JSON.parse(dec.decode(plain.subarray(4, 4 + headLength)));
    const from = header.f;
    if (typeof from !== 'string' || from === this.selfId || this.#closed) return;
    if (header.t === 'bye') {
      if (this.#peers.delete(from)) this.onPeerGone(from);
      return;
    }
    const isNew = !this.#peers.has(from);
    this.#peers.set(from, Date.now());
    if (isNew) {
      this.#announce(from); // so they learn about us right away too
      this.onPeer(from);
    }
    if (header.t === 'hi') return;
    const data = header.b ? plain.slice(4 + headLength).buffer : header.d;
    this.onMessage(from, header, data);
  }

  close() {
    if (this.#closed) return;
    this.send(null, { t: 'bye' }).catch(() => {});
    this.#closed = true;
    window.removeEventListener('pagehide', this.#onUnload);
    for (const t of this.#timers) clearInterval(t);
    this.ready.then((room) => {
      if (!room) return;
      // after the goodbye has gone out
      setTimeout(() => {
        hub.unsubscribe(room.topic);
        hub.unsubscribe(`${room.topic}/${this.selfId}`);
      }, 500);
    });
  }
}
