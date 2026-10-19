// The Jam model. One room = one Spotify-style Jam session (EVIDENCE.md F1/F2)
// and one authoritative player state that every listener follows (F3).
//
// Every mutation goes through #changed(), which bumps the revision, re-arms
// the auto-advance timer and emits 'change' so sockets can broadcast.

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { positionAt } from '../shared/timing.js';

export class JamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const LIMITS = {
  name: 32,
  title: 200,
  artist: 120,
  playlistName: 60,
  tracks: 1000,
  queue: 500,
  playlists: 100,
  playlistTracks: 1000,
  removedTokens: 200,
};

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RESTART_THRESHOLD_MS = 3000; // "previous" restarts the song after this
const END_GRACE_MS = 3000; // an "ended" report this far before the end is ignored
const TIMER_SLACK_MS = 250; // let followers report "ended" first; the timer is the backstop

const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

export function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function validDuration(sec) {
  return Number.isFinite(sec) && sec > 0 && sec <= 24 * 3600 ? sec : null;
}

// Cover art is only taken from the image hosts of the sources we play.
const ART_HOSTS = [/^i\.scdn\.co$/, /\.spotifycdn\.com$/, /^i\.ytimg\.com$/, /\.sndcdn\.com$/];
// Spotify profile pictures come from Spotify's image CDN, or Facebook's for Facebook logins.
const AVATAR_HOSTS = [/^i\.scdn\.co$/, /\.spotifycdn\.com$/, /^platform-lookaside\.fbsbx\.com$/, /\.fbcdn\.net$/];
function validImage(url, hosts) {
  if (typeof url !== 'string' || url.length > 1000) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && hosts.some((re) => re.test(u.hostname)) ? u.href : null;
  } catch {
    return null;
  }
}
const validArt = (url) => validImage(url, ART_HOSTS);
const SPOTIFY_USER = /^[A-Za-z0-9._-]{1,64}$/;

/** What a member shows of themselves: their Spotify picture and profile, when they joined from Spotify. */
function profileFields({ avatar, spotifyUser } = {}) {
  return {
    avatar: validImage(avatar, AVATAR_HOSTS),
    spotifyUser: typeof spotifyUser === 'string' && SPOTIFY_USER.test(spotifyUser) ? spotifyUser : null,
  };
}

function durationMs(track) {
  return track?.duration != null ? track.duration * 1000 : null;
}

export class RoomStore extends EventEmitter {
  #rooms = new Map();
  #presence = new Map(); // code -> Map(memberId -> open socket count)
  #timers = new Map();
  #now;
  #setTimer;
  #clearTimer;

  // Wrapped: browsers (the Spotify plugin runs this) throw if timer functions are called as methods.
  constructor({ now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    super();
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  // ---- lookup -------------------------------------------------------------

  has(code) {
    return this.#rooms.has(code);
  }

  get(code) {
    const room = this.#rooms.get(String(code ?? '').toLowerCase());
    if (!room) throw new JamError('not-found', 'This Jam has ended or the link is wrong');
    return room;
  }

  /** What a visitor sees before joining ("Join Sam's Jam"). */
  peek(code) {
    const room = this.get(code);
    return { code: room.code, hostName: room.members[room.hostId]?.name ?? 'Someone', memberCount: Object.keys(room.members).length };
  }

  memberByToken(code, token) {
    const room = this.get(code);
    const member = this.#findByToken(room, token);
    if (!member) throw new JamError('forbidden', 'Join this Jam first');
    return member;
  }

  #findByToken(room, token) {
    if (typeof token !== 'string' || !token) return undefined;
    return Object.values(room.members).find((m) => m.token === token);
  }

  #member(room, memberId) {
    const member = room.members[memberId];
    if (!member) throw new JamError('forbidden', 'You are no longer in this Jam');
    return member;
  }

  #requireHost(room, memberId) {
    this.#member(room, memberId);
    if (room.hostId !== memberId) throw new JamError('host-only', 'Only the host can do this');
  }

  canControl(room, memberId) {
    return !room.settings.queueOnlyMode || room.hostId === memberId;
  }

  #requireControl(room, memberId) {
    this.#member(room, memberId);
    if (!this.canControl(room, memberId)) {
      throw new JamError('queue-only', "Only the host can control what's playing. You can still add to the queue.");
    }
  }

  // ---- session lifecycle (social-connect) ----------------------------------

  createRoom(hostName, profile = {}) {
    let code;
    do code = newCode();
    while (this.#rooms.has(code));
    const now = this.#now();
    const room = {
      code,
      createdAt: now,
      hostId: null,
      members: {},
      removedTokens: [],
      tracks: {},
      playlists: [],
      queue: [],
      player: { index: -1, playId: null, isPlaying: false, finished: false, positionAsOfTimestamp: 0, timestamp: now },
      settings: { queueOnlyMode: false },
      revision: 0,
    };
    const host = this.#addMember(room, hostName, profile);
    room.hostId = host.id;
    this.#rooms.set(code, room);
    this.#changed(room);
    return { room, member: host };
  }

  #addMember(room, name, profile) {
    const member = { id: randomId(6), token: randomId(18), name: cleanText(name, LIMITS.name) || 'Guest', joinedAt: this.#now(), ...profileFields(profile) };
    room.members[member.id] = member;
    return member;
  }

  /** Join with a stored token (rejoin as the same member) or as a new member. */
  join(code, { token, name, avatar, spotifyUser } = {}) {
    const room = this.get(code);
    if (typeof token === 'string' && room.removedTokens.includes(token)) {
      throw new JamError('removed', 'The host removed you from this Jam');
    }
    let member = this.#findByToken(room, token);
    const isNew = !member;
    if (isNew) member = this.#addMember(room, name, { avatar, spotifyUser });
    else {
      if (cleanText(name, LIMITS.name)) member.name = cleanText(name, LIMITS.name);
      if (avatar !== undefined || spotifyUser !== undefined) Object.assign(member, profileFields({ avatar, spotifyUser }));
    }
    this.#changed(room, isNew ? { type: 'joined', text: `${member.name} joined the Jam` } : null);
    return { room, member, isNew };
  }

  connect(code, memberId) {
    const room = this.get(code);
    let counts = this.#presence.get(room.code);
    if (!counts) this.#presence.set(room.code, (counts = new Map()));
    const before = counts.get(memberId) ?? 0;
    counts.set(memberId, before + 1);
    if (before === 0) this.#changed(room);
  }

  disconnect(code, memberId) {
    const counts = this.#presence.get(code);
    if (!counts?.has(memberId)) return;
    const left = counts.get(memberId) - 1;
    if (left > 0) return void counts.set(memberId, left);
    counts.delete(memberId);
    const room = this.#rooms.get(code);
    if (room) this.#changed(room);
  }

  leave(code, memberId) {
    const room = this.get(code);
    const member = this.#member(room, memberId);
    if (room.hostId === memberId) throw new JamError('host-leave', 'You are the host. End the Jam instead.');
    delete room.members[memberId];
    this.#changed(room, { type: 'left', text: `${member.name} left the Jam` });
  }

  removeMember(code, actorId, memberId) {
    const room = this.get(code);
    this.#requireHost(room, actorId);
    const member = room.members[memberId];
    if (!member) throw new JamError('not-found', 'That person already left');
    if (memberId === room.hostId) throw new JamError('host-leave', "You can't remove yourself");
    delete room.members[memberId];
    room.removedTokens = [...room.removedTokens, member.token].slice(-LIMITS.removedTokens);
    this.#changed(room, { type: 'left', text: `${member.name} was removed from the Jam` });
    this.emit('removed', { code: room.code, memberId });
  }

  endRoom(code, actorId) {
    const room = this.get(code);
    this.#requireHost(room, actorId);
    this.#clearRoomTimer(room.code);
    this.#rooms.delete(room.code);
    this.#presence.delete(room.code);
    const files = Object.values(room.tracks).filter((t) => t.file).map((t) => t.file);
    this.emit('ended', { code: room.code, by: room.members[actorId].name, files });
  }

  setQueueOnlyMode(code, actorId, enabled) {
    const room = this.get(code);
    this.#requireHost(room, actorId);
    if (room.settings.queueOnlyMode === enabled) return;
    room.settings.queueOnlyMode = enabled;
    this.#changed(room, {
      type: 'settings',
      text: enabled
        ? "Only the host can control what's playing now. Everyone can still add to the queue."
        : "Everyone can now control what's playing and add to the queue.",
    });
  }

  // ---- library -------------------------------------------------------------

  #newTrack(item, memberId) {
    return {
      id: randomId(9),
      kind: item.kind,
      src: item.src,
      file: item.file ?? null,
      title: cleanText(item.title, LIMITS.title) || 'Untitled',
      artist: cleanText(item.artist, LIMITS.artist) || null,
      duration: validDuration(item.durationSec),
      art: validArt(item.art),
      addedBy: memberId,
      addedAt: this.#now(),
    };
  }

  /** items: [{ kind, src, title, artist?, durationSec?, art?, file? }] */
  addTracks(code, memberId, items, { enqueue = false } = {}) {
    const room = this.get(code);
    const member = this.#member(room, memberId);
    if (!items.length) return [];
    if (Object.keys(room.tracks).length + items.length > LIMITS.tracks) {
      throw new JamError('limit', `A Jam can hold up to ${LIMITS.tracks} songs`);
    }
    if (enqueue && room.queue.length + items.length > LIMITS.queue) throw new JamError('limit', 'The queue is full');
    const tracks = items.map((item) => this.#newTrack(item, member.id));
    for (const track of tracks) room.tracks[track.id] = track;
    if (enqueue) this.#enqueue(room, member.id, tracks.map((t) => t.id));
    const what = tracks.length === 1 ? tracks[0].title : `${tracks.length} songs`;
    this.#changed(room, { type: 'added', text: `${member.name} added ${what}${enqueue ? ' to the queue' : ''}` });
    return tracks;
  }

  /**
   * Add many songs at once (a saved playlist, a Spotify album or playlist). Songs already in
   * the Jam are reused instead of duplicated. With playlistName the songs also become a Jam
   * playlist (replacing one with the same name); play replaces the queue and starts it
   * (at startAt, e.g. the track clicked in an album's booklet).
   */
  importTracks(code, memberId, items, { enqueue = false, playlistName = null, play = false, startAt = 0 } = {}) {
    const room = this.get(code);
    const member = this.#member(room, memberId);
    if (play) this.#requireControl(room, memberId);
    if (!items.length) throw new JamError('empty', 'Nothing to add');
    const byKey = new Map(Object.values(room.tracks).map((t) => [`${t.kind}|${t.src}`, t.id]));
    const fresh = [];
    const ids = items.map((item) => {
      const key = `${item.kind}|${item.src}`;
      if (!byKey.has(key)) {
        const track = this.#newTrack(item, member.id);
        fresh.push(track);
        byKey.set(key, track.id);
      }
      return byKey.get(key);
    });
    if (Object.keys(room.tracks).length + fresh.length > LIMITS.tracks) {
      throw new JamError('limit', `A Jam can hold up to ${LIMITS.tracks} songs`);
    }
    const queued = ids.slice(0, LIMITS.queue);
    if (enqueue && !play && room.queue.length + queued.length > LIMITS.queue) throw new JamError('limit', 'The queue is full');
    const name = cleanText(playlistName, LIMITS.playlistName);
    let playlist = name ? room.playlists.find((pl) => pl.name === name) : null;
    if (name && !playlist && room.playlists.length >= LIMITS.playlists) throw new JamError('limit', 'This Jam has too many playlists');

    for (const track of fresh) room.tracks[track.id] = track;
    if (name) {
      if (!playlist) {
        playlist = { id: randomId(6), name, trackIds: [], createdBy: memberId };
        room.playlists.push(playlist);
      }
      playlist.trackIds = ids.slice(0, LIMITS.playlistTracks);
    }
    if (play) {
      room.queue = queued.map((trackId) => ({ qid: randomId(6), trackId, addedBy: memberId }));
      const first = Math.trunc(Number(startAt));
      this.#startAt(room, first > 0 && first < room.queue.length ? first : 0);
    } else if (enqueue) {
      this.#enqueue(room, memberId, queued);
    }
    const what = name ?? (ids.length === 1 ? room.tracks[ids[0]].title : `${ids.length} songs`);
    const text = play ? `${member.name} started ${what}` : `${member.name} added ${what}${enqueue ? ' to the queue' : ''}`;
    this.#changed(room, { type: play ? 'playlist' : 'added', text });
    return { trackIds: ids, playlistId: playlist?.id ?? null };
  }

  /** Followers report a duration the server couldn't read (links, YouTube). */
  setDuration(code, memberId, trackId, seconds) {
    const room = this.get(code);
    this.#member(room, memberId);
    const track = room.tracks[trackId];
    const sec = validDuration(seconds);
    if (!track || track.duration != null || sec == null) return;
    track.duration = sec;
    this.#changed(room);
  }

  removeTrack(code, memberId, trackId) {
    const room = this.get(code);
    this.#member(room, memberId);
    const track = room.tracks[trackId];
    if (!track) return;
    if (track.addedBy !== memberId && room.hostId !== memberId) {
      throw new JamError('forbidden', 'Only the person who added this song or the host can remove it');
    }
    for (let i = room.queue.length - 1; i >= 0; i--) {
      if (room.queue[i].trackId === trackId) this.#removeQueueAt(room, i);
    }
    for (const playlist of room.playlists) playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
    delete room.tracks[trackId];
    if (track.file) this.emit('fileRemoved', track.file);
    this.#changed(room);
  }

  // ---- queue ---------------------------------------------------------------

  #enqueue(room, memberId, trackIds, at = room.queue.length) {
    if (room.queue.length + trackIds.length > LIMITS.queue) throw new JamError('limit', 'The queue is full');
    const items = trackIds.map((trackId) => {
      if (!room.tracks[trackId]) throw new JamError('not-found', 'That song is no longer in this Jam');
      return { qid: randomId(6), trackId, addedBy: memberId };
    });
    const p = room.player;
    const wasIdle = p.index === -1 || p.finished;
    room.queue.splice(at, 0, ...items);
    if (p.index >= 0 && at <= p.index) p.index += items.length;
    // Like a Jam: if nothing is playing, the first added song starts.
    if (wasIdle && items.length) this.#startAt(room, at);
  }

  queueAdd(code, memberId, trackIds) {
    const room = this.get(code);
    const member = this.#member(room, memberId);
    const ids = Array.isArray(trackIds) ? trackIds : [trackIds];
    if (!ids.length) return;
    this.#enqueue(room, memberId, ids);
    const what = ids.length === 1 ? room.tracks[ids[0]].title : `${ids.length} songs`;
    this.#changed(room, { type: 'queued', text: `${member.name} added ${what} to the queue` });
  }

  /** Insert right after the current song and start it. */
  queuePlayNow(code, memberId, trackId) {
    const room = this.get(code);
    this.#requireControl(room, memberId);
    const at = room.player.index >= 0 ? room.player.index + 1 : room.queue.length;
    this.#enqueue(room, memberId, [trackId], at);
    this.#startAt(room, at);
    this.#changed(room);
  }

  queueRemove(code, memberId, qid) {
    const room = this.get(code);
    this.#member(room, memberId);
    const idx = room.queue.findIndex((q) => q.qid === qid);
    if (idx === -1) return;
    const ownUpcoming = room.queue[idx].addedBy === memberId && idx !== room.player.index;
    if (!ownUpcoming) this.#requireControl(room, memberId);
    this.#removeQueueAt(room, idx);
    this.#changed(room);
  }

  #removeQueueAt(room, idx) {
    const p = room.player;
    room.queue.splice(idx, 1);
    if (!room.queue.length) {
      Object.assign(p, { index: -1, playId: null, isPlaying: false, finished: false, positionAsOfTimestamp: 0, timestamp: this.#now() });
    } else if (idx < p.index) {
      p.index -= 1;
    } else if (idx === p.index) {
      // The song that was playing is gone: the next one takes its place.
      if (p.index < room.queue.length) this.#startAt(room, p.index, { play: p.isPlaying && !p.finished });
      else this.#finish(room, room.queue.length - 1);
    }
  }

  /** Empty the queue. The song that's playing (or paused) stays, so the music doesn't stop. */
  queueClear(code, memberId) {
    const room = this.get(code);
    this.#requireControl(room, memberId);
    const p = room.player;
    const current = p.index >= 0 && !p.finished ? room.queue[p.index] : null;
    if (current) {
      room.queue = [current];
      p.index = 0;
    } else {
      room.queue = [];
      Object.assign(p, { index: -1, playId: null, isPlaying: false, finished: false, positionAsOfTimestamp: 0, timestamp: this.#now() });
    }
    this.#changed(room, { type: 'queue', text: `${room.members[memberId].name} cleared the queue` });
  }

  queueMove(code, memberId, qid, toIndex) {
    const room = this.get(code);
    this.#requireControl(room, memberId);
    const from = room.queue.findIndex((q) => q.qid === qid);
    if (from === -1) return;
    const to = Math.max(0, Math.min(room.queue.length - 1, Math.trunc(Number(toIndex)) || 0));
    if (from === to) return;
    const currentQid = room.queue[room.player.index]?.qid;
    const [item] = room.queue.splice(from, 1);
    room.queue.splice(to, 0, item);
    if (currentQid) room.player.index = room.queue.findIndex((q) => q.qid === currentQid);
    this.#changed(room);
  }

  // ---- player (connect-state) ----------------------------------------------

  #position(room) {
    return positionAt(room.player, this.#now(), durationMs(this.#currentTrack(room)));
  }

  #currentTrack(room) {
    const item = room.queue[room.player.index];
    return item ? room.tracks[item.trackId] : null;
  }

  #startAt(room, index, { play = true } = {}) {
    Object.assign(room.player, {
      index,
      playId: randomId(6),
      isPlaying: play,
      finished: false,
      positionAsOfTimestamp: 0,
      timestamp: this.#now(),
    });
  }

  #finish(room, index) {
    const track = room.tracks[room.queue[index]?.trackId];
    Object.assign(room.player, {
      index,
      playId: randomId(6),
      isPlaying: false,
      finished: true,
      positionAsOfTimestamp: durationMs(track) ?? 0,
      timestamp: this.#now(),
    });
  }

  #advance(room) {
    const p = room.player;
    if (p.index === -1) return;
    if (p.index + 1 < room.queue.length) this.#startAt(room, p.index + 1);
    else this.#finish(room, p.index);
  }

  play(code, memberId) {
    const room = this.get(code);
    this.#requireControl(room, memberId);
    const p = room.player;
    if (p.index === -1) {
      if (!room.queue.length) throw new JamError('empty', 'Add a song to the queue first');
      this.#startAt(room, 0);
    } else if (p.finished) {
      this.#startAt(room, p.index);
    } else if (!p.isPlaying) {
      Object.assign(p, { positionAsOfTimestamp: this.#position(room), timestamp: this.#now(), isPlaying: true });
    }
    this.#changed(room);
  }

  pause(code, memberId) {
    const room = this.get(code);
    this.#requireControl(room, memberId);
    const p = room.player;
    if (!p.isPlaying) return;
    Object.assign(p, { positionAsOfTimestamp: this.#position(room), timestamp: this.#now(), isPlaying: false });
    this.#changed(room);
  }

  seek(code, memberId, positionMs) {
    const room = this.get(code);
    this.#requireControl(room, memberId);
    const p = room.player;
    if (p.index === -1) return;
    const ms = Number(positionMs);
    if (!Number.isFinite(ms)) throw new JamError('bad-request', 'Invalid position');
    const max = durationMs(this.#currentTrack(room));
    Object.assign(p, {
      positionAsOfTimestamp: Math.max(0, max != null ? Math.min(ms, max) : ms),
      timestamp: this.#now(),
      finished: false,
    });
    this.#changed(room);
  }

  next(code, memberId) {
    const room = this.get(code);
    this.#requireControl(room, memberId);
    this.#advance(room);
    this.#changed(room);
  }

  previous(code, memberId) {
    const room = this.get(code);
    this.#requireControl(room, memberId);
    const p = room.player;
    if (p.index === -1) return;
    const restart = p.index === 0 || this.#position(room) > RESTART_THRESHOLD_MS;
    if (restart && p.finished) this.#startAt(room, p.index);
    else if (restart) Object.assign(p, { positionAsOfTimestamp: 0, timestamp: this.#now() });
    else this.#startAt(room, p.index - 1, { play: p.isPlaying || p.finished });
    this.#changed(room);
  }

  playAt(code, memberId, qid) {
    const room = this.get(code);
    this.#requireControl(room, memberId);
    const idx = room.queue.findIndex((q) => q.qid === qid);
    if (idx === -1) throw new JamError('not-found', 'That song is no longer in the queue');
    this.#startAt(room, idx);
    this.#changed(room);
  }

  /** A follower's media element finished. Stale or early reports are ignored. */
  ended(code, memberId, playId) {
    const room = this.get(code);
    this.#member(room, memberId);
    const p = room.player;
    if (!playId || p.playId !== playId || !p.isPlaying) return;
    const dur = durationMs(this.#currentTrack(room));
    if (dur != null && this.#position(room) < dur - END_GRACE_MS) return;
    this.#advance(room);
    this.#changed(room);
  }

  /** Backstop timer when nobody reports "ended" (e.g. nobody is listening). */
  autoAdvance(code, playId) {
    const room = this.#rooms.get(code);
    if (!room || room.player.playId !== playId || !room.player.isPlaying) return;
    this.#advance(room);
    this.#changed(room);
  }

  #clearRoomTimer(code) {
    const timer = this.#timers.get(code);
    if (timer) this.#clearTimer(timer);
    this.#timers.delete(code);
  }

  #schedule(room) {
    this.#clearRoomTimer(room.code);
    const p = room.player;
    const dur = durationMs(this.#currentTrack(room));
    if (!p.isPlaying || dur == null) return;
    const playId = p.playId;
    const wait = Math.max(0, dur - this.#position(room)) + TIMER_SLACK_MS;
    const timer = this.#setTimer(() => {
      this.#timers.delete(room.code);
      this.autoAdvance(room.code, playId);
    }, wait);
    timer?.unref?.();
    this.#timers.set(room.code, timer);
  }

  // ---- playlists -------------------------------------------------------------

  #playlist(room, playlistId) {
    const playlist = room.playlists.find((pl) => pl.id === playlistId);
    if (!playlist) throw new JamError('not-found', 'That playlist was deleted');
    return playlist;
  }

  createPlaylist(code, memberId, name) {
    const room = this.get(code);
    this.#member(room, memberId);
    if (room.playlists.length >= LIMITS.playlists) throw new JamError('limit', 'This Jam has too many playlists');
    const playlist = { id: randomId(6), name: cleanText(name, LIMITS.playlistName) || 'New playlist', trackIds: [], createdBy: memberId };
    room.playlists.push(playlist);
    this.#changed(room);
    return playlist;
  }

  renamePlaylist(code, memberId, playlistId, name) {
    const room = this.get(code);
    this.#member(room, memberId);
    const clean = cleanText(name, LIMITS.playlistName);
    if (!clean) return;
    this.#playlist(room, playlistId).name = clean;
    this.#changed(room);
  }

  deletePlaylist(code, memberId, playlistId) {
    const room = this.get(code);
    this.#member(room, memberId);
    const playlist = this.#playlist(room, playlistId);
    if (playlist.createdBy !== memberId && room.hostId !== memberId) {
      throw new JamError('forbidden', 'Only the person who made this playlist or the host can delete it');
    }
    room.playlists = room.playlists.filter((pl) => pl !== playlist);
    this.#changed(room);
  }

  /** Remove every song from a playlist (same rule as deleting it). */
  playlistClear(code, memberId, playlistId) {
    const room = this.get(code);
    this.#member(room, memberId);
    const playlist = this.#playlist(room, playlistId);
    if (playlist.createdBy !== memberId && room.hostId !== memberId) {
      throw new JamError('forbidden', 'Only the person who made this playlist or the host can empty it');
    }
    playlist.trackIds = [];
    this.#changed(room);
  }

  playlistAdd(code, memberId, playlistId, trackIds) {
    const room = this.get(code);
    this.#member(room, memberId);
    const playlist = this.#playlist(room, playlistId);
    const ids = (Array.isArray(trackIds) ? trackIds : [trackIds]).filter((id) => room.tracks[id]);
    if (!ids.length) throw new JamError('not-found', 'That song is no longer in this Jam');
    if (playlist.trackIds.length + ids.length > LIMITS.playlistTracks) throw new JamError('limit', 'This playlist is full');
    playlist.trackIds.push(...ids);
    this.#changed(room);
  }

  playlistRemoveAt(code, memberId, playlistId, index) {
    const room = this.get(code);
    this.#member(room, memberId);
    const playlist = this.#playlist(room, playlistId);
    const i = Math.trunc(Number(index));
    if (!(i >= 0 && i < playlist.trackIds.length)) return;
    playlist.trackIds.splice(i, 1);
    this.#changed(room);
  }

  /** Replace the queue with the playlist and start it. */
  playlistPlay(code, memberId, playlistId) {
    const room = this.get(code);
    this.#requireControl(room, memberId);
    const playlist = this.#playlist(room, playlistId);
    const ids = playlist.trackIds.filter((id) => room.tracks[id]).slice(0, LIMITS.queue);
    if (!ids.length) throw new JamError('empty', 'This playlist is empty');
    room.queue = ids.map((trackId) => ({ qid: randomId(6), trackId, addedBy: memberId }));
    this.#startAt(room, 0);
    this.#changed(room, { type: 'playlist', text: `${room.members[memberId].name} started ${playlist.name}` });
  }

  playlistEnqueue(code, memberId, playlistId) {
    const room = this.get(code);
    const member = this.#member(room, memberId);
    const playlist = this.#playlist(room, playlistId);
    const ids = playlist.trackIds.filter((id) => room.tracks[id]);
    if (!ids.length) throw new JamError('empty', 'This playlist is empty');
    this.#enqueue(room, memberId, ids);
    this.#changed(room, { type: 'queued', text: `${member.name} added ${playlist.name} to the queue` });
  }

  // ---- views & persistence --------------------------------------------------

  #changed(room, toast = null) {
    room.revision += 1;
    this.#schedule(room);
    this.emit('change', room.code, toast);
  }

  /** Room state as clients see it: no tokens, plus online presence. */
  publicState(code) {
    const room = this.get(code);
    const online = this.#presence.get(room.code);
    return {
      code: room.code,
      revision: room.revision,
      hostId: room.hostId,
      settings: { ...room.settings },
      members: Object.values(room.members).map(({ id, name, joinedAt, avatar, spotifyUser }) => ({
        id,
        name,
        joinedAt,
        avatar: avatar ?? null,
        spotifyUser: spotifyUser ?? null,
        online: (online?.get(id) ?? 0) > 0,
      })),
      tracks: Object.fromEntries(
        Object.values(room.tracks).map(({ file, ...track }) => [track.id, track]),
      ),
      playlists: room.playlists.map((pl) => ({ ...pl, trackIds: [...pl.trackIds] })),
      queue: room.queue.map((q) => ({ ...q })),
      player: { ...room.player },
      serverNow: this.#now(),
    };
  }

  toJSON() {
    return { version: 1, savedAt: this.#now(), rooms: [...this.#rooms.values()] };
  }

  /** Restore saved rooms. Anything that was playing comes back paused where it was. */
  load(data) {
    if (data?.version !== 1 || !Array.isArray(data.rooms)) return;
    const now = this.#now();
    for (const room of data.rooms) {
      if (!room?.code || !room.members?.[room.hostId]) continue;
      const p = room.player;
      if (p.isPlaying) {
        p.positionAsOfTimestamp = positionAt(p, data.savedAt ?? now, durationMs(this.#currentTrack(room)));
        p.isPlaying = false;
      }
      p.timestamp = now;
      this.#rooms.set(room.code, room);
    }
  }
}
