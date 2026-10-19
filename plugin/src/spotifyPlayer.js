// Plays the Jam's Spotify songs in this Spotify, through Spicetify's player API.
// Same interface as the other players (client/src/lib/players.js), plus:
// - onTakeover: the listener played or paused something in Spotify themselves,
//   which means they stopped listening along (like Spotify Jam's "paused on this device").
// - release(): stop steering Spotify; it's the listener's again.

const RETRY_MS = 3000; // Spotify can take a moment to switch songs
const SETTLE_MS = 1500; // ignore Spotify's state briefly after we command it
const NEAR_END_MS = 3000;
const END_LEAD_MS = 120; // stop just before the end so Spotify doesn't autoplay something else
const WATCH_MS = 200;
const UNAVAILABLE = "Spotify's player isn't available right now. Restart Spotify to play Spotify songs.";

// Spicetify's player can be missing if Spicetify failed to start; never throw because of it.
function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export class SpotifyPlayer {
  kind = 'spotify';
  supportsRate = false;
  canBeBlocked = false; // Spotify itself makes the sound: no autoplay policy
  ownSeekLead = true; // measures Spotify's seek delay itself (#seekTo)
  onEnded = null;
  onDuration = null;
  onError = null;
  onTakeover = null;

  #uri = null; // the Jam's current Spotify song
  #targetMs = 0;
  #playSentAt = 0;
  #started = false; // we've played something for the Jam since the listener tuned in
  #finished = false; // we stopped this song at its end; don't restart it
  #expect = null; // 'playing' | 'paused' | 'ended' | null
  #commandAt = 0;
  #loading = false;
  #lastOurs = null;
  #endTimer = null;
  #seekLead = 0; // how late Spotify applies seeks, measured
  #seekCheck = null;

  constructor() {
    this.P = window.Spicetify.Player;
    this.timer = setInterval(() => this.#watch(), WATCH_MS);
    safe(() => {
      this.P.addEventListener('songchange', () => this.#watch());
      this.P.addEventListener('onplaypause', () => this.#watch());
    });
  }

  #current() {
    return safe(() => this.P.data?.item?.uri ?? null, null);
  }

  #isPlaying() {
    return safe(() => !!this.P.isPlaying(), false);
  }

  #progress() {
    return safe(() => this.P.getProgress() || 0, 0);
  }

  #duration() {
    return safe(() => this.P.getDuration() || 0, 0);
  }

  #available() {
    return safe(() => (this.P.isPlaying(), true), false);
  }

  get #ours() {
    return !!this.#uri && this.#current() === this.#uri;
  }

  load(track) {
    this.#uri = track.src;
    this.#finished = false;
    this.#targetMs = 0;
    this.#playSentAt = 0;
    return Promise.resolve();
  }

  play() {
    const now = performance.now();
    if (this.#finished || now - this.#playSentAt < RETRY_MS) return;
    if (!this.#available()) {
      this.#playSentAt = now;
      this.onError?.(new Error(UNAVAILABLE));
      return;
    }
    this.#playSentAt = now;
    this.#started = true;
    this.#start(this.#uri, this.#targetMs);
  }

  pause() {
    if (!this.#started) return;
    this.#playSentAt = 0;
    if (this.#expect === 'playing') this.#command(this.#uri, 'paused');
    if (this.#ours && this.#isPlaying()) this.P.pause();
  }

  seek(sec) {
    this.#targetMs = sec * 1000;
    const durMs = this.#duration();
    if (this.#finished && (!durMs || this.#targetMs < durMs - 2000)) this.#finished = false; // sought back into the song
    if (this.#started && this.#ours && this.#isPlaying()) {
      this.#commandAt = Date.now();
      this.#seekTo(this.#targetMs);
    }
  }

  get currentTime() {
    return (this.#ours ? this.#progress() : this.#targetMs) / 1000;
  }

  get paused() {
    return !(this.#ours && this.#isPlaying());
  }

  setRate() {}

  // Spotify songs follow Spotify's own volume control.
  setVolume() {}

  unlock() {}

  release() {
    this.#started = false;
    this.#command(null, null);
  }

  destroy() {
    this.pause();
    this.release();
    clearInterval(this.timer);
  }

  // ---- steering Spotify

  #command(uri, expect) {
    this.#loading = false;
    this.#uri = uri ?? this.#uri;
    this.#expect = expect;
    this.#commandAt = Date.now();
    this.#lastOurs = null;
    clearTimeout(this.#endTimer);
    this.#endTimer = null;
  }

  /** Spotify applies a seek a little late; aim ahead by the delay we measured last time. */
  #seekTo(ms, retry = true) {
    const aim = Math.max(0, ms + this.#seekLead);
    this.P.seek(aim > 1 ? Math.round(aim) : 0); // values up to 1 mean a fraction of the song
    clearTimeout(this.#seekCheck);
    const at = Date.now();
    const uri = this.#current();
    this.#seekCheck = setTimeout(() => {
      if (!this.#isPlaying() || this.#current() !== uri) return;
      const behind = ms + (Date.now() - at) - this.#progress();
      if (Math.abs(behind) >= 1000) return;
      this.#seekLead = Math.max(0, Math.min(800, this.#seekLead + behind));
      // Still noticeably off (usually the first seek, before the delay was known): fix it once now.
      if (retry && Math.abs(behind) > 100) this.#seekTo(ms + (Date.now() - at), false);
    }, SETTLE_MS);
  }

  async #start(uri, positionMs) {
    const startedAt = Date.now();
    const target = () => positionMs + (Date.now() - startedAt);
    this.#command(uri, 'playing');
    // Resuming at the very end would make Spotify skip ahead before our seek lands, so restart the song instead.
    const atEnd = this.#duration() > 0 && this.#progress() >= this.#duration() - 2000;
    if (this.#current() === uri && (this.#isPlaying() || !atEnd)) {
      this.#seekTo(target());
      if (!this.#isPlaying()) this.P.play();
      return;
    }
    this.#loading = true;
    try {
      await this.P.playUri(uri);
      for (let i = 0; i < 50 && this.#current() !== uri; i++) await new Promise((r) => setTimeout(r, 100));
    } catch (err) {
      if (this.#uri === uri && this.#expect === 'playing') this.onError?.(new Error(`Spotify couldn't play this song${err?.message ? `: ${err.message}` : ''}`));
      return;
    } finally {
      if (this.#uri === uri) this.#loading = false;
    }
    if (this.#uri !== uri || this.#expect !== 'playing') return; // superseded while loading
    if (this.#current() !== uri) {
      this.onError?.(new Error("Spotify didn't start this song. It may be unavailable in your country."));
      return;
    }
    this.#seekTo(target());
    this.#commandAt = Date.now();
  }

  /** @param {boolean} anySong Spotify already moved on by itself: stop whatever it started. */
  #finish(anySong = false) {
    this.#command(this.#uri, 'ended');
    if ((anySong || this.#ours) && this.#isPlaying()) this.P.pause();
    this.#finished = true;
    this.onEnded?.();
  }

  #takeover(reason) {
    this.#started = false;
    this.#command(null, null);
    this.onTakeover?.(reason);
  }

  // Finish songs ourselves, and notice when the listener takes Spotify back.
  #watch() {
    const cur = {
      at: Date.now(),
      uri: this.#current(),
      positionMs: this.#progress() || 0,
      isPlaying: !!this.#isPlaying(),
      durationMs: this.#duration() || 0,
    };
    const ours = !!this.#uri && cur.uri === this.#uri;
    if (ours && cur.durationMs > 0) this.onDuration?.(cur.durationMs / 1000);
    if (this.#expect !== 'playing' || this.#loading) return;
    const last = this.#lastOurs;
    if (ours) this.#lastOurs = cur;
    if (ours && cur.isPlaying && cur.durationMs > 0) {
      const left = cur.durationMs - cur.positionMs;
      if (left <= END_LEAD_MS) return this.#finish();
      if (left < 1500 && !this.#endTimer) {
        this.#endTimer = setTimeout(() => {
          this.#endTimer = null;
          if (this.#expect === 'playing' && this.#ours) this.#finish();
        }, left - END_LEAD_MS);
      }
    }
    if (Date.now() - this.#commandAt < SETTLE_MS) return;
    const nearEnd = last && cur.at - last.at < 1000 && last.durationMs > 0 && last.positionMs >= last.durationMs - NEAR_END_MS;
    if (!ours) return nearEnd ? this.#finish(true) : this.#takeover('changed');
    if (!cur.isPlaying) return nearEnd ? this.#finish() : this.#takeover('paused');
  }
}
