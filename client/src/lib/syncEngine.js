// The follower. Each device takes the room's single authoritative player state
// (same shape as Spotify's connect-state cluster, F3), works out where playback
// should be right now in server time, and steers its local player there.
//
// Nothing is sent peer to peer: devices only report "this song ended" and
// durations the server couldn't read.

import { correction, positionAt } from '../../../shared/timing.js';
import { serverNow } from './clock.js';
import { createAdapters } from './platform.js';

// seekSettleMs: currentTime is unreliable right after a seek.
const TUNING = {
  audio: { hardMs: 400, softMs: 60, settleMs: 20, seekSettleMs: 800 },
  youtube: { hardMs: 600, softMs: Infinity, settleMs: 0, seekSettleMs: 1500 },
  soundcloud: { hardMs: 1000, softMs: Infinity, settleMs: 0, seekSettleMs: 1500 },
  spotify: { hardMs: 500, softMs: Infinity, settleMs: 0, seekSettleMs: 1500 },
};
const TICK_MS = 300;
const BLOCKED_AFTER_MS = 2500; // play() requested but nothing started

export class SyncEngine {
  /** containers: elements the embedded players (YouTube, SoundCloud) render into. */
  constructor({ containers, onStatus, onEnded, onDuration, onLocalStop }) {
    // Spotify songs only have a player inside the Spotify plugin.
    this.byKind = createAdapters(containers);
    this.adapters = Object.values(this.byKind);
    for (const adapter of this.adapters) {
      adapter.onEnded = () => this.#ended(adapter);
      adapter.onDuration = (sec) => this.#duration(adapter, sec);
      adapter.onError = (err) => this.#failed(adapter, err);
      // Players the listener also controls directly (Spotify) report when they take it back.
      adapter.onTakeover = (reason) => this.#takenOver(reason);
    }
    this.callbacks = { onStatus, onEnded, onDuration, onLocalStop };
    this.state = null;
    this.listening = false;
    this.active = null;
    this.loadedPlayId = null;
    this.loadedTrack = null;
    this.loading = false;
    this.error = null;
    this.correcting = false;
    this.lastSeekAt = 0;
    this.seekLead = {}; // kind -> ms a seek-only player lands behind where it was sent
    this.leadCheck = null; // kind whose last seek we still have to measure
    this.leadRetried = false;
    this.playRequestedAt = 0;
    this.durationSentFor = null;
    this.lastReport = '';
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  setState(state) {
    this.state = state;
    this.tick();
  }

  /** Call from a click handler so the browser lets audio start. */
  setListening(on) {
    this.listening = on;
    if (on) {
      this.byKind.audio.unlock();
      this.playRequestedAt = 0;
    }
    this.tick();
    if (!on) for (const adapter of this.adapters) adapter.release?.();
  }

  setVolume(v) {
    for (const adapter of this.adapters) adapter.setVolume(v);
  }

  stop() {
    this.state = null;
    this.#pauseAll();
    for (const adapter of this.adapters) adapter.release?.();
    this.#report('idle');
  }

  destroy() {
    clearInterval(this.timer);
    for (const adapter of this.adapters) adapter.destroy();
  }

  tick() {
    if (this.loading) return;
    const s = this.state;
    const player = s?.player;
    const item = player && player.index >= 0 ? s.queue[player.index] : null;
    const track = item ? s.tracks[item.trackId] : null;
    if (!track) {
      this.#pauseAll();
      this.loadedPlayId = null;
      return this.#report('idle');
    }
    if (!this.#adapterFor(track)) {
      // e.g. a Spotify song in a plain browser: the rest of the Jam carries on.
      this.#pauseAll();
      this.loadedPlayId = null;
      return this.#report(this.listening ? 'unavailable' : 'not-listening');
    }
    if (this.loadedPlayId !== player.playId) return void this.#load(player.playId, track);

    const a = this.active;
    if (this.error) {
      a.pause();
      return this.#report('error');
    }
    if (!player.isPlaying || player.finished) {
      a.pause();
      return this.#report(this.listening ? 'paused' : 'not-listening');
    }
    if (!this.listening) {
      a.pause();
      return this.#report('not-listening');
    }

    const durMs = track.duration ? track.duration * 1000 : null;
    const expected = positionAt(player, serverNow(), durMs);
    if (durMs != null && expected >= durMs - 250) return this.#report('playing'); // let it finish on its own

    const now = performance.now();
    if (a.paused) {
      const blocked = a.canBeBlocked !== false && this.playRequestedAt && now - this.playRequestedAt > BLOCKED_AFTER_MS;
      if (blocked) return this.#report('blocked');
      this.#seek(a, expected, now);
      a.setRate(1);
      a.play();
      this.playRequestedAt ||= now;
      return this.#report('buffering');
    }
    this.playRequestedAt = 0;
    if (now - this.lastSeekAt < TUNING[a.kind].seekSettleMs) return this.#report('buffering');

    const diff = a.currentTime * 1000 - expected;
    if (this.leadCheck === a.kind) {
      this.leadCheck = null;
      if (Math.abs(diff) < 2000) {
        this.seekLead[a.kind] = Math.max(0, Math.min(2000, (this.seekLead[a.kind] ?? 0) - diff));
        // Still off (usually the first seek, before the delay was known): correct once now.
        if (Math.abs(diff) > 150 && !this.leadRetried) {
          this.#seek(a, expected, now, true);
          return this.#report('buffering');
        }
      }
    }
    const c = correction(diff, { ...TUNING[a.kind], supportsRate: a.supportsRate, correcting: this.correcting });
    if (c.action === 'seek') {
      this.#seek(a, expected, now);
      a.setRate(1);
      this.correcting = false;
    } else {
      a.setRate(c.rate);
      this.correcting = c.action === 'rate';
    }
    this.#report('playing', diff);
  }

  async #load(playId, track) {
    this.loading = true;
    this.error = null;
    this.correcting = false;
    this.playRequestedAt = 0;
    const next = this.#adapterFor(track);
    if (this.active && this.active !== next) this.active.pause();
    this.active = next;
    this.loadedTrack = track;
    this.#report('loading');
    try {
      await next.load(track);
    } catch (err) {
      this.error = err.message;
    } finally {
      this.loadedPlayId = playId;
      this.loading = false;
    }
    this.tick();
  }

  // Players without rate control (YouTube, SoundCloud) rebuffer on a seek and land late.
  // We measure by how much after each seek and aim that far ahead next time.
  #seek(a, expectedMs, now, retry = false) {
    const learns = !a.supportsRate && !a.ownSeekLead;
    a.seek((expectedMs + (learns ? (this.seekLead[a.kind] ?? 0) : 0)) / 1000);
    this.lastSeekAt = now;
    this.leadCheck = learns ? a.kind : null;
    this.leadRetried = retry;
  }

  #adapterFor(track) {
    if (track.kind === 'file' || track.kind === 'audio-url') return this.byKind.audio;
    return this.byKind[track.kind] ?? null;
  }

  #takenOver(reason) {
    if (!this.listening) return;
    this.listening = false;
    this.tick();
    this.callbacks.onLocalStop?.(reason);
  }

  #ended(adapter) {
    if (adapter !== this.active || !this.listening) return;
    if (this.state?.player.playId !== this.loadedPlayId) return;
    this.callbacks.onEnded?.(this.loadedPlayId);
  }

  #duration(adapter, sec) {
    const track = this.loadedTrack;
    if (adapter !== this.active || !track || track.duration != null || this.durationSentFor === track.id) return;
    this.durationSentFor = track.id;
    this.callbacks.onDuration?.(track.id, sec);
  }

  #failed(adapter, err) {
    if (adapter !== this.active) return;
    this.error = err.message;
    this.tick();
  }

  #pauseAll() {
    for (const adapter of this.adapters) adapter.pause();
  }

  #report(status, driftMs = null) {
    const rounded = driftMs == null ? null : Math.round(driftMs / 5) * 5;
    const report = { status, driftMs: rounded, error: status === 'error' ? this.error : null, kind: this.active?.kind ?? null };
    const key = JSON.stringify(report);
    if (key === this.lastReport) return;
    this.lastReport = key;
    this.callbacks.onStatus?.(report);
  }
}
