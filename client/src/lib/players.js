// One small interface over the ways a song can play: an <audio> element (uploaded
// files, direct links) and the official YouTube and SoundCloud embedded players.
// The Spotify plugin adds a Spotify player (plugin/src/spotifyPlayer.js).
// SyncEngine only talks to this interface.

export class AudioAdapter {
  kind = 'audio';
  supportsRate = true;
  onEnded = null;
  onDuration = null;
  onError = null;

  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.preservesPitch = true;
    this.el.addEventListener('ended', () => this.onEnded?.());
    this.el.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(this.el.duration)) this.onDuration?.(this.el.duration);
    });
    this.el.addEventListener('error', () => {
      if (this.loadedSrc) this.onError?.(new Error("This song can't be played on this device"));
    });
  }

  load(track) {
    const el = this.el;
    return new Promise((resolve, reject) => {
      const done = (err) => {
        el.removeEventListener('canplay', ok);
        el.removeEventListener('error', fail);
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const ok = () => done();
      const fail = () => done(new Error("This song can't be played. The link may be broken or not an audio file."));
      // Slow sources: carry on and let it buffer while playing.
      const timer = setTimeout(() => done(), 8000);
      el.addEventListener('canplay', ok);
      el.addEventListener('error', fail);
      this.loadedSrc = track.src;
      el.src = track.src;
      el.load();
    });
  }

  play() {
    this.el.play()?.catch(() => {});
  }

  pause() {
    if (!this.el.paused) this.el.pause();
  }

  seek(sec) {
    try {
      this.el.currentTime = sec;
    } catch {
      // not seekable yet
    }
  }

  get currentTime() {
    return this.el.currentTime;
  }

  get paused() {
    return this.el.paused;
  }

  setRate(rate) {
    if (this.el.playbackRate !== rate) this.el.playbackRate = rate;
  }

  setVolume(v) {
    this.el.volume = v;
  }

  /** Call from a click handler: browsers only allow sound after a user gesture. */
  unlock() {
    if (this.loadedSrc) return;
    this.el.src = silentWavUrl();
    this.el
      .play()
      ?.then(() => {
        if (!this.loadedSrc) this.el.pause();
      })
      .catch(() => {});
  }

  destroy() {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
  }
}

let silentUrl = null;
function silentWavUrl() {
  if (silentUrl) return silentUrl;
  const samples = 800;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const ascii = (offset, s) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 8000, true); // sample rate
  v.setUint32(28, 8000, true); // byte rate
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); // 8-bit
  ascii(36, 'data');
  v.setUint32(40, samples, true);
  new Uint8Array(buf, 44).fill(128); // 8-bit silence
  silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return silentUrl;
}

let youTubeApi = null;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  youTubeApi ??= new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      youTubeApi = null;
      reject(new Error("Couldn't load the YouTube player. Check your connection or ad blocker."));
    };
    document.head.append(script);
  });
  return youTubeApi;
}

const YT_ERRORS = {
  2: 'This YouTube link is invalid',
  5: "This YouTube video can't be played in the browser",
  100: 'This YouTube video was removed or is private',
  101: "The video's owner doesn't allow playing it on other sites",
  150: "The video's owner doesn't allow playing it on other sites",
};

export class YouTubeAdapter {
  kind = 'youtube';
  supportsRate = false; // YouTube only offers coarse rate steps
  onEnded = null;
  onDuration = null;
  onError = null;

  constructor(container) {
    this.container = container;
    this.player = null;
    this.ready = null;
    this.volume = 0.8;
    this.onCued = null;
  }

  #ensure() {
    this.ready ??= loadYouTubeApi().then(
      (YT) =>
        new Promise((resolve, reject) => {
          if (this.destroyed) return reject(new Error('Player closed'));
          const host = document.createElement('div');
          this.container.append(host);
          this.player = new YT.Player(host, {
            width: '100%',
            height: '100%',
            playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, fs: 0 },
            events: {
              onReady: () => {
                this.player.setVolume(Math.round(this.volume * 100));
                resolve(this.player);
              },
              onStateChange: (e) => {
                if (e.data === YT.PlayerState.CUED) this.onCued?.();
                if (e.data === YT.PlayerState.ENDED) this.onEnded?.();
                if (e.data === YT.PlayerState.PLAYING) {
                  const d = this.player.getDuration();
                  if (d > 0) this.onDuration?.(d);
                }
              },
              onError: (e) => this.onError?.(new Error(YT_ERRORS[e.data] ?? `YouTube error ${e.data}`)),
            },
          });
        }),
    );
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  // Seeking before the video is cued makes YouTube report error 2, so wait for it.
  async load(track) {
    const player = await this.#ensure();
    await new Promise((resolve) => {
      const timer = setTimeout(done, 8000);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.onCued = done;
      player.cueVideoById({ videoId: track.src, startSeconds: 0 });
    });
    this.onCued = null;
  }

  play() {
    this.player?.playVideo?.();
  }

  pause() {
    if (!this.paused) this.player?.pauseVideo?.();
  }

  seek(sec) {
    this.player?.seekTo?.(sec, true);
  }

  get currentTime() {
    return this.player?.getCurrentTime?.() ?? 0;
  }

  get paused() {
    const state = this.player?.getPlayerState?.();
    return !(state === 1 || state === 3); // PLAYING or BUFFERING
  }

  setRate() {}

  setVolume(v) {
    this.volume = v;
    this.player?.setVolume?.(Math.round(v * 100));
  }

  unlock() {}

  destroy() {
    this.destroyed = true;
    this.player?.destroy?.();
    this.player = null;
  }
}

let soundCloudApi = null;
function loadSoundCloudApi() {
  if (window.SC?.Widget) return Promise.resolve(window.SC);
  soundCloudApi ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://w.soundcloud.com/player/api.js';
    script.onload = () => resolve(window.SC);
    script.onerror = () => {
      soundCloudApi = null;
      reject(new Error("Couldn't load the SoundCloud player. Check your connection or ad blocker."));
    };
    document.head.append(script);
  });
  return soundCloudApi;
}

const SC_PLAYER_OPTIONS = { visual: true, show_comments: false, hide_related: true, show_teaser: false, buying: false, sharing: false, download: false };

/** SoundCloud's official widget. It reports its position a few times a second; between reports we extrapolate. */
export class SoundCloudAdapter {
  kind = 'soundcloud';
  supportsRate = false;
  onEnded = null;
  onDuration = null;
  onError = null;

  constructor(container) {
    this.container = container;
    this.widget = null;
    this.ready = null;
    this.volume = 0.8;
    this.position = 0;
    this.positionAt = 0;
    this.isPaused = true;
  }

  #setPosition(ms) {
    this.position = ms / 1000;
    this.positionAt = performance.now();
  }

  #create(SC, url) {
    const iframe = document.createElement('iframe');
    iframe.allow = 'autoplay; encrypted-media';
    iframe.title = 'SoundCloud player';
    const params = new URLSearchParams({ url, auto_play: 'false', ...SC_PLAYER_OPTIONS });
    iframe.src = `https://w.soundcloud.com/player/?${params}`;
    this.container.append(iframe);
    const widget = SC.Widget(iframe);
    const E = SC.Widget.Events;
    widget.bind(E.PLAY_PROGRESS, (e) => this.#setPosition(e.currentPosition));
    widget.bind(E.PLAY, () => {
      this.isPaused = false;
      this.positionAt = performance.now();
    });
    widget.bind(E.PAUSE, (e) => {
      this.isPaused = true;
      if (e?.currentPosition != null) this.#setPosition(e.currentPosition);
    });
    widget.bind(E.FINISH, () => {
      this.isPaused = true;
      this.onEnded?.();
    });
    widget.bind(E.ERROR, () => this.onError?.(new Error("This SoundCloud track can't be played. It may be private or blocked from embedding.")));
    this.widget = widget;
    return new Promise((resolve) => widget.bind(E.READY, resolve));
  }

  async load(track) {
    const SC = await loadSoundCloudApi();
    if (this.destroyed) return;
    this.isPaused = true;
    this.#setPosition(0);
    if (!this.widget) {
      this.ready = this.#create(SC, track.src);
      await this.ready;
    } else {
      await this.ready;
      await new Promise((resolve) => this.widget.load(track.src, { ...SC_PLAYER_OPTIONS, auto_play: false, callback: resolve }));
    }
    if (!this.widget) return; // closed while loading
    this.widget.setVolume(Math.round(this.volume * 100));
    this.widget.getDuration((ms) => ms > 0 && this.onDuration?.(ms / 1000));
  }

  play() {
    this.widget?.play();
  }

  pause() {
    if (!this.isPaused) this.widget?.pause();
  }

  seek(sec) {
    this.widget?.seekTo(sec * 1000);
    this.#setPosition(sec * 1000);
  }

  get currentTime() {
    return this.position + (this.isPaused ? 0 : (performance.now() - this.positionAt) / 1000);
  }

  get paused() {
    return this.isPaused;
  }

  setRate() {}

  setVolume(v) {
    this.volume = v;
    this.widget?.setVolume(Math.round(v * 100));
  }

  unlock() {}

  // Removing the iframe stops the sound. Calling the widget first would make it post
  // messages to an iframe that is about to be gone.
  destroy() {
    this.destroyed = true;
    this.widget = null;
    this.container.replaceChildren();
  }
}
